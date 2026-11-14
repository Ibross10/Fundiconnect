import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { bootstrapAdministrator, BootstrapInputError } from './bootstrap-admin';
import { migrateDatabase } from './migrations';

function createTestDatabase(testContext: { after(callback: () => void): void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fundiconnect-admin-bootstrap-'));
  const file = path.join(directory, 'isolated.sqlite');
  assert.ok(path.resolve(file).startsWith(path.resolve(os.tmpdir())));
  const db = new Database(file);
  migrateDatabase(db);
  testContext.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test('bootstrap creates the first administrator with a bcrypt password and audit event', async (context) => {
  const db = createTestDatabase(context);
  const password = 'Correct Horse 2026! Secure';
  const schemaBefore = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  const migrationsBefore = db.prepare('SELECT version,name,applied_at FROM schema_migrations ORDER BY version').all();

  const result = await bootstrapAdministrator(db, {
    name: 'First Administrator',
    email: 'ADMIN@example.test',
    password,
  });

  assert.equal(result.role, 'administrator');
  assert.equal(result.verification_status, 'pending');
  assert.equal(result.email, 'admin@example.test');
  const stored = db.prepare('SELECT id,name,email,password_hash,role,verification_status FROM users WHERE id=?').get(result.id) as {
    id: string;
    name: string;
    email: string;
    password_hash: string;
    role: string;
    verification_status: string;
  };
  assert.notEqual(stored.password_hash, password);
  assert.equal(await bcrypt.compare(password, stored.password_hash), true);
  assert.equal(stored.role, 'administrator');
  assert.equal(stored.verification_status, 'pending');
  assert.deepEqual(db.prepare('SELECT user_id,action,target,details FROM audit_logs').get(), {
    user_id: result.id,
    action: 'account.created',
    target: result.id,
    details: 'administrator',
  });
  assert.equal('password_hash' in result, false);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.deepEqual(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all(), schemaBefore);
  assert.deepEqual(db.prepare('SELECT version,name,applied_at FROM schema_migrations ORDER BY version').all(), migrationsBefore);
});

test('bootstrap rejects invalid email and weak passwords without writing', async (context) => {
  const db = createTestDatabase(context);
  const validPassword = 'Correct Horse 2026! Secure';

  await assert.rejects(
    bootstrapAdministrator(db, { name: 'Admin', email: 'not-an-email', password: validPassword }),
    BootstrapInputError,
  );
  await assert.rejects(
    bootstrapAdministrator(db, { name: 'Admin', email: 'admin@example.test', password: 'short' }),
    BootstrapInputError,
  );
  await assert.rejects(
    bootstrapAdministrator(db, { name: 'Admin', email: 'admin@example.test', password: 'aaaaaaaaaaaa' }),
    BootstrapInputError,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get() as { count: number }).count, 0);
});

test('bootstrap refuses a second administrator and duplicate email', async (context) => {
  const db = createTestDatabase(context);
  const credentials = {
    name: 'First Administrator',
    email: 'admin@example.test',
    password: 'Correct Horse 2026! Secure',
  };
  const first = await bootstrapAdministrator(db, credentials);

  await assert.rejects(
    bootstrapAdministrator(db, { ...credentials, email: 'second-admin@example.test' }),
    /administrator already exists/,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT id FROM users WHERE email=?').get('admin@example.test') as { id: string }).id, first.id);
});

test('bootstrap refuses when an administrator already exists', async (context) => {
  const db = createTestDatabase(context);
  db.prepare(`INSERT INTO users (id,name,email,password_hash,role,created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(randomUUID(), 'Existing Administrator', 'existing@example.test', 'unused-test-hash', 'administrator', new Date().toISOString());

  await assert.rejects(
    bootstrapAdministrator(db, {
      name: 'Another Administrator',
      email: 'another@example.test',
      password: 'Correct Horse 2026! Secure',
    }),
    /administrator already exists/,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1);
});

test('bootstrap refuses an email already used by a non-administrator account', async (context) => {
  const db = createTestDatabase(context);
  db.prepare(`INSERT INTO users (id,name,email,password_hash,role,created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(randomUUID(), 'Existing Fundi', 'occupied@example.test', 'unused-test-hash', 'fundi', new Date().toISOString());

  await assert.rejects(
    bootstrapAdministrator(db, {
      name: 'New Administrator',
      email: 'occupied@example.test',
      password: 'Correct Horse 2026! Secure',
    }),
    /account with this email already exists/,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='administrator'").get() as { count: number }).count, 0);
});

test('bootstrap rolls back account creation when audit insertion fails', async (context) => {
  const db = createTestDatabase(context);
  db.exec(`CREATE TRIGGER reject_admin_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action='account.created'
    BEGIN SELECT RAISE(ABORT, 'audit failure'); END;`);
  const password = 'Correct Horse 2026! Secure';

  await assert.rejects(
    bootstrapAdministrator(db, {
      name: 'Rollback Administrator',
      email: 'rollback@example.test',
      password,
    }),
    /audit failure/,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get() as { count: number }).count, 0);
});
