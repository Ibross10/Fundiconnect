import type Database from 'better-sqlite3';

type CountRow = { value: string | null; count: number };

function groupedCounts(db: Database.Database, query: string) {
  const rows = db.prepare(query).all() as CountRow[];
  return Object.fromEntries(rows.map(({ value, count }) => [value || 'unknown', count]));
}

function total(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function getAdminDashboardMetrics(db: Database.Database) {
  const users = groupedCounts(db, 'SELECT role AS value, COUNT(*) AS count FROM users GROUP BY role');
  const jobs = groupedCounts(db, 'SELECT status AS value, COUNT(*) AS count FROM jobs GROUP BY status');
  const applications = groupedCounts(db, 'SELECT status AS value, COUNT(*) AS count FROM applications GROUP BY status');
  const assignments = groupedCounts(db, 'SELECT status AS value, COUNT(*) AS count FROM assignments GROUP BY status');
  const attendance = groupedCounts(db, 'SELECT status AS value, COUNT(*) AS count FROM attendance GROUP BY status');
  const attendanceVerification = groupedCounts(db, 'SELECT verification_status AS value, COUNT(*) AS count FROM attendance GROUP BY verification_status');
  const disputes = groupedCounts(db, 'SELECT status AS value, COUNT(*) AS count FROM disputes GROUP BY status');
  const notifications = groupedCounts(db, 'SELECT CAST(read AS TEXT) AS value, COUNT(*) AS count FROM notifications GROUP BY read');
  const evidence = groupedCounts(db, 'SELECT status AS value, COUNT(*) AS count FROM evidence GROUP BY status');

  return {
    users: {
      total: total(users),
      byRole: users,
    },
    jobs: { total: total(jobs), byStatus: jobs },
    applications: { total: total(applications), byStatus: applications },
    assignments: { total: total(assignments), byStatus: assignments },
    attendance: {
      total: total(attendance),
      byStatus: attendance,
      byVerificationStatus: attendanceVerification,
    },
    disputes: {
      total: total(disputes),
      pending: (disputes.open || 0) + (disputes.under_review || 0),
      resolved: (disputes.resolved || 0) + (disputes.rejected || 0) + (disputes.closed || 0),
      byStatus: disputes,
    },
    notifications: {
      total: total(notifications),
      unread: notifications['0'] || 0,
    },
    evidence: {
      total: total(evidence),
      pending: evidence.pending || 0,
      byStatus: evidence,
    },
  };
}

export function getRecentAdminAuditLogs(db: Database.Database, limit = 25, offset = 0) {
  const total = (db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get() as { count: number }).count;
  const logs = db.prepare(`SELECT id,action,target,details,created_at
    FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  return { logs, total, limit, offset };
}
