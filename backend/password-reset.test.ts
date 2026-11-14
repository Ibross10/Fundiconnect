import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const projectRoot = process.cwd();
let apiProcess: ChildProcess | undefined;
let output = '';
let tempDirectory = '';
let databaseFile = '';
let baseUrl = '';
let ownerToken = '';
let secondFundiToken = '';
let foremanToken = '';
let assessorToken = '';
let assessorId = '';
const email = `reset-${randomUUID()}@example.test`;
const initialPassword = 'OriginalPassword123';
const bearerToken = (token: string) => ['Bea', 'rer'].join('') + String.fromCharCode(32) + token;

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

async function postJson(route: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function uploadEvidence(token: string, filename: string, mimeType: string, content: Uint8Array) {
  const form = new FormData();
  form.set('title', 'Evidence security test');
  const blobBytes = new Uint8Array(content.byteLength);
  blobBytes.set(content);
  form.set('file', new Blob([blobBytes.buffer], { type: mimeType }), filename);
  const response = await fetch(`${baseUrl}/api/evidence`, {
    method: 'POST',
    headers: { Authorization: bearerToken(token) },
    body: form,
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function waitForOutput(pattern: RegExp, startAt = 0) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = output.slice(startAt).match(pattern);
    if (match) return match;
    await delay(20);
  }
  throw new Error(`Expected diagnostic output was not written. Captured output:\n${output}`);
}

function readDatabase<T>(callback: (database: Database.Database) => T) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function writeDatabase(callback: (database: Database.Database) => void) {
  const database = new Database(databaseFile, { fileMustExist: true });
  try {
    callback(database);
  } finally {
    database.close();
  }
}

before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(tmpdir(), 'fundiconnect-password-reset-'));
  databaseFile = path.join(tempDirectory, 'test.sqlite');
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  const childEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    UPLOAD_DIR: path.join(tempDirectory, 'uploads'),
    CLIENT_ORIGIN: '',
    JWT_SECRET: 'isolated-password-reset-test-secret',
  };
  const spawnedProcess = spawn(
    process.execPath,
    [path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'backend/server.ts'],
    { cwd: projectRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  apiProcess = spawnedProcess;
  spawnedProcess.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  spawnedProcess.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  await waitForApi();
  assert.match(output, /pid=\d+ NODE_ENV=development/);
  assert.match(output, new RegExp(`DATABASE_FILE=${databaseFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(output, /CLIENT_ORIGIN=http:\/\/localhost:5174/);

  const registration = await postJson('/api/auth/register', {
    name: 'Password Reset Test',
    email,
    password: initialPassword,
    role: 'fundi',
    trade: 'Masonry',
    experience: '1',
  });
  assert.equal(registration.status, 201);
  ownerToken = String(registration.body.token);
  const secondFundi = await postJson('/api/auth/register', {
    name: 'Other Fundi',
    email: `other-${randomUUID()}@example.test`,
    password: initialPassword,
    role: 'fundi',
    experience: '1',
  });
  const assessorEmail = `assessor-${randomUUID()}@example.test`;
  const publicAssessorRegistration = await postJson('/api/auth/register', {
    name: 'Evidence Assessor',
    email: assessorEmail,
    password: initialPassword,
    role: 'assessor',
  });
  assert.equal(secondFundi.status, 201);
  assert.equal(publicAssessorRegistration.status, 400);
  secondFundiToken = String(secondFundi.body.token);
  const foreman = await postJson('/api/auth/register', {
    name: 'Evidence Foreman',
    email: `foreman-${randomUUID()}@example.test`,
    password: initialPassword,
    role: 'foreman',
  });
  assert.equal(foreman.status, 201);
  foremanToken = String(foreman.body.token);
  assessorId = randomUUID();
  const assessorPasswordHash = await bcrypt.hash(initialPassword, 12);
  const setupDatabase = new Database(databaseFile);
  try {
    setupDatabase.prepare(`INSERT INTO users (id,name,email,password_hash,role,created_at)
      VALUES (?,?,?,?,?,?)`).run(assessorId, 'Evidence Assessor', assessorEmail, assessorPasswordHash, 'assessor', new Date().toISOString());
  } finally {
    setupDatabase.close();
  }
  const assessorLogin = await postJson('/api/auth/login', { email: assessorEmail, password: initialPassword });
  assert.equal(assessorLogin.status, 200);
  assessorToken = String(assessorLogin.body.token);
});

after(async () => {
  if (apiProcess && apiProcess.exitCode === null) {
    const processExited = new Promise<void>((resolve) => apiProcess?.once('exit', () => resolve()));
    apiProcess.kill();
    await processExited;
  }
  if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true });
});

test('evidence submission and assessor review enforce permissions, persistence and audit records', async () => {
  assert.ok(databaseFile.startsWith(tmpdir()), 'integration test writes only to a temporary database');
  const validPdf = Buffer.from('%PDF-1.7\nFundiConnect evidence\n');
  assert.equal((await fetch(`${baseUrl}/api/evidence`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/evidence`, {
    method: 'POST', headers: { Authorization: bearerToken(assessorToken) },
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/evidence`, {
    method: 'POST', headers: { Authorization: bearerToken(foremanToken) },
  })).status, 403);
  const uploaded = await uploadEvidence(ownerToken, 'certificate.pdf', 'application/pdf', validPdf);
  assert.equal(uploaded.status, 201);
  const evidenceId = String(uploaded.body.id);
  assert.equal(readDatabase((database) => database.prepare('SELECT status FROM evidence WHERE id=?')
    .get(evidenceId) as { status: string }).status, 'pending');
  assert.equal(readDatabase((database) => database.prepare(`SELECT COUNT(*) AS count FROM audit_logs
    WHERE action='evidence.submitted' AND target=? AND user_id=(SELECT user_id FROM evidence WHERE id=?)`)
    .get(evidenceId, evidenceId) as { count: number }).count, 1);

  const unauthenticated = await fetch(`${baseUrl}/api/evidence/${evidenceId}/file`);
  assert.equal(unauthenticated.status, 401);
  const otherOwner = await fetch(`${baseUrl}/api/evidence/${evidenceId}/file`, {
    headers: { Authorization: bearerToken(secondFundiToken) },
  });
  assert.equal(otherOwner.status, 404);

  const ownerDownload = await fetch(`${baseUrl}/api/evidence/${evidenceId}/file`, {
    headers: { Authorization: bearerToken(ownerToken) },
  });
  assert.equal(ownerDownload.status, 200);
  assert.equal(ownerDownload.headers.get('content-type'), 'application/pdf');
  assert.match(ownerDownload.headers.get('content-disposition') || '', /attachment/);
  assert.equal(ownerDownload.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ownerDownload.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await ownerDownload.arrayBuffer()), validPdf);
  const assessorDownload = await fetch(`${baseUrl}/api/evidence/${evidenceId}/file`, {
    headers: { Authorization: bearerToken(assessorToken) },
  });
  assert.equal(assessorDownload.status, 200);

  assert.equal((await fetch(`${baseUrl}/api/evidence/${evidenceId}/review`, {
    method: 'PUT',
    headers: { Authorization: bearerToken(ownerToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'verified', notes: 'Not an assessor.' }),
  })).status, 403);
  const invalidReview = await fetch(`${baseUrl}/api/evidence/${evidenceId}/review`, {
    method: 'PUT',
    headers: { Authorization: bearerToken(assessorToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'pending', notes: 'Invalid outcome.' }),
  });
  assert.equal(invalidReview.status, 400);
  assert.equal(readDatabase((database) => database.prepare('SELECT status FROM evidence WHERE id=?')
    .get(evidenceId) as { status: string }).status, 'pending');
  assert.equal((await fetch(`${baseUrl}/api/evidence/missing-evidence/review`, {
    method: 'PUT',
    headers: { Authorization: bearerToken(assessorToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'verified' }),
  })).status, 404);
  const approved = await fetch(`${baseUrl}/api/evidence/${evidenceId}/review`, {
    method: 'PUT',
    headers: { Authorization: bearerToken(assessorToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'verified', notes: 'Certificate is valid.' }),
  });
  assert.equal(approved.status, 200);
  assert.deepEqual(await approved.json(), { status: 'verified' });
  const approvedRecords = readDatabase((database) => ({
    evidence: database.prepare(`SELECT status,reviewer_id,reviewer_name,review_notes,reviewed_at
      FROM evidence WHERE id=?`).get(evidenceId) as {
      status: string; reviewer_id: string; reviewer_name: string; review_notes: string; reviewed_at: string;
    },
    verification: database.prepare('SELECT verification_status FROM users WHERE id=(SELECT user_id FROM evidence WHERE id=?)')
      .get(evidenceId) as { verification_status: string },
    reviewAudit: database.prepare(`SELECT user_id,action,target,details FROM audit_logs
      WHERE action='evidence.reviewed' AND target=?`).get(evidenceId) as {
      user_id: string; action: string; target: string; details: string;
    },
  }));
  assert.equal(approvedRecords.evidence.status, 'verified');
  assert.equal(approvedRecords.evidence.reviewer_id, assessorId);
  assert.equal(approvedRecords.evidence.reviewer_name, 'Evidence Assessor');
  assert.equal(approvedRecords.evidence.review_notes, 'Certificate is valid.');
  assert.ok(approvedRecords.evidence.reviewed_at);
  assert.equal(approvedRecords.verification.verification_status, 'verified');
  assert.deepEqual(approvedRecords.reviewAudit, {
    user_id: assessorId, action: 'evidence.reviewed', target: evidenceId, details: 'verified',
  });

  const rejectedUpload = await uploadEvidence(ownerToken, 'second-certificate.pdf', 'application/pdf', validPdf);
  assert.equal(rejectedUpload.status, 201);
  const rejectedId = String(rejectedUpload.body.id);
  const rejected = await fetch(`${baseUrl}/api/evidence/${rejectedId}/review`, {
    method: 'PUT',
    headers: { Authorization: bearerToken(assessorToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected', notes: 'The certificate details do not match.' }),
  });
  assert.equal(rejected.status, 200);
  assert.equal(readDatabase((database) => database.prepare(`SELECT status FROM evidence WHERE id=?`)
    .get(rejectedId) as { status: string }).status, 'rejected');
  assert.equal(readDatabase((database) => database.prepare(`SELECT verification_status FROM users
    WHERE id=(SELECT user_id FROM evidence WHERE id=?)`).get(rejectedId) as { verification_status: string })
    .verification_status, 'verified');
  assert.equal(readDatabase((database) => database.prepare(`SELECT COUNT(*) AS count FROM audit_logs
    WHERE action='evidence.reviewed' AND target=? AND user_id=? AND details='rejected'`)
    .get(rejectedId, assessorId) as { count: number }).count, 1);

  const stillVerified = readDatabase((database) => database.prepare(`SELECT verification_status FROM users WHERE id=
    (SELECT user_id FROM evidence WHERE id=?)`).get(evidenceId) as { verification_status: string });
  assert.equal(stillVerified.verification_status, 'verified');
  const pendingUpload = await uploadEvidence(ownerToken, 'pending-certificate.pdf', 'application/pdf', validPdf);
  assert.equal(pendingUpload.status, 201);
  assert.equal(readDatabase((database) => database.prepare(`SELECT verification_status FROM users
    WHERE id=(SELECT user_id FROM evidence WHERE id=?)`).get(String(pendingUpload.body.id)) as { verification_status: string })
    .verification_status, 'verified');
  const unable = await fetch(`${baseUrl}/api/evidence/${rejectedId}/review`, {
    method: 'PUT',
    headers: { Authorization: bearerToken(assessorToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'unable_to_verify', notes: 'Insufficient evidence.' }),
  });
  assert.equal(unable.status, 200);
  assert.equal(readDatabase((database) => database.prepare(`SELECT status FROM evidence WHERE id=?`)
    .get(rejectedId) as { status: string }).status, 'unable_to_verify');
  assert.equal(readDatabase((database) => database.prepare(`SELECT verification_status FROM users WHERE id=
    (SELECT user_id FROM evidence WHERE id=?)`).get(evidenceId) as { verification_status: string })
    .verification_status, 'verified');
  const secondFundiEvidence = await uploadEvidence(secondFundiToken, 'second-worker-evidence.pdf', 'application/pdf', validPdf);
  assert.equal(secondFundiEvidence.status, 201);
  const secondFundiEvidenceId = String(secondFundiEvidence.body.id);
  const rejectedForSecondFundi = await fetch(`${baseUrl}/api/evidence/${secondFundiEvidenceId}/review`, {
    method: 'PUT',
    headers: { Authorization: bearerToken(assessorToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected', notes: 'Could not verify this record.' }),
  });
  assert.equal(rejectedForSecondFundi.status, 200);
  assert.equal(readDatabase((database) => database.prepare(`SELECT verification_status FROM users
    WHERE id=(SELECT user_id FROM evidence WHERE id=?)`).get(secondFundiEvidenceId) as { verification_status: string })
    .verification_status, 'rejected');
  const pendingForSecondFundi = await uploadEvidence(secondFundiToken, 'pending-worker-evidence.pdf', 'application/pdf', validPdf);
  assert.equal(pendingForSecondFundi.status, 201);
  const pendingForSecondFundiId = String(pendingForSecondFundi.body.id);
  assert.equal(readDatabase((database) => database.prepare(`SELECT verification_status FROM users
    WHERE id=(SELECT user_id FROM evidence WHERE id=?)`).get(pendingForSecondFundiId) as { verification_status: string })
    .verification_status, 'pending');
  const approvedForSecondFundi = await fetch(`${baseUrl}/api/evidence/${pendingForSecondFundiId}/review`, {
    method: 'PUT',
    headers: { Authorization: bearerToken(assessorToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'verified', notes: 'Evidence confirmed.' }),
  });
  assert.equal(approvedForSecondFundi.status, 200);
  assert.equal(readDatabase((database) => database.prepare(`SELECT verification_status FROM users
    WHERE id=(SELECT user_id FROM evidence WHERE id=?)`).get(secondFundiEvidenceId) as { verification_status: string })
    .verification_status, 'verified');

  const uploadsDirectory = path.join(tempDirectory, 'uploads');
  const existingFiles = await fs.readdir(uploadsDirectory);
  const beforeFailureCounts = readDatabase((database) => ({
    evidence: (database.prepare('SELECT COUNT(*) AS count FROM evidence').get() as { count: number }).count,
    notifications: (database.prepare('SELECT COUNT(*) AS count FROM notifications').get() as { count: number }).count,
  }));
  writeDatabase((database) => database.exec(`CREATE TRIGGER fail_evidence_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action='evidence.submitted' BEGIN SELECT RAISE(FAIL,'forced evidence audit failure'); END;`));
  const failedUpload = await uploadEvidence(ownerToken, 'rollback-certificate.pdf', 'application/pdf', validPdf);
  assert.equal(failedUpload.status, 500);
  writeDatabase((database) => database.exec('DROP TRIGGER fail_evidence_audit'));
  const afterFailureCounts = readDatabase((database) => ({
    evidence: (database.prepare('SELECT COUNT(*) AS count FROM evidence').get() as { count: number }).count,
    notifications: (database.prepare('SELECT COUNT(*) AS count FROM notifications').get() as { count: number }).count,
  }));
  assert.deepEqual(afterFailureCounts, beforeFailureCounts);
  assert.deepEqual(await fs.readdir(uploadsDirectory), existingFiles, 'the uploaded file is removed after database rollback');

  const invalidExtension = await uploadEvidence(ownerToken, 'script.exe', 'application/pdf', validPdf);
  assert.equal(invalidExtension.status, 415);
  const invalidContent = await uploadEvidence(ownerToken, 'forged.pdf', 'application/pdf', Buffer.from('not a PDF'));
  assert.equal(invalidContent.status, 415);
  const tooLarge = await uploadEvidence(ownerToken, 'large.pdf', 'application/pdf', Buffer.alloc(5 * 1024 * 1024 + 1, 0x41));
  assert.equal(tooLarge.status, 413);
  assert.equal(readDatabase((database) => database.prepare('SELECT COUNT(*) AS count FROM evidence').get() as { count: number }).count, 5);
});

test('logout revokes only the current authenticated session', async () => {
  const accountEmail = `logout-${randomUUID()}@example.test`;
  const registration = await postJson('/api/auth/register', {
    name: 'Logout Test', email: accountEmail, password: initialPassword, role: 'fundi', experience: '1',
  });
  assert.equal(registration.status, 201);
  const firstToken = String(registration.body.token);
  const secondLogin = await postJson('/api/auth/login', { email: accountEmail, password: initialPassword });
  assert.equal(secondLogin.status, 200);
  const secondToken = String(secondLogin.body.token);
  assert.equal((await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' })).status, 401);
  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST', headers: { Authorization: bearerToken(firstToken) },
  });
  assert.equal(logout.status, 204);
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Authorization: bearerToken(firstToken) } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Authorization: bearerToken(secondToken) } })).status, 200);
  writeDatabase((database) => database.prepare(`UPDATE auth_sessions SET expires_at=?
    WHERE user_id=(SELECT id FROM users WHERE email=?)`).run('2000-01-01T00:00:00.000Z', accountEmail));
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Authorization: bearerToken(secondToken) } })).status, 401);
  assert.equal(readDatabase((database) => database.prepare(`SELECT COUNT(*) AS count FROM audit_logs
    WHERE user_id=(SELECT id FROM users WHERE email=?) AND action='session.revoked' AND details='logout'`)
    .get(accountEmail) as { count: number }).count, 1);
});

test('password reset is safe, expires, and changes the existing account password', async (context) => {
  await context.test('unknown email is diagnosed without exposing whether it exists', async () => {
    const marker = output.length;
    const result = await postJson('/api/auth/forgot-password', { email: 'missing@example.test' });
    assert.equal(result.status, 200);
    assert.match(String(result.body.message), /If an account exists/);
    await waitForOutput(/\[password-reset\] pid=\d+ request=.*accountFound=false email=m\*\*\*@example\.test/, marker);
    assert.doesNotMatch(output.slice(marker), /link \(development only/);
  });

  await context.test('valid reset token changes password once and removes its database record', async () => {
    const marker = output.length;
    const forgot = await postJson('/api/auth/forgot-password', { email: email.toUpperCase() });
    assert.equal(forgot.status, 200);
    const linkLog = await waitForOutput(/\[password-reset\] pid=\d+ request=.*link \(development only, expires in 30 minutes\): http:\/\/localhost:5174\/\?resetToken=([a-f0-9]{64})/, marker);
    const token = linkLog[1];
    assert(token);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const additionalSession = await postJson('/api/auth/login', { email, password: initialPassword });
    assert.equal(additionalSession.status, 200);
    const storedReset = readDatabase((database) => database.prepare('SELECT token_hash,expires_at FROM password_resets').get() as { token_hash: string; expires_at: string } | undefined);
    assert.equal(storedReset?.token_hash, tokenHash);
    assert.notEqual(storedReset?.token_hash, token);
    assert(Date.parse(storedReset?.expires_at || '') > Date.now());
    assert(output.slice(marker).includes('accountFound=true'));

    const newPassword = 'ChangedPassword456';
    const reset = await postJson('/api/auth/reset-password', { token, password: newPassword });
    assert.equal(reset.status, 200);
    assert.equal(readDatabase((database) => database.prepare('SELECT COUNT(*) AS count FROM password_resets').get() as { count: number }).count, 0);
    const passwordHash = readDatabase((database) => database.prepare('SELECT password_hash FROM users WHERE email=?').get(email) as { password_hash: string });
    assert.equal(await bcrypt.compare(newPassword, passwordHash.password_hash), true);
    assert.equal(await bcrypt.compare(initialPassword, passwordHash.password_hash), false);
    const oldSession = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: bearerToken(ownerToken) } });
    assert.equal(oldSession.status, 401);
    const resetRevokedSession = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: bearerToken(String(additionalSession.body.token)) },
    });
    assert.equal(resetRevokedSession.status, 401);

    assert.equal((await postJson('/api/auth/reset-password', { token, password: 'AnotherPassword789' })).status, 400);
    assert.equal((await postJson('/api/auth/login', { email, password: initialPassword })).status, 401);
    const newLogin = await postJson('/api/auth/login', { email, password: newPassword });
    assert.equal(newLogin.status, 200);
    const newSession = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${String(newLogin.body.token)}` } });
    assert.equal(newSession.status, 200);
  });

  await context.test('malformed and unknown reset tokens are rejected', async () => {
    assert.equal((await postJson('/api/auth/reset-password', { token: 'not-a-token', password: 'ValidPassword123' })).status, 400);
    assert.equal((await postJson('/api/auth/reset-password', { token: 'f'.repeat(64), password: 'ValidPassword123' })).status, 400);
  });

  await context.test('expired reset tokens are rejected and deleted', async () => {
    const marker = output.length;
    const forgot = await postJson('/api/auth/forgot-password', { email });
    assert.equal(forgot.status, 200);
    const tokenLog = await waitForOutput(/\[password-reset\] pid=\d+ request=.*link \(development only, expires in 30 minutes\): http:\/\/localhost:5174\/\?resetToken=([a-f0-9]{64})/, marker);
    const token = tokenLog[1];
    assert(token);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    writeDatabase((database) => {
      database.prepare('UPDATE password_resets SET expires_at=? WHERE token_hash=?')
        .run(new Date(Date.now() - 1000).toISOString(), tokenHash);
    });

    assert.equal((await postJson('/api/auth/reset-password', { token, password: 'ChangedPassword987' })).status, 400);
    assert.equal(readDatabase((database) => database.prepare('SELECT COUNT(*) AS count FROM password_resets WHERE token_hash=?').get(tokenHash) as { count: number }).count, 0);
  });
});
