import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdminDashboardMetrics, getRecentAdminAuditLogs } from './admin-dashboard';
import { migrateDatabase } from './migrations';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fundiconnect-admin-'));
  temporaryDirectories.push(directory);
  const db = new Database(path.join(directory, 'isolated.sqlite'));
  migrateDatabase(db);
  return db;
}

function insertUser(db: Database.Database, id: string, role: string) {
  db.prepare(`INSERT INTO users (id,name,email,password_hash,role,created_at)
    VALUES (?,?,?,?,?,?)`).run(id, id, `${id}@example.test`, 'not-a-real-password-hash', role, '2026-01-01');
}

test('admin dashboard aggregates actual records without returning sensitive data', () => {
  const db = temporaryDatabase();
  try {
    insertUser(db, 'admin', 'administrator');
    insertUser(db, 'worker', 'fundi');
    insertUser(db, 'employer', 'foreman');
    db.prepare(`INSERT INTO jobs (id,title,trade,location,foreman_id,foreman_name,status,created_at)
      VALUES ('job','Build wall','Masonry','Nairobi','employer','Employer','open','2026-01-02')`).run();
    db.prepare(`INSERT INTO applications
      (id,job_id,job_title,trade,location,foreman_id,fundi_id,fundi_name,status,created_at)
      VALUES ('application','job','Build wall','Masonry','Nairobi','employer','worker','Worker','accepted','2026-01-03')`).run();
    db.prepare(`INSERT INTO assignments (id,foreman_id,worker_id,worker_name,job_id,status,created_at)
      VALUES ('assignment','employer','worker','Worker','job','in_progress','2026-01-04')`).run();
    db.prepare(`INSERT INTO attendance
      (id,assignment_id,worker_id,foreman_id,status,date,recorded_by,created_at,verification_status)
      VALUES ('attendance','assignment','worker','employer','present','2026-01-05','employer','2026-01-05','verified')`).run();
    db.prepare(`INSERT INTO disputes (id,user_id,foreman_id,subject,details,status,created_at)
      VALUES ('dispute','worker','employer','Issue','Details','under_review','2026-01-06')`).run();
    db.prepare(`INSERT INTO notifications (id,user_id,title,message,read,created_at)
      VALUES ('notification','worker','Update','Message',0,'2026-01-07')`).run();
    db.prepare(`INSERT INTO evidence (id,user_id,title,status,created_at)
      VALUES ('evidence','worker','Certificate','pending','2026-01-08')`).run();
    db.prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?,?)')
      .run('audit', 'admin', 'dashboard.viewed', 'admin-dashboard', 'Viewed summary', '2026-01-09');

    const metrics = getAdminDashboardMetrics(db);
    assert.deepEqual(metrics.users, {
      total: 3,
      byRole: { administrator: 1, foreman: 1, fundi: 1 },
    });
    assert.deepEqual(metrics.jobs, { total: 1, byStatus: { open: 1 } });
    assert.deepEqual(metrics.applications, { total: 1, byStatus: { accepted: 1 } });
    assert.deepEqual(metrics.assignments, { total: 1, byStatus: { in_progress: 1 } });
    assert.deepEqual(metrics.attendance, {
      total: 1,
      byStatus: { present: 1 },
      byVerificationStatus: { verified: 1 },
    });
    assert.equal(metrics.disputes.pending, 1);
    assert.equal(metrics.disputes.resolved, 0);
    assert.equal(metrics.notifications.unread, 1);
    assert.equal(metrics.evidence.pending, 1);
    assert.equal(JSON.stringify(metrics).includes('password'), false);
    assert.equal(JSON.stringify(metrics).includes('secret'), false);

    const auditPage = getRecentAdminAuditLogs(db);
    assert.deepEqual(Object.keys(auditPage.logs[0] as Record<string, unknown>).sort(), ['action', 'created_at', 'details', 'id', 'target']);
    assert.deepEqual({ total: auditPage.total, limit: auditPage.limit, offset: auditPage.offset }, { total: 1, limit: 25, offset: 0 });
  } finally {
    db.close();
  }
});

test('administrator audit logs are paginated newest first with stable ties', () => {
  const db = temporaryDatabase();
  try {
    insertUser(db, 'actor', 'administrator');
    for (const [id, timestamp] of [['old', '2026-01-01'], ['new-a', '2026-01-03'], ['new-b', '2026-01-03']] as const) {
      db.prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?,?)').run(id, 'actor', 'test.action', 'target', 'details', timestamp);
    }
    const first = getRecentAdminAuditLogs(db, 2, 0);
    const second = getRecentAdminAuditLogs(db, 2, 2);
    assert.deepEqual(first.logs.map((row) => (row as { id: string }).id), ['new-b', 'new-a']);
    assert.deepEqual(second.logs.map((row) => (row as { id: string }).id), ['old']);
    assert.equal(first.total, 3);
    assert.equal(second.offset, 2);
  } finally {
    db.close();
  }
});

test('admin dashboard reports zero counts for an empty database', () => {
  const db = temporaryDatabase();
  try {
    assert.deepEqual(getAdminDashboardMetrics(db), {
      users: { total: 0, byRole: {} },
      jobs: { total: 0, byStatus: {} },
      applications: { total: 0, byStatus: {} },
      assignments: { total: 0, byStatus: {} },
      attendance: { total: 0, byStatus: {}, byVerificationStatus: {} },
      disputes: { total: 0, pending: 0, resolved: 0, byStatus: {} },
      notifications: { total: 0, unread: 0 },
      evidence: { total: 0, pending: 0, byStatus: {} },
    });
  } finally {
    db.close();
  }
});
