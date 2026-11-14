import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import Database from 'better-sqlite3';
import { DATABASE_MIGRATIONS, getSchemaVersion, migrateDatabase } from './migrations';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), 'fundiconnect-migrations-'));
  temporaryDirectories.push(directory);
  return new Database(path.join(directory, 'isolated.sqlite'));
}

function insertUser(db: Database.Database, id: string, role: string) {
  db.prepare('INSERT INTO users (id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, id, `${id}@example.test`, 'not-a-real-password-hash', role, '2026-01-01T00:00:00.000Z');
}

function insertJob(db: Database.Database, id: string, foremanId = 'foreman') {
  db.prepare(`INSERT INTO jobs
    (id,title,trade,location,foreman_id,foreman_name,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, 'Legacy job', 'Masonry', 'Nairobi', foremanId, 'Foreman', '2026-01-01T00:00:00.000Z');
}

function insertLegacyRecords(db: Database.Database) {
  for (const [id, role] of [['foreman', 'foreman'], ['worker', 'fundi'], ['admin', 'administrator']] as const) {
    insertUser(db, id, role);
  }
  insertJob(db, 'job');
  db.prepare(`INSERT INTO applications
    (id,job_id,job_title,trade,location,foreman_id,fundi_id,fundi_name,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('application', 'job', 'Legacy job', 'Masonry', 'Nairobi', 'foreman', 'worker', 'worker', 'accepted', '2026-01-02');
  db.prepare(`INSERT INTO evidence (id,user_id,title,reviewer_id,created_at)
    VALUES (?,?,?,?,?)`).run('evidence', 'worker', 'Trade certificate', 'admin', '2026-01-03');
  db.prepare(`INSERT INTO assignments
    (id,foreman_id,worker_id,worker_name,job_id,task,status,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run('assignment', 'foreman', 'worker', 'worker', 'job', 'Legacy job', 'active', '2026-01-04');
  db.prepare(`INSERT INTO attendance
    (id,assignment_id,worker_id,foreman_id,status,date,recorded_by,created_at,verification_status,verified_by,verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('attendance', 'assignment', 'worker', 'foreman', 'present', '2026-01-04', 'foreman', '2026-01-04', 'verified', 'foreman', '2026-01-04');
  db.prepare('INSERT INTO performance_reviews VALUES (?,?,?,?,?,?,?,?)')
    .run('review', 'worker', 'foreman', 'assignment', 5, 'Good work', 'published', '2026-01-05');
  db.prepare(`INSERT INTO disputes
    (id,user_id,other_party_id,foreman_id,subject,details,job_id,assignment_id,category,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('dispute', 'worker', 'foreman', 'foreman', 'Legacy issue', 'Preserve this record', 'job', 'assignment', 'attendance', 'open', '2026-01-06', '2026-01-06');
  db.prepare('INSERT INTO dispute_responses VALUES (?,?,?,?,?)')
    .run('response', 'dispute', 'foreman', 'Response', '2026-01-07');
  db.prepare(`INSERT INTO notifications (id,user_id,title,message,created_at,event_key)
    VALUES (?,?,?,?,?,?)`).run('notification', 'worker', 'Legacy notification', 'Preserve this record', '2026-01-08', 'legacy:event');
  db.prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?,?)')
    .run('audit', 'foreman', 'legacy.event', 'job', 'Preserve this record', '2026-01-09');
  db.prepare('INSERT INTO password_resets VALUES (?,?,?,?)')
    .run('reset-token-hash', 'worker', '2027-01-01', '2026-01-10');
}

test('fresh initialization tracks schema version and enforces relational and column constraints', () => {
  const database = temporaryDatabase();
  try {
    assert.equal(migrateDatabase(database), 4);
    assert.equal(getSchemaVersion(database), 4);
    assert.equal(database.pragma('user_version', { simple: true }), 4);
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { count: number }).count, 14);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'").get() as { count: number }).count, 10);

    insertUser(database, 'foreman', 'foreman');
    insertUser(database, 'worker', 'fundi');
    insertUser(database, 'admin', 'administrator');
    insertJob(database, 'job');
    insertJob(database, 'other-job');
    assert.throws(() => insertJob(database, 'orphan-job', 'missing-user'), /FOREIGN KEY constraint failed/);

    database.prepare(`INSERT INTO applications
      (id,job_id,job_title,trade,location,foreman_id,fundi_id,fundi_name,created_at)
      VALUES ('application','job','Job','Masonry','Nairobi','foreman','worker','Worker','now')`).run();
    assert.throws(() => database.prepare(`INSERT INTO applications
      (id,job_id,job_title,trade,location,foreman_id,fundi_id,fundi_name,created_at)
      VALUES ('duplicate','job','Job','Masonry','Nairobi','foreman','worker','Worker','now')`).run(), /UNIQUE constraint failed/);
    assert.throws(() => database.prepare(`INSERT INTO applications
      (id,job_id,job_title,trade,location,foreman_id,fundi_id,fundi_name,created_at)
      VALUES ('wrong-owner','job','Job','Masonry','Nairobi','worker','worker','Worker','now')`).run(), /application employer must own/);

    database.prepare(`INSERT INTO assignments
      (id,foreman_id,worker_id,worker_name,job_id,created_at)
      VALUES ('assignment','foreman','worker','Worker','job','now')`).run();
    assert.throws(() => database.prepare(`INSERT INTO assignments
      (id,foreman_id,worker_id,worker_name,job_id,created_at)
      VALUES ('duplicate-assignment','foreman','worker','Worker','job','now')`).run(), /UNIQUE constraint failed/);
    const insertDispute = database.prepare(`INSERT INTO disputes
      (id,user_id,other_party_id,foreman_id,subject,details,job_id,assignment_id,category,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insertDispute.run('dispute', 'worker', 'foreman', 'foreman', 'Issue', 'Details', 'job', 'assignment', 'general', 'open', 'now', 'now');
    assert.throws(() => insertDispute.run('wrong-party', 'admin', 'foreman', 'foreman', 'Other issue', 'Details', 'job', 'assignment', 'general', 'open', 'now', 'now'), /dispute parties and job must match/);
    assert.throws(() => insertDispute.run('wrong-job', 'worker', 'foreman', 'foreman', 'Other issue', 'Details', 'other-job', 'assignment', 'general', 'open', 'now', 'now'), /dispute parties and job must match/);
    assert.throws(() => insertDispute.run('duplicate-dispute', 'worker', 'foreman', 'foreman', 'Issue', 'Details', 'job', 'assignment', 'general', 'open', 'now', 'now'), /UNIQUE constraint failed/);

    const addAttendance = database.prepare(`INSERT INTO attendance
      (id,assignment_id,worker_id,foreman_id,status,date,recorded_by,created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    addAttendance.run('attendance', 'assignment', 'worker', 'foreman', 'present', '2026-01-01', 'foreman', 'now');
    assert.throws(() => addAttendance.run('duplicate-attendance', 'assignment', 'worker', 'foreman', 'present', '2026-01-01', 'foreman', 'now'), /UNIQUE constraint failed/);
    assert.throws(() => addAttendance.run('wrong-participant', 'assignment', 'foreman', 'foreman', 'present', '2026-01-02', 'foreman', 'now'), /attendance participants must match/);

    assert.throws(() => database.prepare('INSERT INTO performance_reviews VALUES (?,?,?,?,?,?,?,?)')
      .run('bad-rating', 'worker', 'foreman', 'assignment', 6, '', 'published', 'now'), /CHECK constraint failed/);
    assert.throws(() => database.prepare('INSERT INTO notifications (id,user_id,title,message,read,created_at,event_key) VALUES (?,?,?,?,?,?,?)')
      .run('bad-read', 'worker', 'title', 'message', 2, 'now', ''), /CHECK constraint failed/);
    database.prepare('INSERT INTO notifications (id,user_id,title,message,read,created_at,event_key) VALUES (?,?,?,?,?,?,?)')
      .run('notification', 'worker', 'title', 'message', 0, 'now', 'event');
    assert.throws(() => database.prepare('INSERT INTO notifications (id,user_id,title,message,read,created_at,event_key) VALUES (?,?,?,?,?,?,?)')
      .run('duplicate-event', 'worker', 'title', 'message', 0, 'now', 'event'), /UNIQUE constraint failed/);
    assert.throws(() => database.prepare('DELETE FROM users WHERE id=?').run('worker'), /FOREIGN KEY constraint failed/);

    const plan = database.prepare('EXPLAIN QUERY PLAN SELECT id FROM notifications WHERE user_id=? AND read=0 ORDER BY created_at DESC').all('worker') as { detail: string }[];
    assert.ok(plan.some((row) => row.detail.includes('idx_notifications_recipient_read_created')));
  } finally {
    database.close();
  }
});

test('legacy upgrades preserve records and remain repeatable', () => {
  const database = temporaryDatabase();
  try {
    DATABASE_MIGRATIONS[0].up(database);
    insertLegacyRecords(database);
    assert.equal(migrateDatabase(database), 4);
    assert.equal(migrateDatabase(database), 4);
    assert.equal(getSchemaVersion(database), 4);
    assert.equal(database.pragma('user_version', { simple: true }), 4);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 3);
    for (const table of ['jobs', 'applications', 'evidence', 'assignments', 'attendance', 'performance_reviews', 'disputes', 'dispute_responses', 'notifications', 'audit_logs', 'password_resets']) {
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count, 1, `${table} record is preserved`);
    }
    assert.equal((database.prepare('SELECT status FROM applications WHERE id=?').get('application') as { status: string }).status, 'accepted');
    assert.equal((database.prepare('SELECT details FROM audit_logs WHERE id=?').get('audit') as { details: string }).details, 'Preserve this record');
    assert.equal((database.prepare('SELECT reviewer_id FROM evidence WHERE id=?').get('evidence') as { reviewer_id: string }).reviewer_id, 'admin');
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='auth_sessions'").get() as { count: number }).count, 1);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    assert.equal((database.pragma('integrity_check') as { integrity_check: string }[])[0].integrity_check, 'ok');
  } finally {
    database.close();
  }
});

test('version 3 restores missing dispute consistency triggers on a version 2 database', () => {
  const database = temporaryDatabase();
  try {
    assert.equal(migrateDatabase(database, DATABASE_MIGRATIONS.slice(0, 2)), 2);
    database.exec(`
      DROP TRIGGER disputes_assignment_participants_insert;
      DROP TRIGGER disputes_assignment_participants_update;
    `);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'").get() as { count: number }).count, 8);

    insertUser(database, 'foreman', 'foreman');
    insertUser(database, 'worker', 'fundi');
    insertUser(database, 'admin', 'administrator');
    insertJob(database, 'job');
    database.prepare(`INSERT INTO assignments
      (id,foreman_id,worker_id,worker_name,job_id,created_at)
      VALUES ('assignment','foreman','worker','Worker','job','now')`).run();

    assert.equal(migrateDatabase(database, DATABASE_MIGRATIONS.slice(0, 3)), 3);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'").get() as { count: number }).count, 10);

    const insertDispute = database.prepare(`INSERT INTO disputes
      (id,user_id,other_party_id,subject,details,job_id,assignment_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    assert.throws(
      () => insertDispute.run('invalid-insert', 'admin', 'foreman', 'Issue', 'Details', 'job', 'assignment', 'now'),
      /dispute parties and job must match/,
    );
    insertDispute.run('valid-dispute', 'worker', 'foreman', 'Issue', 'Details', 'job', 'assignment', 'now');
    assert.throws(
      () => database.prepare('UPDATE disputes SET user_id=? WHERE id=?').run('admin', 'valid-dispute'),
      /dispute parties and job must match/,
    );
    assert.equal(getSchemaVersion(database), 3);
    assert.equal(database.pragma('user_version', { simple: true }), 3);
    assert.equal(migrateDatabase(database), 4);
    assert.equal(getSchemaVersion(database), 4);
  } finally {
    database.close();
  }
});

test('a failed migration rolls back schema changes and its version record', () => {
  const database = temporaryDatabase();
  const first: Migration = {
    version: 1,
    name: 'test-baseline',
    up(db) { db.exec('CREATE TABLE baseline_record (id TEXT PRIMARY KEY)'); },
  };
  const broken: Migration = {
    version: 2,
    name: 'test-failing-migration',
    up(db) {
      db.exec('CREATE TABLE partial_change (id TEXT PRIMARY KEY)');
      throw new Error('forced migration failure');
    },
  };
  try {
    assert.equal(migrateDatabase(database, [first]), 1);
    assert.throws(() => migrateDatabase(database, [first, broken]), /forced migration failure/);
    assert.equal(getSchemaVersion(database), 1);
    assert.equal(database.pragma('user_version', { simple: true }), 1);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='partial_change'").get(), undefined);

    const retry: Migration = {
      version: 2,
      name: 'test-failing-migration',
      up(db) { db.exec('CREATE TABLE completed_change (id TEXT PRIMARY KEY)'); },
    };
    assert.equal(migrateDatabase(database, [first, retry]), 2);
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='completed_change'").get());
  } finally {
    database.close();
  }
});

type Migration = (typeof DATABASE_MIGRATIONS)[number];
