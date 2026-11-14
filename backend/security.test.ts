import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isProductionEmailConfigured, resolveClientOrigin, resolveJwtSecret, resolvePort, resolveTrustProxy } from './security';

test('JWT configuration requires a strong production secret', async (context) => {
  await context.test('example configuration contains no administrator bootstrap credentials', () => {
    const exampleEnvironment = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
    assert.doesNotMatch(exampleEnvironment, /^ADMIN_(?:NAME|EMAIL|PASSWORD)=/m);
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    assert.match(readme, /npm run admin:bootstrap/);
  });

  await context.test('production rejects missing and weak secrets', () => {
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production' }), /requires a unique JWT_SECRET/);
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'too-short' }), /requires a unique JWT_SECRET/);
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'local-development-secret-change-me' }), /requires a unique JWT_SECRET/);
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(48) }), /requires a unique JWT_SECRET/);
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'AbCdEfGhIjKlMnOp'.repeat(2) }), /requires a unique JWT_SECRET/);
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'CorrectHorseBatteryStaple2026!XyZ' }), /requires a unique JWT_SECRET/);
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'generate-a-unique-secret-of-at-least-32-random-bytes-for-production' }), /requires a unique JWT_SECRET/);
  });

  await context.test('production requires explicit secure client and runtime configuration', () => {
    assert.throws(() => resolveJwtSecret({}), /NODE_ENV must be explicitly set/);
    assert.throws(() => resolveClientOrigin({ NODE_ENV: 'production' }), /explicit HTTPS CLIENT_ORIGIN/);
    assert.throws(() => resolveClientOrigin({ NODE_ENV: 'production', CLIENT_ORIGIN: 'http://example.test' }), /HTTPS origin/);
    assert.throws(() => resolveClientOrigin({ NODE_ENV: 'production', CLIENT_ORIGIN: 'https://example.test/app' }), /HTTPS origin/);
    assert.equal(resolveClientOrigin({ NODE_ENV: 'production', CLIENT_ORIGIN: 'https://example.test' }), 'https://example.test');
    assert.equal(resolveClientOrigin({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'https://fundiconnect.onrender.com' }), 'https://fundiconnect.onrender.com');
    assert.throws(() => resolveClientOrigin({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'http://fundiconnect.onrender.com' }), /HTTPS origin/);
    assert.equal(resolveClientOrigin({ NODE_ENV: 'development' }), 'http://localhost:5174');
    assert.equal(resolvePort({ PORT: '5170' }), 5170);
    assert.throws(() => resolvePort({ PORT: '70000' }), /PORT must be/);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: '2' }), 2);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: '10.0.0.1, 127.0.0.1' }), '10.0.0.1, 127.0.0.1');
    assert.equal(resolveTrustProxy({}), false);
  });

  test('production reset email requires a tested provider configuration', () => {
    const providerConfiguration = {
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'provider-api-key',
      EMAIL_FROM: 'FundiConnect <security@example.test>',
      CLIENT_ORIGIN: 'https://fundiconnect.example.test',
    };
    assert.equal(isProductionEmailConfigured(providerConfiguration), false);
    assert.equal(isProductionEmailConfigured({ ...providerConfiguration, PASSWORD_RESET_EMAIL_ENABLED: 'true' }), true);
    assert.equal(isProductionEmailConfigured({ ...providerConfiguration, PASSWORD_RESET_EMAIL_ENABLED: 'true', CLIENT_ORIGIN: 'http://localhost:5174' }), false);
  });

  test('production entry point rejects a missing JWT secret before opening the database', () => {
    const projectRoot = process.cwd();
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fundiconnect-jwt-startup-'));
    const databaseFile = path.join(tempDirectory, 'must-not-be-created.sqlite');
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_FILE: databaseFile,
      UPLOAD_DIR: path.join(tempDirectory, 'uploads'),
    };
    delete childEnvironment.JWT_SECRET;
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'backend/start-production.ts'],
        { cwd: projectRoot, env: childEnvironment, encoding: 'utf8', timeout: 10000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /Production requires a unique JWT_SECRET/);
      assert.equal(fs.existsSync(databaseFile), false);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test('production startup rejects a missing HTTPS origin before opening the database', () => {
    const projectRoot = process.cwd();
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fundiconnect-origin-startup-'));
    const databaseFile = path.join(tempDirectory, 'must-not-be-created.sqlite');
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'development',
      JWT_SECRET: randomBytes(48).toString('base64'),
      CLIENT_ORIGIN: '',
      DATABASE_FILE: databaseFile,
      UPLOAD_DIR: path.join(tempDirectory, 'uploads'),
    };
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'backend/start-production.ts'],
        { cwd: projectRoot, env: childEnvironment, encoding: 'utf8', timeout: 10000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /explicit HTTPS CLIENT_ORIGIN/);
      assert.equal(fs.existsSync(databaseFile), false);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test('production startup requires persistent absolute data paths before opening the database', () => {
    const projectRoot = process.cwd();
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fundiconnect-storage-startup-'));
    const databaseFile = path.join(tempDirectory, 'must-not-be-created.sqlite');
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'development',
      JWT_SECRET: randomBytes(48).toString('base64'),
      CLIENT_ORIGIN: 'https://fundiconnect.example.test',
      DATABASE_FILE: 'relative.sqlite',
      UPLOAD_DIR: path.join(tempDirectory, 'uploads'),
    };
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'backend/start-production.ts'],
        { cwd: projectRoot, env: childEnvironment, encoding: 'utf8', timeout: 10000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /absolute DATABASE_FILE and UPLOAD_DIR/);
      assert.equal(fs.existsSync(databaseFile), false);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  await context.test('production accepts a high-entropy secret', () => {
    const strongSecret = randomBytes(48).toString('base64');
    assert.equal(resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: strongSecret }), strongSecret);
  });

  await context.test('local development preserves its existing fallback', () => {
    assert.equal(resolveJwtSecret({ NODE_ENV: 'development' }), 'local-development-secret-change-me');
  });
});
