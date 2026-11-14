import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import Database from 'better-sqlite3';
import { convertExperience, experienceInDays, MATCH_WEIGHTS, match, validExperience } from './matching';

const qualifiedJob = {
  trade: 'Masonry', required_skills: ['Bricklaying'], location: 'Nairobi',
  min_experience: 1, min_experience_unit: 'years' as const, verification_required: 0,
};
const qualifiedFundi = {
  id: 'fundi-1', trade: 'Masonry', skills: ['Bricklaying'], location: 'Nairobi',
  experience: 1, experience_unit: 'years' as const, availability: 'Available',
  verification_status: 'verified',
};

test('matching uses the established weights and totals exactly 100 points', () => {
  assert.deepEqual(MATCH_WEIGHTS, {
    skills: 30, verification: 25, experience: 15, location: 10, availability: 10, performance: 10,
  });
  assert.equal(Object.values(MATCH_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 100);
  assert.equal(match(qualifiedJob, qualifiedFundi, 5).score, 100);
});

test('trade and required skills are eligibility criteria; skill points are proportional', () => {
  const result = match({ ...qualifiedJob, required_skills: ['Bricklaying', 'Concrete finishing'] }, {
    ...qualifiedFundi, trade: 'Electrical', skills: ['Bricklaying'],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.score, 80);
  assert.ok(result.unmet.includes('Trade does not match'));
  assert.ok(result.unmet.includes('Missing required skills: Concrete finishing'));
});

test('verification-required jobs reject unverified fundis and explain the unmet requirement', () => {
  const result = match({ ...qualifiedJob, verification_required: 1 }, {
    ...qualifiedFundi, verification_status: 'pending',
  });
  assert.equal(result.eligible, false);
  assert.ok(result.unmet.includes('Verified fundis are required'));
  assert.ok(result.unmet.includes('Skills evidence not yet verified'));
});

test('days, months and years compare on a 365-day-year and 12-month-year scale', () => {
  assert.equal(experienceInDays(45, 'days'), 45);
  assert.equal(experienceInDays(1.5, 'months'), 45.625);
  assert.equal(experienceInDays(2, 'years'), 730);
  for (const [value, unit] of [[45, 'days'], [12 / 365 * 45, 'months'], [45 / 365, 'years']] as const) {
    assert.equal(match({ ...qualifiedJob, min_experience: 45, min_experience_unit: 'days' }, {
      ...qualifiedFundi, experience: value, experience_unit: unit,
    }).eligible, true);
  }
});

test('experience validation requires bounded positive fundi durations and valid units', () => {
  assert.deepEqual(validExperience('2', undefined, false), { value: 2, unit: 'years' });
  assert.equal(validExperience(0, 'years', false), null);
  assert.equal(validExperience(100.1, 'years', false), null);
  assert.equal(validExperience(36501, 'days', false), null);
  assert.equal(validExperience(6, 'weeks', false), null);
  assert.deepEqual(validExperience(0, 'years'), { value: 0, unit: 'years' });
});

test('experience unit conversion preserves normalized duration', () => {
  assert.deepEqual(convertExperience(2, 'years', 'months'), { value: 24, unit: 'months' });
  assert.deepEqual(convertExperience(18, 'months', 'years'), { value: 1.5, unit: 'years' });
  assert.ok(Math.abs((convertExperience(30, 'days', 'months')?.value ?? 0) - 360 / 365) < 1e-12);
  assert.equal(convertExperience(2, 'weeks', 'months'), null);
});

test('legacy experience values without a unit retain their year interpretation', () => {
  assert.equal(match({ ...qualifiedJob, min_experience: 12, min_experience_unit: 'months' }, {
    ...qualifiedFundi, experience: 1, experience_unit: undefined,
  }).eligible, true);
});

test('Unavailable never receives availability points or eligibility', () => {
  const result = match(qualifiedJob, { ...qualifiedFundi, availability: 'Unavailable' }, 5);
  assert.equal(result.eligible, false);
  assert.equal(result.score, 90);
  assert.ok(result.unmet.includes('Not marked as available'));
});

test('performance contributes up to ten points and missing data is transparent', () => {
  const missing = match(qualifiedJob, qualifiedFundi);
  const reviewed = match(qualifiedJob, qualifiedFundi, 4);
  assert.equal(missing.score, 95);
  assert.equal(reviewed.score, 98);
  assert.ok(missing.reasons.includes('No published performance reviews; neutral 2.5/5 rating used (5/10 points)'));
});

test('experience unmet criteria and score boundaries remain accurate', () => {
  const belowMinimum = match({ ...qualifiedJob, min_experience: 2 }, { ...qualifiedFundi, experience: 1 }, 5);
  assert.equal(belowMinimum.score, 92.5);
  assert.equal(belowMinimum.eligible, false);
  assert.ok(belowMinimum.unmet.includes('Below required experience'));
  assert.equal(match(qualifiedJob, qualifiedFundi, 100).score, 100);
  assert.equal(match(qualifiedJob, { ...qualifiedFundi, experience: -100 }, -100).score, 75);
  assert.equal(match({ ...qualifiedJob, required_skills: ['Missing'], location: 'Mombasa' }, {
    ...qualifiedFundi, trade: 'Electrical', skills: [], experience: 0,
    availability: 'Unavailable', verification_status: 'pending', location: 'Nairobi',
  }, -100).score, 0);
});

test('malformed, extreme and invalid experience values never produce invalid scores or eligibility', () => {
  const invalidCases: Array<{ experience: number; experience_unit: string; minExperience?: number }> = [
    { experience: Infinity, experience_unit: 'years' },
    { experience: NaN, experience_unit: 'years' },
    { experience: Number.MAX_VALUE, experience_unit: 'years' },
    { experience: -1, experience_unit: 'years' },
    { experience: 0, experience_unit: 'years' },
    { experience: 2, experience_unit: 'fortnights' },
    { experience: 2, experience_unit: 'years', minExperience: Infinity },
  ];
  for (const invalid of invalidCases) {
    const { minExperience, ...fundi } = invalid;
    const result = match({
      ...qualifiedJob,
      min_experience: minExperience ?? qualifiedJob.min_experience,
    }, { ...qualifiedFundi, ...fundi } as Parameters<typeof match>[1]);
    assert.equal(Number.isFinite(result.score), true);
    assert.ok(result.score >= 0 && result.score <= 100);
    assert.equal(result.eligible, false);
  }
});

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

async function requestJson(route: string, method: string, body: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
}

before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(tmpdir(), 'fundiconnect-matching-'));
  databaseFile = path.join(tempDirectory, 'test.sqlite');
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
        JWT_SECRET: 'isolated-matching-test-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  apiProcess.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  apiProcess.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  await waitForApi();
});

after(async () => {
  if (apiProcess && apiProcess.exitCode === null) {
    apiProcess.kill();
    await new Promise<void>((resolve) => apiProcess!.once('exit', () => resolve()));
  }
  if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true });
});

test('API rejects ineligible direct applications and accepts only after all criteria pass', async () => {
  const foreman = await requestJson('/api/auth/register', 'POST', {
    name: 'Test Foreman', email: 'foreman@example.test', password: 'TestPassword123', role: 'foreman',
  });
  const fundi = await requestJson('/api/auth/register', 'POST', {
    name: 'Test Fundi', email: 'fundi@example.test', password: 'TestPassword123', role: 'fundi',
    trade: 'Masonry', location: 'Nairobi', experience: 45, experienceUnit: 'days',
    skills: 'Bricklaying', availability: 'Unavailable',
  });
  const otherFundi = await requestJson('/api/auth/register', 'POST', {
    name: 'Other Test Fundi', email: 'other-fundi@example.test', password: 'TestPassword123', role: 'fundi',
    trade: 'Masonry', location: 'Nairobi', experience: 2, experienceUnit: 'years',
  });
  const otherForeman = await requestJson('/api/auth/register', 'POST', {
    name: 'Other Test Foreman', email: 'other-foreman@example.test', password: 'TestPassword123', role: 'foreman',
  });
  assert.equal(foreman.status, 201);
  assert.equal(fundi.status, 201);
  assert.equal(otherFundi.status, 201);
  assert.equal(otherForeman.status, 201);

  const createdJob = await requestJson('/api/jobs', 'POST', {
    title: 'Test masonry job', trade: 'Masonry', location: 'Nairobi',
    minExperience: 1.5, minExperienceUnit: 'months', requiredSkills: 'Bricklaying',
    verificationRequired: true,
  }, foreman.body.token);
  assert.equal(createdJob.status, 201);

  const savedJob = createdJob.body.job;
  assert.equal(savedJob.min_experience_unit, 'months');
  assert.deepEqual(JSON.parse(savedJob.required_skills), ['Bricklaying']);

  const directAttempt = await requestJson(`/api/jobs/${createdJob.body.job.id}/apply`, 'POST', {}, fundi.body.token);
  assert.equal(directAttempt.status, 403);
  assert.ok(directAttempt.body.unmet.includes('Not marked as available'));
  assert.ok(directAttempt.body.unmet.includes('Verified fundis are required'));
  assert.ok(directAttempt.body.unmet.includes('Below required experience'));

  const recommendations = await fetch(`${baseUrl}/api/jobs/${createdJob.body.job.id}/matches`, {
    headers: { Authorization: `Bearer ${foreman.body.token}` },
  });
  const candidates = await recommendations.json() as any;
  const candidate = candidates.candidates.find((item: any) => item.fundi.id === fundi.body.user.id);
  assert.equal(candidate.eligible, false);
  assert.equal(candidate.score, 59.79);
  assert.equal('password_hash' in candidate.fundi, false);
  assert.equal('email' in candidate.fundi, false);
  assert.equal('phone' in candidate.fundi, false);
  assert.ok(candidate.unmet.includes('Not marked as available'));

  const profile = await requestJson('/api/me', 'PATCH', {
    availability: 'Available', skills: ['Bricklaying'],
  }, fundi.body.token);
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.body.profile.skills, ['Bricklaying']);
  const toMonths = await requestJson('/api/me', 'PATCH', { experienceUnit: 'months' }, fundi.body.token);
  assert.ok(Math.abs(toMonths.body.profile.experience - 45 / (365 / 12)) < 1e-12);
  assert.equal(toMonths.body.profile.experience_unit, 'months');
  const toYears = await requestJson('/api/me', 'PATCH', { experienceUnit: 'years' }, fundi.body.token);
  assert.ok(Math.abs(toYears.body.profile.experience - 45 / 365) < 1e-12);
  assert.equal(toYears.body.profile.experience_unit, 'years');
  const toRequiredDuration = await requestJson('/api/me', 'PATCH', {
    experience: 1.5, experienceUnit: 'months',
  }, fundi.body.token);
  assert.equal(toRequiredDuration.body.profile.experience, 1.5);
  assert.equal(toRequiredDuration.body.profile.experience_unit, 'months');
  const savedProfile = await requestJson('/api/me', 'GET', {}, fundi.body.token);
  assert.deepEqual(savedProfile.body.profile.skills, ['Bricklaying']);
  assert.equal(savedProfile.body.profile.experience_unit, 'months');
  const eligibilityDatabase = new Database(databaseFile);
  eligibilityDatabase.prepare("UPDATE users SET verification_status='verified' WHERE id=?").run(fundi.body.user.id);
  eligibilityDatabase.close();
  const submittedApplication = await requestJson(`/api/jobs/${createdJob.body.job.id}/apply`, 'POST', {}, fundi.body.token);
  assert.equal(submittedApplication.status, 201);
  const acceptedApplication = await requestJson(`/api/applications/${submittedApplication.body.id}/status`, 'PATCH', {
    status: 'accepted',
  }, foreman.body.token);
  assert.equal(acceptedApplication.status, 200);
  const ownedAssignment = await requestJson('/api/assignments', 'POST', {
    applicationId: submittedApplication.body.id,
  }, foreman.body.token);
  const otherForemanAssignment = await requestJson('/api/assignments', 'POST', {
    applicationId: submittedApplication.body.id,
  }, otherForeman.body.token);
  assert.equal(ownedAssignment.status, 201);
  assert.equal(otherForemanAssignment.status, 404);
  const duplicateAssignment = await requestJson('/api/assignments', 'POST', {
    applicationId: submittedApplication.body.id,
  }, foreman.body.token);
  assert.equal(duplicateAssignment.status, 409);

  const reviewWithoutWorkerAttendance = await requestJson('/api/reviews', 'POST', {
    workerId: fundi.body.user.id, assignmentId: ownedAssignment.body.id, rating: 5,
  }, foreman.body.token);
  assert.equal(reviewWithoutWorkerAttendance.status, 403);

  const selfAttendance = await requestJson(`/api/assignments/${ownedAssignment.body.id}/attendance`, 'POST', {
    status: 'present', date: new Date().toISOString().slice(0, 10),
  }, fundi.body.token);
  assert.equal(selfAttendance.status, 403);
  const forgedAttendance = await requestJson(`/api/assignments/${ownedAssignment.body.id}/attendance`, 'POST', {
    status: 'verified', date: '2099-12-31', workerId: otherFundi.body.user.id,
  }, fundi.body.token);
  assert.equal(forgedAttendance.status, 403);
  const otherWorkerAttendance = await requestJson(`/api/assignments/${ownedAssignment.body.id}/attendance`, 'POST', {
    status: 'present', date: new Date().toISOString().slice(0, 10),
  }, otherFundi.body.token);
  assert.equal(otherWorkerAttendance.status, 403);
  const unrelatedForemanAttendance = await requestJson(`/api/assignments/${ownedAssignment.body.id}/attendance`, 'POST', {
    status: 'present', date: new Date().toISOString().slice(0, 10),
  }, otherForeman.body.token);
  assert.equal(unrelatedForemanAttendance.status, 404);
  const invalidAuthoritativeStatus = await requestJson(`/api/assignments/${ownedAssignment.body.id}/attendance`, 'POST', {
    status: 'verified', date: new Date().toISOString().slice(0, 10),
  }, foreman.body.token);
  assert.equal(invalidAuthoritativeStatus.status, 400);
  const futureAttendance = await requestJson(`/api/assignments/${ownedAssignment.body.id}/attendance`, 'POST', {
    status: 'present', date: '2099-12-31',
  }, foreman.body.token);
  assert.equal(futureAttendance.status, 400);

  const database = new Database(databaseFile);
  database.prepare("UPDATE users SET verification_status='verified' WHERE id=?").run(fundi.body.user.id);
  const invalidAttendanceRows = [
    { id: 'pending-attendance', verificationStatus: 'pending', recordedBy: foreman.body.user.id, verifiedBy: null, date: '2000-01-01' },
    { id: 'rejected-attendance', verificationStatus: 'rejected', recordedBy: foreman.body.user.id, verifiedBy: foreman.body.user.id, date: '2000-01-02' },
    { id: 'self-verified-attendance', verificationStatus: 'verified', recordedBy: fundi.body.user.id, verifiedBy: fundi.body.user.id, date: '2000-01-03' },
  ];
  for (const row of invalidAttendanceRows) {
    database.prepare(`INSERT INTO attendance
      (id,assignment_id,worker_id,foreman_id,status,date,recorded_by,created_at,verification_status,verified_by,verified_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, ownedAssignment.body.id, fundi.body.user.id, foreman.body.user.id, 'present',
        row.date, row.recordedBy, new Date().toISOString(),
        row.verificationStatus, row.verifiedBy, '');
    const deniedReview = await requestJson('/api/reviews', 'POST', {
      workerId: fundi.body.user.id, assignmentId: ownedAssignment.body.id, rating: 5,
    }, foreman.body.token);
    assert.equal(deniedReview.status, 403);
  }
  database.close();

  const noReviewRecommendations = await fetch(`${baseUrl}/api/jobs/${createdJob.body.job.id}/matches`, {
    headers: { Authorization: `Bearer ${foreman.body.token}` },
  });
  const noReviewCandidates = await noReviewRecommendations.json() as any;
  const noReviewCandidate = noReviewCandidates.candidates.find((item: any) => item.fundi.id === fundi.body.user.id);
  assert.equal(noReviewCandidate.score, 95);
  assert.ok(noReviewCandidate.reasons.includes('No published performance reviews; neutral 2.5/5 rating used (5/10 points)'));

  const foremanAttendance = await requestJson(`/api/assignments/${ownedAssignment.body.id}/attendance`, 'POST', {
    status: 'present', date: new Date().toISOString().slice(0, 10),
  }, foreman.body.token);
  assert.equal(foremanAttendance.status, 201);
  assert.equal(foremanAttendance.body.verificationStatus, 'verified');
  const attendanceDatabase = new Database(databaseFile);
  const savedAttendance = attendanceDatabase.prepare('SELECT * FROM attendance WHERE id=?')
    .get(foremanAttendance.body.id) as any;
  assert.equal(savedAttendance.worker_id, fundi.body.user.id);
  assert.equal(savedAttendance.foreman_id, foreman.body.user.id);
  assert.equal(savedAttendance.recorded_by, foreman.body.user.id);
  assert.equal(savedAttendance.verification_status, 'verified');
  assert.equal(savedAttendance.verified_by, foreman.body.user.id);
  attendanceDatabase.close();

  const foremanAttendanceUpdate = await requestJson(`/api/attendance/${foremanAttendance.body.id}`, 'PATCH', {
    status: 'late', date: new Date().toISOString().slice(0, 10),
  }, foreman.body.token);
  assert.equal(foremanAttendanceUpdate.status, 200);
  assert.equal(foremanAttendanceUpdate.body.verificationStatus, 'verified');

  const fundiAttendanceUpdate = await requestJson(`/api/attendance/${foremanAttendance.body.id}`, 'PATCH', {
    status: 'absent', date: '2099-12-31',
  }, fundi.body.token);
  assert.equal(fundiAttendanceUpdate.status, 403);
  const unrelatedAttendanceUpdate = await requestJson(`/api/attendance/${foremanAttendance.body.id}`, 'PATCH', {
    status: 'absent',
  }, otherForeman.body.token);
  assert.equal(unrelatedAttendanceUpdate.status, 404);
  const otherWorkerAttendanceUpdate = await requestJson(`/api/attendance/${foremanAttendance.body.id}`, 'PATCH', {
    status: 'absent',
  }, otherFundi.body.token);
  assert.equal(otherWorkerAttendanceUpdate.status, 403);

  const unauthorizedReview = await requestJson('/api/reviews', 'POST', {
    workerId: fundi.body.user.id, assignmentId: 'missing-assignment', rating: 5,
  }, foreman.body.token);
  assert.equal(unauthorizedReview.status, 403);
  const unrelatedWorkerReview = await requestJson('/api/reviews', 'POST', {
    workerId: otherFundi.body.user.id, assignmentId: ownedAssignment.body.id, rating: 5,
  }, foreman.body.token);
  assert.equal(unrelatedWorkerReview.status, 403);
  const missingAssignmentReview = await requestJson('/api/reviews', 'POST', {
    workerId: fundi.body.user.id, assignmentId: 'missing-assignment', rating: 5,
  }, foreman.body.token);
  assert.equal(missingAssignmentReview.status, 403);

  const validReview1 = await requestJson('/api/reviews', 'POST', {
    workerId: fundi.body.user.id, assignmentId: ownedAssignment.body.id, rating: 4,
  }, foreman.body.token);
  const validReview2 = await requestJson('/api/reviews', 'POST', {
    workerId: fundi.body.user.id, assignmentId: ownedAssignment.body.id, rating: 2,
  }, foreman.body.token);
  assert.equal(validReview1.status, 201);
  assert.equal(validReview2.status, 409);

  const reviewDatabase = new Database(databaseFile);
  const insertReview = reviewDatabase.prepare('INSERT INTO performance_reviews VALUES (?,?,?,?,?,?,?,?)');
  assert.throws(() => insertReview
    .run('unlinked-review', fundi.body.user.id, foreman.body.user.id, 'missing-assignment', 1, '', 'published', new Date().toISOString()));
  assert.throws(() => insertReview
    .run('wrong-reviewer', fundi.body.user.id, otherForeman.body.user.id, ownedAssignment.body.id, 1, '', 'published', new Date().toISOString()));
  assert.throws(() => insertReview
    .run('invalid-rating', fundi.body.user.id, foreman.body.user.id, ownedAssignment.body.id, 99, '', 'published', new Date().toISOString()));
  assert.throws(() => insertReview
    .run('unpublished-review', fundi.body.user.id, foreman.body.user.id, ownedAssignment.body.id, 1, '', 'pending', new Date().toISOString()));
  reviewDatabase.close();

  const qualifiedRecommendations = await fetch(`${baseUrl}/api/jobs/${createdJob.body.job.id}/matches`, {
    headers: { Authorization: `Bearer ${foreman.body.token}` },
  });
  const qualifiedCandidates = await qualifiedRecommendations.json() as any;
  const qualifiedCandidate = qualifiedCandidates.candidates.find((item: any) => item.fundi.id === fundi.body.user.id);
  assert.equal(qualifiedCandidate.eligible, true);
  assert.equal(qualifiedCandidate.score, 98);
  assert.ok(qualifiedCandidate.reasons.includes('Average performance rating 4.0/5'));

  const duplicateApplication = await requestJson(`/api/jobs/${createdJob.body.job.id}/apply`, 'POST', {}, fundi.body.token);
  assert.equal(duplicateApplication.status, 409);
});
