
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const projectRoot = process.cwd();
let apiProcess: ChildProcess | undefined;
let output = '';
let tempDirectory = '';
let baseUrl = '';

async function unusedPort() {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert(address && typeof address !== 'string');

  const port = address.port;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  return port;
}

async function waitForApi() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (apiProcess?.exitCode !== null && apiProcess?.exitCode !== undefined) {
      throw new Error(`Test API exited early: ${output}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await delay(50);
    }
  }

  throw new Error(`Test API did not become ready: ${output}`);
}

before(async () => {
  tempDirectory = await fs.mkdtemp(
    path.join(tmpdir(), 'fundiconnect-production-reset-'),
  );

  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    JWT_SECRET: randomBytes(48).toString('base64'),
    CLIENT_ORIGIN: 'https://fundiconnect.example.test',
    DATABASE_FILE: path.join(tempDirectory, 'test.sqlite'),
    UPLOAD_DIR: path.join(tempDirectory, 'uploads'),

    EMAIL_PROVIDER: 'gmail',
    GMAIL_USER: 'sender@example.test',
    GMAIL_APP_PASSWORD: 'abcdefghijklmnop',

    // Keep delivery disabled so automated tests never send real emails.
    PASSWORD_RESET_EMAIL_ENABLED: 'false',
  };

  const spawnedProcess = spawn(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'backend/server.ts',
    ],
    {
      cwd: projectRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  apiProcess = spawnedProcess;

  spawnedProcess.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });

  spawnedProcess.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });

  await waitForApi();
});

after(async () => {
  if (apiProcess && apiProcess.exitCode === null) {
    apiProcess.kill();

    await new Promise<void>((resolve) => {
      apiProcess!.once('exit', () => resolve());
    });
  }

  if (tempDirectory) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test('production password-reset responses and logs never expose reset tokens', async () => {
  const email = `production-reset-${randomUUID()}@example.test`;

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Production Reset Test',
      email,
      password: 'TestPassword123',
      role: 'fundi',
      experience: '1',
    }),
  });

  assert.equal(registration.status, 201);

  const response = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  // Email is intentionally disabled in this test environment.
  assert.equal(response.status, 503);

  const responseBody = await response.text();

  assert.match(
    responseBody,
    /Password reset email delivery is not configured/,
  );

  assert.doesNotMatch(responseBody, /resetToken|[a-f0-9]{64}/i);
  assert.doesNotMatch(output, /resetToken=|[a-f0-9]{64}/i);
});
