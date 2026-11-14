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

function writeDatabase(callback: (database: Database.Database) => void) {
  const database = new Database(databaseFile, { fileMustExist: true });
  try {
    callback(database);
  } finally {
    database.close();
  }
}

before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(tmpdir(), 'fundiconnect-applications-'));
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
        JWT_SECRET: 'isolated-application-test-secret',
        REGISTRATION_RATE_LIMIT_MAX: '100',
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
      email: 'admin@example.test',
      password: 'AdminTestPassword123',
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

test('job and application lifecycle enforces eligibility, ownership, transitions and integrity', async () => {
  assert.ok(databaseFile.startsWith(tmpdir()), 'integration test writes only to a temporary database');
  const register = (name: string, email: string, role: string, extra: Record<string, unknown> = {}) =>
    requestJson('/api/auth/register', 'POST', {
      name, email, password: 'TestPassword123', role, ...extra,
    });
  const employer = await register('Employer One', 'employer-one@example.test', 'foreman');
  const otherEmployer = await register('Employer Two', 'employer-two@example.test', 'foreman');
  const worker = await register('Worker One', 'worker-one@example.test', 'fundi', {
    trade: 'Masonry', location: 'Nairobi', experience: 2, experienceUnit: 'years',
    skills: ['Bricklaying'], availability: 'Available',
  });
  const otherWorker = await register('Worker Two', 'worker-two@example.test', 'fundi', {
    trade: 'Masonry', location: 'Nairobi', experience: 2, experienceUnit: 'years',
    skills: ['Bricklaying'], availability: 'Available',
  });
  const ineligibleWorker = await register('Electrician', 'electrician@example.test', 'fundi', {
    trade: 'Electrical', location: 'Nairobi', experience: 3, experienceUnit: 'years',
    availability: 'Available',
  });
  const assessor = await register('Assessor', 'assessor@example.test', 'assessor');
  assert.deepEqual([employer.status, otherEmployer.status, worker.status, otherWorker.status, ineligibleWorker.status, assessor.status], [201, 201, 201, 201, 201, 400]);
  const foremanLogin = await requestJson('/api/auth/login', 'POST', {
    email: 'employer-one@example.test', password: 'TestPassword123',
  });
  const fundiLogin = await requestJson('/api/auth/login', 'POST', {
    email: 'worker-one@example.test', password: 'TestPassword123',
  });
  assert.equal(foremanLogin.status, 200);
  assert.equal(foremanLogin.body.user.role, 'foreman');
  assert.equal(fundiLogin.status, 200);
  assert.equal(fundiLogin.body.user.role, 'fundi');
  assert.equal((await requestJson('/api/auth/login', 'POST', {
    email: 'worker-one@example.test', password: 'IncorrectPassword123',
  })).status, 401);
  assert.equal((await register('Duplicate worker', 'worker-one@example.test', 'fundi', {
    trade: 'Masonry', location: 'Nairobi', experience: 2, experienceUnit: 'years',
    skills: ['Bricklaying'], availability: 'Available',
  })).status, 409);
  assert.equal((await register('Short password', 'short-password@example.test', 'foreman', {
    password: 'short',
  })).status, 400);
  const administratorRegistration = await register('Public Admin', 'public-admin@example.test', 'administrator');
  assert.equal(administratorRegistration.status, 400);
  assert.equal(JSON.stringify(administratorRegistration.body).includes('TestPassword123'), false);
  assert.equal(readDatabase((database) => (database.prepare('SELECT COUNT(*) AS count FROM users WHERE email=?').get('public-admin@example.test') as { count: number }).count), 0);

  assert.equal((await requestJson('/api/admin/overview', 'GET')).status, 401);
  assert.equal((await requestJson('/api/admin/overview', 'GET', {}, worker.body.token)).status, 403);
  assert.equal((await requestJson('/api/admin/overview?limit=1&offset=0', 'GET', {}, employer.body.token)).status, 403);
  const adminLogin = await requestJson('/api/auth/login', 'POST', {
    email: 'admin@example.test', password: 'AdminTestPassword123',
  });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.body.user.role, 'administrator');
  assert.equal(adminLogin.body.user.verification_status, 'pending');
  assert.equal('password_hash' in adminLogin.body.user, false);
  assert.equal(output.includes('AdminTestPassword123'), false);
  const adminPasswordHash = readDatabase((database) =>
    (database.prepare('SELECT password_hash FROM users WHERE email=?').get('admin@example.test') as { password_hash: string }).password_hash);
  assert.equal(output.includes(adminPasswordHash), false);
  assert.equal((await requestJson('/api/admin/overview', 'GET', {}, adminLogin.body.token)).status, 200);
  const firstAuditPage = await requestJson('/api/admin/overview?limit=1&offset=0', 'GET', {}, adminLogin.body.token);
  const secondAuditPage = await requestJson('/api/admin/overview?limit=1&offset=1', 'GET', {}, adminLogin.body.token);
  assert.equal(firstAuditPage.body.limit, 1);
  assert.equal(firstAuditPage.body.offset, 0);
  assert.ok(firstAuditPage.body.total > 1);
  assert.notEqual(firstAuditPage.body.auditLogs[0].id, secondAuditPage.body.auditLogs[0].id);
  assert.equal((await requestJson('/api/admin/overview?limit=101', 'GET', {}, adminLogin.body.token)).status, 400);
  assert.equal((await requestJson('/api/admin/assessors', 'POST', {
    name: 'Unprivileged', email: 'unprivileged@example.test', password: 'SecureInitialPassword123',
  })).status, 401);
  assert.equal((await requestJson('/api/admin/assessors', 'POST', {
    name: 'Unprivileged', email: 'unprivileged@example.test', password: 'SecureInitialPassword123',
  }, worker.body.token)).status, 403);
  assert.equal((await requestJson('/api/admin/assessors', 'POST', {
    name: 'Unprivileged', email: 'unprivileged@example.test', password: 'SecureInitialPassword123',
  }, employer.body.token)).status, 403);
  assert.equal((await requestJson('/api/admin/assessors', 'POST', {
    name: 'Invalid', email: 'invalid@example.test', password: 'short',
  }, adminLogin.body.token)).status, 400);
  const malformedProvisioningRequest = await fetch(`${baseUrl}/api/admin/assessors`, {
    method: 'POST',
    headers: { Authorization: `******`, 'Content-Type': 'application/json' },
    body: 'null',
  });
  assert.equal(malformedProvisioningRequest.status, 400);
  const provisionedAssessor = await requestJson('/api/admin/assessors', 'POST', {
    name: 'Trusted Assessor', email: 'trusted-assessor@example.test', password: 'SecureInitialPassword123',
  }, adminLogin.body.token);
  assert.equal(provisionedAssessor.status, 201);
  assert.equal(provisionedAssessor.body.assessor.role, 'assessor');
  assert.equal('password_hash' in provisionedAssessor.body.assessor, false);
  const provisionedLogin = await requestJson('/api/auth/login', 'POST', {
    email: 'trusted-assessor@example.test', password: 'SecureInitialPassword123',
  });
  assert.equal(provisionedLogin.status, 200);
  assert.equal((await requestJson('/api/fundis', 'GET', {}, provisionedLogin.body.token)).status, 200);
  const auditOverview = await requestJson('/api/admin/overview', 'GET', {}, adminLogin.body.token);
  assert.ok(auditOverview.body.auditLogs.some((log: { action: string; target: string; details: string }) =>
    log.action === 'assessor.provisioned'
      && log.target === provisionedAssessor.body.assessor.id
      && log.details === 'trusted-assessor@example.test'));
  assert.equal((await requestJson('/api/admin/assessors', 'POST', {
    name: 'Duplicate', email: 'trusted-assessor@example.test', password: 'SecureInitialPassword123',
  }, adminLogin.body.token)).status, 409);
  assert.equal((await requestJson('/api/auth/register', 'POST', {
    name: 'Invalid email', email: 'not-an-email', password: 'TestPassword123', role: 'fundi',
  })).status, 400);
  assert.equal((await requestJson('/api/auth/login', 'POST', {
    email: 'admin@example.test', password: { value: 'AdminTestPassword123' },
  })).status, 400);
  assert.equal((await requestJson('/api/me', 'PATCH', { role: 'administrator' }, worker.body.token)).status, 400);
  assert.equal((await requestJson('/api/me', 'PATCH', { phone: '0700000000' }, worker.body.token)).status, 200);
  const profileAudit = readDatabase((database) => database.prepare(`SELECT user_id,action,target,details,created_at
    FROM audit_logs WHERE action='profile.updated' AND target=? ORDER BY created_at DESC LIMIT 1`)
    .get(worker.body.user.id) as { user_id: string; action: string; target: string; details: string; created_at: string });
  assert.equal(profileAudit.user_id, worker.body.user.id);
  assert.equal(profileAudit.action, 'profile.updated');
  assert.equal(profileAudit.details, 'phone');
  assert.ok(profileAudit.created_at);
  assert.equal(profileAudit.details.includes('0700000000'), false);

  writeDatabase((database) => database.exec(`CREATE TRIGGER fail_registration_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action='account.created' BEGIN SELECT RAISE(FAIL,'forced registration audit failure'); END;`));
  const failedRegistration = await register('Rollback Account', 'rollback-account@example.test', 'fundi', {
    trade: 'Masonry', experience: 1, experienceUnit: 'years',
  });
  assert.equal(failedRegistration.status, 500);
  assert.equal(readDatabase((database) => (database.prepare('SELECT COUNT(*) AS count FROM users WHERE email=?')
    .get('rollback-account@example.test') as { count: number }).count), 0);
  assert.equal(readDatabase((database) => (database.prepare(`SELECT COUNT(*) AS count FROM auth_sessions
    WHERE user_id=(SELECT id FROM users WHERE email=?)`).get('rollback-account@example.test') as { count: number }).count), 0);
  writeDatabase((database) => database.exec('DROP TRIGGER fail_registration_audit'));

  const makeJob = (token: string, title: string, fields: Record<string, unknown> = {}) => requestJson('/api/jobs', 'POST', {
    title, trade: 'Masonry', location: 'Nairobi', requiredSkills: ['Bricklaying'], ...fields,
  }, token);
  const jobResult = await makeJob(employer.body.token, 'Masonry opportunity');
  assert.equal(jobResult.status, 201);
  const jobId = jobResult.body.job.id as string;
  const adminOverview = await requestJson('/api/admin/overview', 'GET', {}, adminLogin.body.token);
  assert.equal(adminOverview.status, 200);
  assert.equal(adminOverview.body.metrics.users.total, 7);
  assert.equal(adminOverview.body.metrics.users.byRole.fundi, 3);
  assert.equal(adminOverview.body.metrics.users.byRole.foreman, 2);
  assert.equal(adminOverview.body.metrics.users.byRole.assessor, 1);
  assert.equal(adminOverview.body.metrics.jobs.total, 1);
  assert.equal(adminOverview.body.metrics.jobs.byStatus.open, 1);
  assert.equal(adminOverview.body.metrics.applications.total, 0);
  assert.equal(adminOverview.body.metrics.assignments.total, 0);
  assert.equal(adminOverview.body.metrics.attendance.total, 0);
  assert.equal(adminOverview.body.metrics.disputes.pending, 0);
  assert.equal(JSON.stringify(adminOverview.body).includes('password_hash'), false);
  assert.equal(JSON.stringify(adminOverview.body).includes('admin@example.test'), false);
  assert.equal((await requestJson('/api/jobs', 'POST', {
    title: 'Unsupported field check', trade: 'Masonry', location: 'Nairobi', internal: 'unexpected',
  }, employer.body.token)).status, 400);
  const invalidJsonBody = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  });
  assert.equal(invalidJsonBody.status, 400);
  assert.equal(jobResult.body.job.status, 'open');
  assert.equal((await requestJson('/api/jobs', 'POST', { title: 'Blocked', trade: 'Masonry', location: 'Nairobi' }, worker.body.token)).status, 403);
  assert.equal((await requestJson(`/api/jobs/${jobId}`, 'GET', {}, worker.body.token)).status, 200);
  const employerJobs = await requestJson('/api/jobs', 'GET', {}, employer.body.token);
  assert.ok(employerJobs.body.jobs.some((job: { id: string }) => job.id === jobId));
  assert.equal((await requestJson(`/api/jobs/${jobId}/apply`, 'POST', {}, employer.body.token)).status, 403);

  const ineligible = await requestJson(`/api/jobs/${jobId}/apply`, 'POST', {}, ineligibleWorker.body.token);
  assert.equal(ineligible.status, 403);
  assert.ok(ineligible.body.unmet.includes('Trade does not match'));
  assert.equal((await requestJson('/api/jobs/nonexistent-job/apply', 'POST', {}, worker.body.token)).status, 404);

  const submitted = await requestJson(`/api/jobs/${jobId}/apply`, 'POST', { message: 'I have relevant experience.' }, worker.body.token);
  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.status, 'pending');
  const applicationId = submitted.body.id as string;
  const duplicate = await requestJson(`/api/jobs/${jobId}/apply`, 'POST', {}, worker.body.token);
  assert.equal(duplicate.status, 409);

  const otherJob = await makeJob(otherEmployer.body.token, 'Other employer job');
  assert.equal(otherJob.status, 201);
  const secondJobId = otherJob.body.job.id as string;
  assert.equal((await requestJson('/api/jobs', 'GET', {}, employer.body.token)).body.jobs.some((job: { id: string }) => job.id === secondJobId), false);
  assert.equal((await requestJson(`/api/jobs/${secondJobId}/applications`, 'GET', {}, employer.body.token)).status, 404);
  assert.equal((await requestJson(`/api/jobs/${jobId}/applications`, 'GET', {}, worker.body.token)).status, 403);
  const employerApplications = await requestJson(`/api/jobs/${jobId}/applications`, 'GET', {}, employer.body.token);
  assert.equal(employerApplications.status, 200);
  assert.equal(employerApplications.body.applications.length, 1);
  assert.equal(employerApplications.body.applications[0].applicant.name, 'Worker One');
  assert.equal('email' in employerApplications.body.applications[0].applicant, false);
  assert.equal('phone' in employerApplications.body.applications[0].applicant, false);
  assert.equal('password_hash' in employerApplications.body.applications[0].applicant, false);
  assert.equal((await requestJson('/api/my-records', 'GET', {}, otherEmployer.body.token)).body.applications.length, 0);

  assert.equal((await requestJson(`/api/applications/${applicationId}`, 'PATCH', { message: 'Not the owner' }, otherWorker.body.token)).status, 404);
  assert.equal((await requestJson(`/api/applications/${applicationId}/withdraw`, 'POST', {}, otherWorker.body.token)).status, 404);
  assert.equal((await requestJson(`/api/applications/${applicationId}/status`, 'PATCH', { status: 'accepted' }, worker.body.token)).status, 403);
  assert.equal((await requestJson(`/api/applications/${applicationId}`, 'PATCH', { status: 'accepted', message: 'forged' }, worker.body.token)).status, 400);
  assert.equal((await requestJson(`/api/applications/${applicationId}/status`, 'PATCH', { status: 'pending' }, employer.body.token)).status, 400);
  assert.equal((await requestJson(`/api/applications/${applicationId}/status`, 'PATCH', { status: 'accepted' }, otherEmployer.body.token)).status, 404);
  assert.equal((await requestJson(`/api/jobs/${jobId}`, 'PATCH', { title: 'Unauthorized edit' }, otherEmployer.body.token)).status, 404);
  assert.equal((await requestJson(`/api/jobs/${jobId}/status`, 'PATCH', { status: 'closed' }, otherEmployer.body.token)).status, 404);
  assert.equal((await requestJson(`/api/jobs/${jobId}`, 'PATCH', { title: 'Unauthorized edit' }, worker.body.token)).status, 403);

  const editedApplication = await requestJson(`/api/applications/${applicationId}`, 'PATCH', { message: 'Updated while pending.' }, worker.body.token);
  assert.equal(editedApplication.status, 200);
  assert.equal(editedApplication.body.message, 'Updated while pending.');
  const editedJob = await requestJson(`/api/jobs/${jobId}`, 'PATCH', {
    title: 'Updated masonry opportunity', trade: 'Tiling', requiredSkills: ['Bricklaying', 'Concrete work'],
  }, employer.body.token);
  assert.equal(editedJob.status, 200);
  assert.equal(editedJob.body.job.trade, 'Tiling');
  const storedBeforeDecision = await requestJson(`/api/jobs/${jobId}/applications`, 'GET', {}, employer.body.token);
  assert.equal(storedBeforeDecision.body.applications[0].job_title, 'Masonry opportunity');
  assert.equal(storedBeforeDecision.body.applications[0].trade, 'Masonry');

  const failureDb = new Database(databaseFile);
  failureDb.exec(`CREATE TRIGGER reject_accept_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action='application.accepted'
    BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END`);
  const notificationsBeforeFailure = (failureDb.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=?')
    .get(worker.body.user.id) as { count: number }).count;
  failureDb.close();
  try {
    const failedAcceptance = await requestJson(`/api/applications/${applicationId}/status`, 'PATCH', { status: 'accepted' }, employer.body.token);
    assert.equal(failedAcceptance.status, 500);
    const unchangedApplication = await requestJson(`/api/jobs/${jobId}/applications`, 'GET', {}, employer.body.token);
    assert.equal(unchangedApplication.body.applications[0].status, 'pending');
    const verificationDb = new Database(databaseFile, { readonly: true, fileMustExist: true });
    try {
      const notificationsAfterFailure = verificationDb.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=?')
        .get(worker.body.user.id) as { count: number };
      assert.equal(notificationsAfterFailure.count, notificationsBeforeFailure);
    } finally {
      verificationDb.close();
    }
  } finally {
    const cleanupDb = new Database(databaseFile);
    cleanupDb.exec('DROP TRIGGER IF EXISTS reject_accept_audit');
    cleanupDb.close();
  }

  const accepted = await requestJson(`/api/applications/${applicationId}/status`, 'PATCH', { status: 'accepted' }, employer.body.token);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, 'accepted');
  const deleteAttempt = await fetch(`${baseUrl}/api/jobs/${jobId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${employer.body.token}` },
  });
  assert.equal(deleteAttempt.status, 404);
  assert.equal((await requestJson(`/api/jobs/${jobId}`, 'GET', {}, employer.body.token)).status, 200);
  assert.equal((await requestJson(`/api/applications/${applicationId}/status`, 'PATCH', { status: 'accepted' }, employer.body.token)).status, 409);
  assert.equal((await requestJson(`/api/applications/${applicationId}/status`, 'PATCH', { status: 'rejected' }, employer.body.token)).status, 409);
  assert.equal((await requestJson(`/api/applications/${applicationId}`, 'PATCH', { message: 'Too late' }, worker.body.token)).status, 409);
  const history = await requestJson('/api/my-records', 'GET', {}, worker.body.token);
  assert.equal(history.body.applications[0].status, 'accepted');
  assert.equal(history.body.applications[0].job_title, 'Masonry opportunity');
  const applicationList = await requestJson('/api/applications', 'GET', {}, worker.body.token);
  assert.equal(applicationList.body.applications[0].status, 'accepted');
  assert.equal((await requestJson('/api/applications', 'GET', {}, employer.body.token)).status, 403);

  const workforceJob = await makeJob(employer.body.token, 'Workforce lifecycle job', { pay: 2400 });
  const workforceApplication = await requestJson(`/api/jobs/${workforceJob.body.job.id}/apply`, 'POST', {}, otherWorker.body.token);
  assert.equal(workforceApplication.status, 201);
  assert.equal((await requestJson('/api/assignments', 'POST', { applicationId: workforceApplication.body.id }, employer.body.token)).status, 409);
  assert.equal((await requestJson(`/api/assignments/${workforceApplication.body.id}`, 'GET', {}, otherWorker.body.token)).status, 404);
  assert.equal((await requestJson(`/api/jobs/${workforceJob.body.job.id}/crew`, 'GET', {}, otherEmployer.body.token)).status, 404);
  assert.equal((await requestJson(`/api/applications/${workforceApplication.body.id}/status`, 'PATCH', { status: 'accepted' }, employer.body.token)).status, 200);
  const workforceApplicationTwo = await requestJson(`/api/jobs/${workforceJob.body.job.id}/apply`, 'POST', {}, worker.body.token);
  assert.equal(workforceApplicationTwo.status, 201);
  assert.equal((await requestJson(`/api/applications/${workforceApplicationTwo.body.id}/status`, 'PATCH', { status: 'accepted' }, employer.body.token)).status, 200);

  const rollbackDb = new Database(databaseFile);
  rollbackDb.exec(`CREATE TRIGGER reject_assignment_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action='assignment.created'
    BEGIN SELECT RAISE(ABORT,'simulated assignment audit failure'); END`);
  const noticesBeforeRollback = (rollbackDb.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=?')
    .get(otherWorker.body.user.id) as { count: number }).count;
  rollbackDb.close();
  assert.equal((await requestJson('/api/assignments', 'POST', { applicationId: workforceApplication.body.id }, employer.body.token)).status, 500);
  const verifyRollbackDb = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    assert.equal((verifyRollbackDb.prepare('SELECT COUNT(*) AS count FROM assignments WHERE job_id=?')
      .get(workforceJob.body.job.id) as { count: number }).count, 0);
    assert.equal((verifyRollbackDb.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=?')
      .get(otherWorker.body.user.id) as { count: number }).count, noticesBeforeRollback);
  } finally {
    verifyRollbackDb.close();
  }
  const cleanupRollbackDb = new Database(databaseFile);
  cleanupRollbackDb.exec('DROP TRIGGER IF EXISTS reject_assignment_audit');
  cleanupRollbackDb.close();

  const assignmentRace = await Promise.all([
    requestJson('/api/assignments', 'POST', { applicationId: workforceApplication.body.id }, employer.body.token),
    requestJson('/api/assignments', 'POST', { applicationId: workforceApplication.body.id }, employer.body.token),
  ]);
  assert.deepEqual(assignmentRace.map((result) => result.status).sort(), [201, 409]);
  const assignmentResult = assignmentRace.find((result) => result.status === 201)!;
  const assignmentId = assignmentResult.body.assignment.id as string;
  assert.equal((await requestJson('/api/assignments', 'POST', { applicationId: workforceApplication.body.id }, employer.body.token)).status, 409);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}`, 'GET', {}, otherEmployer.body.token)).status, 404);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}`, 'GET', {}, otherWorker.body.token)).status, 200);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}`, 'GET', {}, worker.body.token)).status, 404);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}/progress`, 'POST', { progress: 'Employer cannot post as worker' }, employer.body.token)).status, 403);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}/status`, 'PATCH', { status: 'completed' }, employer.body.token)).status, 409);

  const roster = await requestJson(`/api/jobs/${workforceJob.body.job.id}/crew`, 'GET', {}, employer.body.token);
  assert.equal(roster.status, 200);
  assert.equal(roster.body.crew.length, 1);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}`, 'PATCH', { status: 'completed' }, employer.body.token)).status, 400);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}`, 'PATCH', {
    task: 'Updated masonry task', startDate: '2026-04-04', endDate: '2026-04-01', payment: 2800,
  }, employer.body.token)).status, 400);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}`, 'PATCH', {
    task: 'Updated masonry task', payment: 2800,
  }, employer.body.token)).status, 200);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}/progress`, 'POST', {
    progress: 'Foundation work is underway.',
  }, otherWorker.body.token)).status, 201);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}/attendance`, 'POST', {
    date: new Date().toISOString().slice(0, 10), status: 'present', verificationStatus: 'rejected',
  }, employer.body.token)).status, 400);
  const recordedAttendance = await requestJson(`/api/assignments/${assignmentId}/attendance`, 'POST', {
    date: new Date().toISOString().slice(0, 10), status: 'present',
  }, employer.body.token);
  assert.equal(recordedAttendance.status, 201);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}/attendance`, 'POST', {
    date: new Date().toISOString().slice(0, 10), status: 'late',
  }, employer.body.token)).status, 409);
  assert.equal((await requestJson(`/api/attendance/${recordedAttendance.body.id}`, 'PATCH', {
    status: 'absent', date: new Date().toISOString().slice(0, 10),
  }, otherEmployer.body.token)).status, 404);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}/status`, 'PATCH', { status: 'cancelled' }, employer.body.token)).status, 200);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}/attendance`, 'POST', {
    date: '2025-01-01', status: 'present',
  }, employer.body.token)).status, 409);
  const preservedHistory = await requestJson(`/api/assignments/${assignmentId}`, 'GET', {}, otherWorker.body.token);
  assert.equal(preservedHistory.body.assignment.status, 'cancelled');
  assert.equal(preservedHistory.body.progress.length, 1);
  assert.equal(preservedHistory.body.attendance.length, 1);
  assert.equal((await requestJson(`/api/assignments/${assignmentId}/progress`, 'POST', { progress: 'Too late' }, otherWorker.body.token)).status, 409);

  const completedAssignment = await requestJson('/api/assignments', 'POST', { applicationId: workforceApplicationTwo.body.id }, employer.body.token);
  assert.equal(completedAssignment.status, 201);
  const completedAssignmentId = completedAssignment.body.assignment.id as string;
  assert.equal((await requestJson(`/api/assignments/${completedAssignmentId}/status`, 'PATCH', { status: 'in_progress' }, employer.body.token)).status, 200);
  assert.equal((await requestJson(`/api/assignments/${completedAssignmentId}/status`, 'PATCH', { status: 'completed' }, employer.body.token)).status, 200);
  assert.equal((await requestJson(`/api/assignments/${completedAssignmentId}/attendance`, 'POST', {
    date: new Date().toISOString().slice(0, 10), status: 'present',
  }, employer.body.token)).status, 409);

  const rejectionJob = await makeJob(employer.body.token, 'Rejected application job');
  const rejectionApplication = await requestJson(`/api/jobs/${rejectionJob.body.job.id}/apply`, 'POST', {}, otherWorker.body.token);
  assert.equal(rejectionApplication.status, 201);
  const rejected = await requestJson(`/api/applications/${rejectionApplication.body.id}/status`, 'PATCH', { status: 'rejected' }, employer.body.token);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'rejected');

  const withdrawalJob = await makeJob(employer.body.token, 'Withdrawal job');
  const withdrawalApplication = await requestJson(`/api/jobs/${withdrawalJob.body.job.id}/apply`, 'POST', {}, otherWorker.body.token);
  assert.equal(withdrawalApplication.status, 201);
  const withdrawn = await requestJson(`/api/applications/${withdrawalApplication.body.id}/withdraw`, 'POST', {}, otherWorker.body.token);
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.status, 'withdrawn');
  assert.equal((await requestJson(`/api/applications/${withdrawalApplication.body.id}/withdraw`, 'POST', {}, otherWorker.body.token)).status, 409);

  const closingJob = await makeJob(employer.body.token, 'Closable job');
  const closingJobId = closingJob.body.job.id as string;
  assert.equal((await requestJson(`/api/jobs/${closingJobId}/status`, 'PATCH', { status: 'invalid' }, employer.body.token)).status, 400);
  const closed = await requestJson(`/api/jobs/${closingJobId}/status`, 'PATCH', { status: 'closed' }, employer.body.token);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'closed');
  assert.equal((await requestJson(`/api/jobs/${closingJobId}/apply`, 'POST', {}, otherWorker.body.token)).status, 404);
  assert.equal((await requestJson('/api/jobs', 'GET', {}, otherWorker.body.token)).body.jobs.some((job: { id: string }) => job.id === closingJobId), false);
  assert.equal((await requestJson('/api/jobs', 'GET', {}, employer.body.token)).body.jobs.some((job: { id: string; status: string }) => job.id === closingJobId && job.status === 'closed'), true);
  assert.equal((await requestJson(`/api/jobs/${closingJobId}/status`, 'PATCH', { status: 'closed' }, employer.body.token)).status, 409);
  const reopened = await requestJson(`/api/jobs/${closingJobId}/status`, 'PATCH', { status: 'open' }, employer.body.token);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.status, 'open');
  assert.equal((await requestJson(`/api/jobs/${closingJobId}/apply`, 'POST', {}, otherWorker.body.token)).status, 201);

  const raceJob = await makeJob(employer.body.token, 'Duplicate race job');
  const raceWorker = await register('Race Worker', 'race-worker@example.test', 'fundi', {
    trade: 'Masonry', location: 'Nairobi', experience: 2, experienceUnit: 'years',
    skills: ['Bricklaying'], availability: 'Available',
  });
  const actualRace = await Promise.all([
    requestJson(`/api/jobs/${raceJob.body.job.id}/apply`, 'POST', {}, raceWorker.body.token),
    requestJson(`/api/jobs/${raceJob.body.job.id}/apply`, 'POST', {}, raceWorker.body.token),
  ]);
  assert.deepEqual(actualRace.map((result) => result.status).sort(), [201, 409]);

  const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    const assignments = db.prepare('SELECT COUNT(*) AS count FROM assignments').get() as { count: number };
    const duplicates = db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT job_id,fundi_id FROM applications GROUP BY job_id,fundi_id HAVING COUNT(*)>1
    )`).get() as { count: number };
    const auditedChanges = db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'application.%' OR action LIKE 'job.%'").get() as { count: number };
    const storedApplication = db.prepare('SELECT status FROM applications WHERE id=?').get(applicationId) as { status: string };
    const orphanApplications = db.prepare(`SELECT COUNT(*) AS count FROM applications application
      LEFT JOIN jobs job ON job.id=application.job_id
      LEFT JOIN users worker ON worker.id=application.fundi_id
      WHERE job.id IS NULL OR worker.id IS NULL`).get() as { count: number };
    assert.equal(integrity.integrity_check, 'ok');
    assert.equal(assignments.count, 2);
    assert.equal(duplicates.count, 0);
    assert.equal(storedApplication.status, 'accepted');
    assert.equal(orphanApplications.count, 0);
    assert.ok(auditedChanges.count > 0);
  } finally {
    db.close();
  }
  const integrityDb = new Database(databaseFile, { fileMustExist: true });
  try {
    const existing = integrityDb.prepare('SELECT * FROM applications WHERE id=?').get(applicationId) as Record<string, any>;
    assert.throws(() => integrityDb.prepare(`INSERT INTO applications
      (id,job_id,job_title,trade,location,foreman_id,fundi_id,fundi_name,message,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('duplicate-application', existing.job_id, existing.job_title,
      existing.trade, existing.location, existing.foreman_id, existing.fundi_id, existing.fundi_name,
      '', 'submitted', new Date().toISOString()), /UNIQUE constraint failed/);
  } finally {
    integrityDb.close();
  }
});
