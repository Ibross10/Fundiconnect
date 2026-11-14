import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import Database from 'better-sqlite3';
import { bootstrapAdministrator } from './bootstrap-admin';

let apiProcess: ChildProcess | undefined;
let output = '';
let tempDirectory = '';
let databaseFile = '';
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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApi() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (apiProcess?.exitCode !== null && apiProcess?.exitCode !== undefined) throw new Error(`Test API exited early: ${output}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Test API did not become ready: ${output}`);
}

async function requestJson(route: string, method: string, body: Record<string, unknown> = {}, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
}

function readDatabase<T>(callback: (database: Database.Database) => T) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(tmpdir(), 'fundiconnect-disputes-'));
  databaseFile = path.join(tempDirectory, 'isolated.sqlite');
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  apiProcess = spawn(
    process.execPath,
    [path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'backend/server.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        DATABASE_FILE: databaseFile,
        UPLOAD_DIR: path.join(tempDirectory, 'uploads'),
        CLIENT_ORIGIN: 'http://localhost:5174',
        JWT_SECRET: 'isolated-dispute-test-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  apiProcess.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  apiProcess.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  await waitForApi();
  const setupDatabase = new Database(databaseFile);
  try {
    await bootstrapAdministrator(setupDatabase, {
      name: 'Test Administrator',
      email: 'admin-dispute@example.test',
      password: 'AdminPassword123',
    });
  } finally {
    setupDatabase.close();
  }
});

after(async () => {
  if (apiProcess && apiProcess.exitCode === null) {
    apiProcess.kill();
    await new Promise<void>((resolve) => apiProcess!.once('exit', () => resolve()));
  }
  if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true });
});

test('dispute workflow enforces valid assignments, access and status transitions', async () => {
  assert.ok(databaseFile.startsWith(tmpdir()), 'integration test writes only to a temporary database');
  const register = (name: string, email: string, role: string, extra: Record<string, unknown> = {}) =>
    requestJson('/api/auth/register', 'POST', {
      name, email, password: 'TestPassword123', role, ...extra,
    });

  const employer = await register('Employer A', 'dispute-employer@example.test', 'foreman');
  const worker = await register('Worker A', 'dispute-worker@example.test', 'fundi', {
    trade: 'Masonry', location: 'Nairobi', experience: 2, experienceUnit: 'years', skills: ['Bricklaying'], availability: 'Available',
  });
  const unrelated = await register('Other Worker', 'other-worker@example.test', 'fundi', {
    trade: 'Painting', location: 'Nairobi', experience: 1, experienceUnit: 'years', skills: ['Painting'], availability: 'Available',
  });
  const admin = await requestJson('/api/auth/login', 'POST', {
    email: 'admin-dispute@example.test',
    password: 'AdminPassword123',
  });
  const adminToken = admin.body.token;
  const employerToken = employer.body.token;
  const workerToken = worker.body.token;
  const unrelatedToken = unrelated.body.token;

  const job = await requestJson('/api/jobs', 'POST', {
    title: 'Shared dispute job', trade: 'Masonry', location: 'Nairobi', requiredSkills: ['Bricklaying'],
  }, employerToken);
  const jobId = job.body.job.id;

  const application = await requestJson(`/api/jobs/${jobId}/apply`, 'POST', { message: 'I can do this.' }, workerToken);
  assert.equal(application.status, 201);
  const accepted = await requestJson(`/api/applications/${application.body.id}/status`, 'PATCH', { status: 'accepted' }, employerToken);
  assert.equal(accepted.status, 200);

  const assignment = await requestJson('/api/assignments', 'POST', { applicationId: application.body.id }, employerToken);
  assert.equal(assignment.status, 201);
  const assignmentId = assignment.body.assignment.id;
  const unrelatedJob = await requestJson('/api/jobs', 'POST', {
    title: 'Unrelated job', trade: 'Masonry', location: 'Nairobi', requiredSkills: ['Bricklaying'],
  }, employerToken);
  assert.equal(unrelatedJob.status, 201);
  assert.equal((await requestJson('/api/disputes', 'POST', {
    subject: 'Mismatched relationship',
    details: 'The supplied job does not own this assignment.',
    jobId: unrelatedJob.body.job.id,
    assignmentId,
  }, workerToken)).status, 400);

  const disputeResponse = await requestJson('/api/disputes', 'POST', {
    subject: 'Late start on site',
    details: 'The assignment started late and I was not notified.',
    category: 'attendance',
    assignmentId,
  }, workerToken);
  assert.equal(disputeResponse.status, 201);
  const disputeId = disputeResponse.body.dispute.id;
  assert.equal(disputeResponse.body.dispute.status, 'open');
  assert.equal(readDatabase((database) => database.prepare('SELECT status FROM disputes WHERE id=?')
    .get(disputeId) as { status: string }).status, 'open');
  assert.equal(readDatabase((database) => database.prepare(`SELECT COUNT(*) AS count FROM audit_logs
    WHERE action='dispute.created' AND target=? AND user_id=?`).get(disputeId, worker.body.user.id) as { count: number }).count, 1);

  const invalid = await requestJson('/api/disputes', 'POST', {
    subject: 'Wrong assignment',
    details: 'This should fail.',
    category: 'general',
    assignmentId: 'missing-assignment',
  }, unrelatedToken);
  assert.equal(invalid.status, 400);

  const fetchAsOther = await requestJson(`/api/disputes/${disputeId}`, 'GET', {}, employerToken);
  assert.equal(fetchAsOther.status, 200);

  const blocked = await requestJson(`/api/disputes/${disputeId}`, 'GET', {}, unrelatedToken);
  assert.equal(blocked.status, 404);

  const response = await requestJson(`/api/disputes/${disputeId}/respond`, 'POST', { message: 'I have reviewed the schedule and will resolve it.' }, employerToken);
  assert.equal(response.status, 201);

  assert.equal((await requestJson(`/api/disputes/${disputeId}/status`, 'PATCH', {
    status: 'resolved', resolutionNote: 'Unauthorized resolution.',
  })).status, 401);
  assert.equal((await requestJson(`/api/disputes/${disputeId}/status`, 'PATCH', {
    status: 'resolved', resolutionNote: 'Unauthorized resolution.',
  }, workerToken)).status, 403);
  assert.equal((await requestJson(`/api/disputes/${disputeId}/status`, 'PATCH', {
    status: 'resolved', resolutionNote: 'Unauthorized resolution.',
  }, employerToken)).status, 403);
  assert.equal((await requestJson(`/api/disputes/${disputeId}/status`, 'PATCH', {
    status: 'not-a-status',
  }, adminToken)).status, 400);
  const adminStatus = await requestJson(`/api/disputes/${disputeId}/status`, 'PATCH', { status: 'under_review', resolutionNote: 'investigating' }, adminToken);
  assert.equal(adminStatus.status, 200);
  assert.equal(adminStatus.body.dispute.status, 'under_review');

  const invalidTransition = await requestJson(`/api/disputes/${disputeId}/status`, 'PATCH', { status: 'open' }, adminToken);
  assert.equal(invalidTransition.status, 409);

  const resolved = await requestJson(`/api/disputes/${disputeId}/status`, 'PATCH', { status: 'resolved', resolutionNote: 'The issue was resolved after rescheduling the start date.' }, adminToken);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.dispute.status, 'resolved');
  const storedDispute = readDatabase((database) => ({
    dispute: database.prepare('SELECT status,admin_id,admin_name,resolution_note FROM disputes WHERE id=?')
      .get(disputeId) as { status: string; admin_id: string; admin_name: string; resolution_note: string },
    audit: database.prepare(`SELECT user_id,action,target,details FROM audit_logs
      WHERE action='dispute.status' AND target=? ORDER BY created_at DESC LIMIT 1`)
      .get(disputeId) as { user_id: string; action: string; target: string; details: string },
  }));
  assert.equal(storedDispute.dispute.status, 'resolved');
  assert.equal(storedDispute.dispute.admin_id, admin.body.user.id);
  assert.equal(storedDispute.dispute.admin_name, 'Test Administrator');
  assert.equal(storedDispute.dispute.resolution_note, 'The issue was resolved after rescheduling the start date.');
  assert.equal(storedDispute.audit.user_id, admin.body.user.id);
  assert.equal(storedDispute.audit.action, 'dispute.status');
  assert.equal(storedDispute.audit.target, disputeId);
  assert.match(storedDispute.audit.details, /under_review -> resolved/);
  assert.match(storedDispute.audit.details, /The issue was resolved after rescheduling the start date\./);
});
