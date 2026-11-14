import type Database from 'better-sqlite3';

export type Migration = {
  version: number;
  name: string;
  foreignKeys?: boolean;
  up: (db: Database.Database) => void;
};

function createLegacySchema(db: Database.Database) {
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('fundi','foreman','assessor','administrator')),
 phone TEXT DEFAULT '', trade TEXT DEFAULT '', location TEXT DEFAULT '', experience INTEGER DEFAULT 0,
 availability TEXT DEFAULT 'Available', bio TEXT DEFAULT '', verification_status TEXT DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, trade TEXT NOT NULL, location TEXT NOT NULL, description TEXT DEFAULT '',
 pay REAL DEFAULT 0, duration TEXT DEFAULT '', start_date TEXT DEFAULT '', workers_needed INTEGER DEFAULT 1,
 min_experience INTEGER DEFAULT 0, verification_required INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
 foreman_id TEXT NOT NULL, foreman_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, job_title TEXT NOT NULL, trade TEXT NOT NULL, location TEXT NOT NULL,
 foreman_id TEXT NOT NULL, fundi_id TEXT NOT NULL, fundi_name TEXT NOT NULL, message TEXT DEFAULT '',
 status TEXT DEFAULT 'submitted', created_at TEXT NOT NULL, UNIQUE(job_id,fundi_id)
);
CREATE TABLE IF NOT EXISTS evidence (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, evidence_type TEXT DEFAULT '', file_name TEXT DEFAULT '',
 file_path TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', reviewer_id TEXT DEFAULT '',
 reviewer_name TEXT DEFAULT '', review_notes TEXT DEFAULT '', created_at TEXT NOT NULL, reviewed_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS assignments (
 id TEXT PRIMARY KEY, foreman_id TEXT NOT NULL, worker_id TEXT NOT NULL, worker_name TEXT NOT NULL, job_id TEXT DEFAULT '',
 task TEXT DEFAULT '', start_date TEXT DEFAULT '', end_date TEXT DEFAULT '', payment REAL DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
 id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, worker_id TEXT NOT NULL, foreman_id TEXT NOT NULL,
 status TEXT NOT NULL, date TEXT NOT NULL, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS performance_reviews (
 id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, foreman_id TEXT NOT NULL, assignment_id TEXT DEFAULT '',
 rating INTEGER NOT NULL, feedback TEXT DEFAULT '', status TEXT DEFAULT 'published', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS disputes (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, foreman_id TEXT DEFAULT '', subject TEXT NOT NULL, details TEXT NOT NULL,
 record_id TEXT DEFAULT '', status TEXT DEFAULT 'open', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dispute_responses (
 id TEXT PRIMARY KEY, dispute_id TEXT NOT NULL, user_id TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, read INTEGER DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, details TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
`);
}

function addLegacyColumns(db: Database.Database) {
  const addColumn = (table: string, name: string, definition: string) => {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
    }
  };

  addColumn('users', 'auth_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'experience_unit', "TEXT NOT NULL DEFAULT 'years'");
  addColumn('users', 'skills', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('jobs', 'min_experience_unit', "TEXT NOT NULL DEFAULT 'years'");
  addColumn('jobs', 'required_skills', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('attendance', 'verification_status', "TEXT NOT NULL DEFAULT 'pending'");
  addColumn('attendance', 'verified_by', "TEXT NOT NULL DEFAULT ''");
  addColumn('attendance', 'verified_at', "TEXT NOT NULL DEFAULT ''");
  for (const [name, definition] of [
    ['other_party_id', "TEXT NOT NULL DEFAULT ''"],
    ['job_id', "TEXT NOT NULL DEFAULT ''"],
    ['assignment_id', "TEXT NOT NULL DEFAULT ''"],
    ['category', "TEXT NOT NULL DEFAULT ''"],
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
    ['resolution_note', "TEXT NOT NULL DEFAULT ''"],
    ['admin_id', "TEXT NOT NULL DEFAULT ''"],
    ['admin_name', "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    addColumn('disputes', name, definition);
  }
  addColumn('notifications', 'link', "TEXT NOT NULL DEFAULT ''");
  addColumn('notifications', 'event_key', "TEXT NOT NULL DEFAULT ''");
}

function rebuildRelationalSchema(db: Database.Database) {
  const explicitObjects = db.prepare(`
    SELECT name,sql FROM sqlite_master
    WHERE type IN ('index','trigger') AND tbl_name IN (
      'users','jobs','applications','evidence','assignments','attendance',
      'performance_reviews','disputes','dispute_responses','notifications','audit_logs','password_resets'
    ) AND sql IS NOT NULL
  `).all() as { name: string; sql: string }[];

  const invalidExistingRelations = [
    ['application/job employer', 'SELECT COUNT(*) AS count FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.foreman_id<>j.foreman_id'],
    ['assignment/job employer', 'SELECT COUNT(*) AS count FROM assignments a JOIN jobs j ON j.id=a.job_id WHERE a.foreman_id<>j.foreman_id'],
    ['attendance/assignment participants', 'SELECT COUNT(*) AS count FROM attendance x JOIN assignments a ON a.id=x.assignment_id WHERE x.worker_id<>a.worker_id OR x.foreman_id<>a.foreman_id'],
    ['review/assignment participants', `SELECT COUNT(*) AS count FROM performance_reviews r JOIN assignments a ON a.id=r.assignment_id
      JOIN users reviewer ON reviewer.id=r.foreman_id
      WHERE r.worker_id<>a.worker_id OR (r.foreman_id<>a.foreman_id AND reviewer.role<>'administrator')`],
    ['dispute/assignment participants', `SELECT COUNT(*) AS count FROM disputes d JOIN assignments a ON a.id=d.assignment_id
      WHERE (d.job_id IS NOT NULL AND d.job_id IS NOT a.job_id)
      OR (d.user_id<>a.worker_id AND d.user_id<>a.foreman_id)
      OR (d.other_party_id IS NOT NULL AND (
        d.other_party_id=d.user_id OR (d.other_party_id<>a.worker_id AND d.other_party_id<>a.foreman_id)
      ))`],
  ] as const;
  for (const [relation, query] of invalidExistingRelations) {
    const { count } = db.prepare(query).get() as { count: number };
    if (count) throw new Error(`Migration blocked: ${count} legacy ${relation} relationship(s) are inconsistent.`);
  }

  db.exec(`
CREATE TABLE users_new (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('fundi','foreman','assessor','administrator')),
 phone TEXT DEFAULT '', trade TEXT DEFAULT '', location TEXT DEFAULT '', experience INTEGER DEFAULT 0,
 availability TEXT DEFAULT 'Available', bio TEXT DEFAULT '', verification_status TEXT DEFAULT 'pending', created_at TEXT NOT NULL,
 auth_version INTEGER NOT NULL DEFAULT 0, experience_unit TEXT NOT NULL DEFAULT 'years', skills TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE jobs_new (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, trade TEXT NOT NULL, location TEXT NOT NULL, description TEXT DEFAULT '',
 pay REAL DEFAULT 0, duration TEXT DEFAULT '', start_date TEXT DEFAULT '', workers_needed INTEGER DEFAULT 1,
 min_experience INTEGER DEFAULT 0, verification_required INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
 foreman_id TEXT NOT NULL, foreman_name TEXT NOT NULL, created_at TEXT NOT NULL,
 min_experience_unit TEXT NOT NULL DEFAULT 'years', required_skills TEXT NOT NULL DEFAULT '[]',
 FOREIGN KEY(foreman_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE applications_new (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, job_title TEXT NOT NULL, trade TEXT NOT NULL, location TEXT NOT NULL,
 foreman_id TEXT NOT NULL, fundi_id TEXT NOT NULL, fundi_name TEXT NOT NULL, message TEXT DEFAULT '',
 status TEXT DEFAULT 'submitted', created_at TEXT NOT NULL, UNIQUE(job_id,fundi_id),
 FOREIGN KEY(job_id) REFERENCES jobs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(foreman_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(fundi_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE evidence_new (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, evidence_type TEXT DEFAULT '', file_name TEXT DEFAULT '',
 file_path TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', reviewer_id TEXT,
 reviewer_name TEXT DEFAULT '', review_notes TEXT DEFAULT '', created_at TEXT NOT NULL, reviewed_at TEXT DEFAULT '',
 FOREIGN KEY(user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(reviewer_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE assignments_new (
 id TEXT PRIMARY KEY, foreman_id TEXT NOT NULL, worker_id TEXT NOT NULL, worker_name TEXT NOT NULL, job_id TEXT,
 task TEXT DEFAULT '', start_date TEXT DEFAULT '', end_date TEXT DEFAULT '', payment REAL DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT NOT NULL,
 FOREIGN KEY(foreman_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(worker_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(job_id) REFERENCES jobs(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE attendance_new (
 id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, worker_id TEXT NOT NULL, foreman_id TEXT NOT NULL,
 status TEXT NOT NULL, date TEXT NOT NULL, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL,
 verification_status TEXT NOT NULL DEFAULT 'pending', verified_by TEXT,
 verified_at TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(worker_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(foreman_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(recorded_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(verified_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE performance_reviews_new (
 id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, foreman_id TEXT NOT NULL, assignment_id TEXT,
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), feedback TEXT DEFAULT '',
 status TEXT DEFAULT 'published', created_at TEXT NOT NULL,
 FOREIGN KEY(worker_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(foreman_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE disputes_new (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, other_party_id TEXT, foreman_id TEXT,
 subject TEXT NOT NULL, details TEXT NOT NULL, record_id TEXT DEFAULT '', job_id TEXT,
 assignment_id TEXT, category TEXT NOT NULL DEFAULT 'general', status TEXT DEFAULT 'open',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', resolution_note TEXT NOT NULL DEFAULT '',
 admin_id TEXT, admin_name TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(other_party_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(foreman_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(job_id) REFERENCES jobs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(admin_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE dispute_responses_new (
 id TEXT PRIMARY KEY, dispute_id TEXT NOT NULL, user_id TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(dispute_id) REFERENCES disputes(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE notifications_new (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
 read INTEGER NOT NULL DEFAULT 0 CHECK(read IN (0,1)), created_at TEXT NOT NULL,
 link TEXT NOT NULL DEFAULT '', event_key TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE audit_logs_new (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
 details TEXT DEFAULT '', created_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE password_resets_new (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

INSERT INTO users_new SELECT id,name,email,password_hash,role,phone,trade,location,experience,availability,bio,verification_status,created_at,auth_version,experience_unit,skills FROM users;
INSERT INTO jobs_new SELECT id,title,trade,location,description,pay,duration,start_date,workers_needed,min_experience,verification_required,status,foreman_id,foreman_name,created_at,min_experience_unit,required_skills FROM jobs;
INSERT INTO applications_new SELECT id,job_id,job_title,trade,location,foreman_id,fundi_id,fundi_name,message,status,created_at FROM applications;
INSERT INTO evidence_new SELECT id,user_id,title,evidence_type,file_name,file_path,description,status,NULLIF(reviewer_id,''),reviewer_name,review_notes,created_at,reviewed_at FROM evidence;
INSERT INTO assignments_new SELECT id,foreman_id,worker_id,worker_name,NULLIF(job_id,''),task,start_date,end_date,payment,status,created_at FROM assignments;
INSERT INTO attendance_new SELECT id,assignment_id,worker_id,foreman_id,status,date,recorded_by,created_at,verification_status,NULLIF(verified_by,''),verified_at FROM attendance;
INSERT INTO performance_reviews_new SELECT id,worker_id,foreman_id,NULLIF(assignment_id,''),rating,feedback,status,created_at FROM performance_reviews;
INSERT INTO disputes_new SELECT id,user_id,NULLIF(other_party_id,''),NULLIF(foreman_id,''),subject,details,record_id,NULLIF(job_id,''),NULLIF(assignment_id,''),COALESCE(NULLIF(category,''),'general'),status,created_at,COALESCE(NULLIF(updated_at,''),created_at),resolution_note,NULLIF(admin_id,''),admin_name FROM disputes;
INSERT INTO dispute_responses_new SELECT id,dispute_id,user_id,message,created_at FROM dispute_responses;
INSERT INTO notifications_new SELECT id,user_id,title,message,COALESCE(read,0),created_at,link,event_key FROM notifications;
INSERT INTO audit_logs_new SELECT id,user_id,action,target,details,created_at FROM audit_logs;
INSERT INTO password_resets_new SELECT token_hash,user_id,expires_at,created_at FROM password_resets;

DROP TABLE dispute_responses;
DROP TABLE attendance;
DROP TABLE performance_reviews;
DROP TABLE applications;
DROP TABLE evidence;
DROP TABLE assignments;
DROP TABLE disputes;
DROP TABLE notifications;
DROP TABLE audit_logs;
DROP TABLE password_resets;
DROP TABLE jobs;
DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
ALTER TABLE jobs_new RENAME TO jobs;
ALTER TABLE applications_new RENAME TO applications;
ALTER TABLE evidence_new RENAME TO evidence;
ALTER TABLE assignments_new RENAME TO assignments;
ALTER TABLE attendance_new RENAME TO attendance;
ALTER TABLE performance_reviews_new RENAME TO performance_reviews;
ALTER TABLE disputes_new RENAME TO disputes;
ALTER TABLE dispute_responses_new RENAME TO dispute_responses;
ALTER TABLE notifications_new RENAME TO notifications;
ALTER TABLE audit_logs_new RENAME TO audit_logs;
ALTER TABLE password_resets_new RENAME TO password_resets;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_job_worker ON assignments(job_id,worker_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_assignment_date ON attendance(assignment_id,date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_assignment_worker ON performance_reviews(assignment_id,worker_id) WHERE assignment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_recipient_event ON notifications(user_id,event_key) WHERE event_key<>'';
CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_open_dedup ON disputes(user_id,subject,details,COALESCE(job_id,''),COALESCE(assignment_id,'')) WHERE status IN ('open','under_review');
CREATE INDEX IF NOT EXISTS idx_users_role_created ON users(role,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_owner_created ON jobs(foreman_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_job_status_created ON applications(job_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_fundi_status_created ON applications(fundi_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignments_foreman_status_created ON assignments(foreman_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignments_worker_status_created ON assignments(worker_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_worker_date ON attendance(worker_id,date DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_worker_status_created ON performance_reviews(worker_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_reporter_status_created ON disputes(user_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_other_party_created ON disputes(other_party_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_assignment_status ON disputes(assignment_id,status);
CREATE INDEX IF NOT EXISTS idx_disputes_job_status ON disputes(job_id,status);
CREATE INDEX IF NOT EXISTS idx_dispute_responses_dispute_created ON dispute_responses(dispute_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read_created ON notifications(user_id,read,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_action_created ON audit_logs(target,action,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_user_status_created ON evidence(user_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);

CREATE TRIGGER applications_job_owner_insert BEFORE INSERT ON applications
WHEN NOT EXISTS (SELECT 1 FROM jobs WHERE id=NEW.job_id AND foreman_id=NEW.foreman_id)
BEGIN SELECT RAISE(ABORT,'application employer must own the referenced job'); END;
CREATE TRIGGER applications_job_owner_update BEFORE UPDATE OF job_id,foreman_id ON applications
WHEN NOT EXISTS (SELECT 1 FROM jobs WHERE id=NEW.job_id AND foreman_id=NEW.foreman_id)
BEGIN SELECT RAISE(ABORT,'application employer must own the referenced job'); END;
CREATE TRIGGER assignments_job_owner_insert BEFORE INSERT ON assignments
WHEN NEW.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id=NEW.job_id AND foreman_id=NEW.foreman_id)
BEGIN SELECT RAISE(ABORT,'assignment employer must own the referenced job'); END;
CREATE TRIGGER assignments_job_owner_update BEFORE UPDATE OF job_id,foreman_id ON assignments
WHEN NEW.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id=NEW.job_id AND foreman_id=NEW.foreman_id)
BEGIN SELECT RAISE(ABORT,'assignment employer must own the referenced job'); END;
CREATE TRIGGER attendance_assignment_participants_insert BEFORE INSERT ON attendance
WHEN NOT EXISTS (SELECT 1 FROM assignments WHERE id=NEW.assignment_id AND worker_id=NEW.worker_id AND foreman_id=NEW.foreman_id)
BEGIN SELECT RAISE(ABORT,'attendance participants must match the assignment'); END;
CREATE TRIGGER attendance_assignment_participants_update BEFORE UPDATE OF assignment_id,worker_id,foreman_id ON attendance
WHEN NOT EXISTS (SELECT 1 FROM assignments WHERE id=NEW.assignment_id AND worker_id=NEW.worker_id AND foreman_id=NEW.foreman_id)
BEGIN SELECT RAISE(ABORT,'attendance participants must match the assignment'); END;
CREATE TRIGGER reviews_assignment_participants_insert BEFORE INSERT ON performance_reviews
WHEN NEW.assignment_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM assignments a JOIN users reviewer ON reviewer.id=NEW.foreman_id
 WHERE a.id=NEW.assignment_id AND a.worker_id=NEW.worker_id
 AND (a.foreman_id=NEW.foreman_id OR reviewer.role='administrator')
)
BEGIN SELECT RAISE(ABORT,'review participants must match the assignment'); END;
CREATE TRIGGER reviews_assignment_participants_update BEFORE UPDATE OF assignment_id,worker_id,foreman_id ON performance_reviews
WHEN NEW.assignment_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM assignments a JOIN users reviewer ON reviewer.id=NEW.foreman_id
 WHERE a.id=NEW.assignment_id AND a.worker_id=NEW.worker_id
 AND (a.foreman_id=NEW.foreman_id OR reviewer.role='administrator')
)
BEGIN SELECT RAISE(ABORT,'review participants must match the assignment'); END;
CREATE TRIGGER disputes_assignment_participants_insert BEFORE INSERT ON disputes
WHEN NEW.assignment_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM assignments a
 WHERE a.id=NEW.assignment_id AND (NEW.job_id IS NULL OR NEW.job_id=a.job_id)
 AND (NEW.user_id=a.worker_id OR NEW.user_id=a.foreman_id)
 AND (NEW.other_party_id IS NULL OR (
   NEW.other_party_id<>NEW.user_id AND (NEW.other_party_id=a.worker_id OR NEW.other_party_id=a.foreman_id)
 ))
)
BEGIN SELECT RAISE(ABORT,'dispute parties and job must match the assignment'); END;
CREATE TRIGGER disputes_assignment_participants_update BEFORE UPDATE OF assignment_id,job_id,user_id,other_party_id ON disputes
WHEN NEW.assignment_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM assignments a
 WHERE a.id=NEW.assignment_id AND (NEW.job_id IS NULL OR NEW.job_id=a.job_id)
 AND (NEW.user_id=a.worker_id OR NEW.user_id=a.foreman_id)
 AND (NEW.other_party_id IS NULL OR (
   NEW.other_party_id<>NEW.user_id AND (NEW.other_party_id=a.worker_id OR NEW.other_party_id=a.foreman_id)
 ))
)
BEGIN SELECT RAISE(ABORT,'dispute parties and job must match the assignment'); END;
`);

  for (const { name, sql } of explicitObjects) {
    if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name)) db.exec(sql);
  }
}

export const DATABASE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'record-current-schema',
    up(db) {
      createLegacySchema(db);
      addLegacyColumns(db);
    },
  },
  {
    version: 2,
    name: 'relational-integrity-and-query-indexes',
    foreignKeys: false,
    up: rebuildRelationalSchema,
  },
  {
    version: 3,
    name: 'dispute-assignment-consistency-triggers',
    up(db) {
      db.exec(`
CREATE TRIGGER IF NOT EXISTS disputes_assignment_participants_insert BEFORE INSERT ON disputes
WHEN NEW.assignment_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM assignments a
 WHERE a.id=NEW.assignment_id AND (NEW.job_id IS NULL OR NEW.job_id=a.job_id)
 AND (NEW.user_id=a.worker_id OR NEW.user_id=a.foreman_id)
 AND (NEW.other_party_id IS NULL OR (
   NEW.other_party_id<>NEW.user_id AND (NEW.other_party_id=a.worker_id OR NEW.other_party_id=a.foreman_id)
  ))
)
BEGIN SELECT RAISE(ABORT,'dispute parties and job must match the assignment'); END;
CREATE TRIGGER IF NOT EXISTS disputes_assignment_participants_update BEFORE UPDATE OF assignment_id,job_id,user_id,other_party_id ON disputes
WHEN NEW.assignment_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM assignments a
 WHERE a.id=NEW.assignment_id AND (NEW.job_id IS NULL OR NEW.job_id=a.job_id)
 AND (NEW.user_id=a.worker_id OR NEW.user_id=a.foreman_id)
 AND (NEW.other_party_id IS NULL OR (
   NEW.other_party_id<>NEW.user_id AND (NEW.other_party_id=a.worker_id OR NEW.other_party_id=a.foreman_id)
  ))
)
BEGIN SELECT RAISE(ABORT,'dispute parties and job must match the assignment'); END;
`);
    },
  },
  {
    version: 4,
    name: 'revocable-auth-sessions',
    up(db) {
db.exec(`
CREATE TABLE auth_sessions (
 session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL, revoked_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX idx_auth_sessions_user_expiry ON auth_sessions(user_id,expires_at);
`);
    },
  },
];

export function enableForeignKeys(db: Database.Database) {
  db.pragma('foreign_keys = ON');
  const result = db.pragma('foreign_keys', { simple: true });
  if (result !== 1) throw new Error('SQLite foreign-key enforcement could not be enabled.');
}

export function getSchemaVersion(db: Database.Database) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!exists) return 0;
  const row = db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get() as { version: number };
  return row.version;
}

export function migrateDatabase(db: Database.Database, migrations: readonly Migration[] = DATABASE_MIGRATIONS) {
  enableForeignKeys(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const [index, migration] of ordered.entries()) {
    if (!Number.isInteger(migration.version) || migration.version !== index + 1 || versions.has(migration.version)) {
      throw new Error('Database migrations must use unique, consecutive versions starting at 1.');
    }
    versions.add(migration.version);
  }
  const applied = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all() as { version: number; name: string }[];
  for (const [index, migration] of ordered.entries()) {
    if (applied[index] && (applied[index].version !== migration.version || applied[index].name !== migration.name)) {
      throw new Error(`Applied database migration ${applied[index].version} does not match the migration history.`);
    }
  }
  if (applied.length > ordered.length) throw new Error('The database was migrated by a newer application version.');
  if (Number(db.pragma('user_version', { simple: true })) !== getSchemaVersion(db)) {
    throw new Error('SQLite user_version does not match the recorded migration history.');
  }

  for (const migration of ordered.slice(applied.length)) {
    if (migration.foreignKeys === false) db.pragma('foreign_keys = OFF');
    try {
      const apply = db.transaction(() => {
        migration.up(db);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length) throw new Error(`Migration ${migration.version} produced foreign-key violations.`);
        db.prepare('INSERT INTO schema_migrations (version,name,applied_at) VALUES (?,?,?)')
          .run(migration.version, migration.name, new Date().toISOString());
        db.pragma(`user_version = ${migration.version}`);
      });
      apply.immediate();
    } finally {
      enableForeignKeys(db);
    }
  }
  return getSchemaVersion(db);
}
