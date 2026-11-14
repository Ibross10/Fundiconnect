import { Router, type NextFunction, type Request, type Response } from 'express';
import { convertExperience, match, parseSkillList, validExperience, type MatchJob } from './matching';

type Role = 'fundi' | 'foreman' | 'assessor' | 'administrator';
type AuthenticatedRequest = Request & { user?: { id: string; role: Role; name: string; email: string } };
type Dependencies = {
  db: import('better-sqlite3').Database;
  auth: (req: AuthenticatedRequest, res: Response, next: NextFunction) => unknown;
  roles: (...allowed: Role[]) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => unknown;
  clean: (value: unknown, max?: number) => string;
  id: () => string;
  now: () => string;
  sign: (user: Record<string, unknown>) => string;
  audit: (userId: string, action: string, target: string, details?: string) => void;
  notify: (userId: string, title: string, message: string) => void;
};

function experienceError(res: Response) {
  return res.status(400).json({ error: 'Experience must be a reasonable duration in days, months or years; fundis must enter a value greater than zero.' });
}

function validatedSkills(value: unknown) {
  if (value === undefined || value === null || value === '') return [];
  let skills: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        skills = JSON.parse(trimmed);
      } catch {
        return null;
      }
    } else {
      skills = trimmed.split(',');
    }
  }
  if (!Array.isArray(skills) || skills.length > 30 || skills.some((skill) => typeof skill !== 'string')) return null;
  const cleaned = skills.map((skill) => (skill as string).trim());
  if (cleaned.some((skill) => skill.length > 80)) return null;
  return parseSkillList(cleaned);
}

export function installMatchingRoutes(dependencies: Dependencies) {
  const { db, auth, roles, clean, id, now, sign, audit, notify } = dependencies;
  const router = Router();
  const isPendingApplication = (status: string) => status === 'pending' || status === 'submitted';
  const publicApplicationStatus = (status: string) => status === 'submitted' ? 'pending' : status;
  const jobValues = (body: Record<string, unknown>, existing?: Record<string, any>) => {
    const allowed = ['title', 'trade', 'location', 'description', 'duration', 'startDate', 'pay', 'workersNeeded', 'minExperience', 'minExperienceUnit', 'requiredSkills', 'verificationRequired'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      return { error: 'The request contains unsupported job fields.' } as const;
    }
    const textLimits: Record<string, number> = { title: 120, trade: 80, location: 100, description: 2000, duration: 80, startDate: 10 };
    for (const [key, limit] of Object.entries(textLimits)) {
      if (body[key] !== undefined && typeof body[key] !== 'string') {
        return { error: 'Job text fields must be provided as text.' } as const;
      }
      if (typeof body[key] === 'string' && body[key].length > limit) {
        return { error: `Job ${key === 'startDate' ? 'start date' : key} must be ${limit} characters or fewer.` } as const;
      }
    }
    const value = (key: string, stored: unknown, max: number) => body[key] === undefined
      ? clean(stored, max)
      : clean(body[key], max);
    const title = value('title', existing?.title, 120);
    const trade = value('trade', existing?.trade, 80);
    const location = value('location', existing?.location, 100);
    if (!title || !trade || !location) return { error: 'Job title, trade and location are required.' } as const;

    const numericValue = (key: string, stored: number, fallback: number) => {
      if (body[key] === undefined) return stored;
      if ((typeof body[key] !== 'number' && typeof body[key] !== 'string') || String(body[key]).trim() === '') return fallback;
      const parsed = Number(body[key]);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const pay = numericValue('pay', Number(existing?.pay ?? 0), -1);
    if (pay < 0 || pay > 100_000_000) return { error: 'Pay must be a valid amount between 0 and 100,000,000 KES.' } as const;
    const workersNeeded = numericValue('workersNeeded', Number(existing?.workers_needed ?? 1), -1);
    if (!Number.isInteger(workersNeeded) || workersNeeded < 1 || workersNeeded > 500) {
      return { error: 'Workers needed must be a whole number from 1 to 500.' } as const;
    }

    let minExperience = Number(existing?.min_experience ?? 0);
    let minExperienceUnit = existing?.min_experience_unit || 'years';
    if (!existing || body.minExperience !== undefined || body.minExperienceUnit !== undefined) {
      minExperienceUnit = body.minExperienceUnit === undefined ? minExperienceUnit : String(body.minExperienceUnit);
      const validated = validExperience(body.minExperience === undefined ? minExperience : body.minExperience, minExperienceUnit);
      if (!validated) return { error: 'Minimum experience must be a reasonable duration in days, months or years.' } as const;
      minExperience = validated.value;
      minExperienceUnit = validated.unit;
    }

    let requiredSkills = parseSkillList(existing?.required_skills);
    if (!existing || body.requiredSkills !== undefined) {
      const validated = validatedSkills(body.requiredSkills ?? (existing ? requiredSkills : []));
      if (!validated) return { error: 'Required skills must be a list of up to 30 names, each 80 characters or fewer.' } as const;
      requiredSkills = validated;
    }
    let verificationRequired = Number(existing?.verification_required ?? 0) === 1;
    if (body.verificationRequired !== undefined) {
      if (![true, false, 0, 1, 'yes', 'no'].includes(body.verificationRequired as boolean | number | string)) {
        return { error: 'Verification required must be true or false.' } as const;
      }
      verificationRequired = body.verificationRequired === true || body.verificationRequired === 1 || body.verificationRequired === 'yes';
    } else if (!existing) {
      verificationRequired = false;
    }

    let startDate = clean(existing?.start_date, 30);
    if (body.startDate !== undefined) {
      startDate = clean(body.startDate, 30);
      if (startDate) {
        const parsed = new Date(`${startDate}T00:00:00.000Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== startDate) {
          return { error: 'Start date must be a valid calendar date.' } as const;
        }
      }
    }
    return {
      values: {
        title, trade, location,
        description: value('description', existing?.description, 2000),
        pay, duration: value('duration', existing?.duration, 80), start_date: startDate,
        workers_needed: workersNeeded, min_experience: minExperience,
        min_experience_unit: minExperienceUnit, required_skills: JSON.stringify(requiredSkills),
        verification_required: verificationRequired ? 1 : 0,
      },
    } as const;
  };

  router.post('/api/auth/register', async (req: AuthenticatedRequest, res: Response) => {
    const name = typeof req.body.name === 'string' ? clean(req.body.name, 100) : '';
    const email = typeof req.body.email === 'string' ? clean(req.body.email, 160).toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const role = clean(req.body.role) as Role;
    if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
      || email.length > 160 || password.length < 8 || password.length > 200
      || !['fundi', 'foreman'].includes(role)) {
      return res.status(400).json({ error: 'Provide a name, valid email, password (at least 8 characters) and a permitted role.' });
    }
    const experience = req.body.experience === undefined && role !== 'fundi'
      ? { value: 0, unit: 'years' as const }
      : validExperience(req.body.experience, req.body.experienceUnit, role === 'fundi');
    if (!experience) return experienceError(res);
    const skills = validatedSkills(req.body.skills);
    if (!skills) return res.status(400).json({ error: 'Skills must be a list of up to 30 names, each 80 characters or fewer.' });
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const bcrypt = await import('bcryptjs');
    const user = {
      id: id(), name, email, password_hash: await bcrypt.default.hash(password, 12), role,
      phone: clean(req.body.phone, 30), trade: clean(req.body.trade, 80),
      location: clean(req.body.location, 100), experience: experience.value,
      experience_unit: experience.unit, skills: JSON.stringify(skills),
      availability: clean(req.body.availability, 60) || 'Available', bio: clean(req.body.bio, 500),
      verification_status: 'pending', created_at: now(),
    };
    const token = db.transaction(() => {
      db.prepare(`INSERT INTO users
        (id,name,email,password_hash,role,phone,trade,location,experience,experience_unit,skills,availability,bio,verification_status,created_at)
        VALUES (@id,@name,@email,@password_hash,@role,@phone,@trade,@location,@experience,@experience_unit,@skills,@availability,@bio,@verification_status,@created_at)`).run(user);
      audit(user.id, 'account.created', user.id, role);
      return sign(user);
    }).immediate();
    const { password_hash: _passwordHash, ...safe } = user;
    return res.status(201).json({ token, user: { ...safe, skills } });
  });

  router.get('/api/me', auth, (req: AuthenticatedRequest, res: Response) => {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id) as Record<string, any> | undefined;
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    const { password_hash: _passwordHash, ...profile } = user;
    return res.json({ profile: { ...profile, skills: parseSkillList(user.skills), experience_unit: user.experience_unit || 'years' } });
  });

  router.patch('/api/me', auth, (req: AuthenticatedRequest, res: Response) => {
    const current = db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id) as Record<string, any> | undefined;
    if (!current) return res.status(404).json({ error: 'Account not found.' });
    const fields = ['name', 'phone', 'trade', 'location', 'availability', 'bio'] as const;
    const allowed = new Set<string>([...fields, 'experience', 'experienceUnit', 'skills']);
    if (Object.keys(req.body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ error: 'The request contains unsupported profile fields.' });
    }
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        if (typeof req.body[field] !== 'string') return res.status(400).json({ error: `${field} must be text.` });
        const limit = field === 'bio' ? 500 : field === 'name' ? 100 : field === 'phone' ? 30 : field === 'trade' ? 80 : field === 'location' ? 100 : 60;
        if (req.body[field].length > limit || (field === 'name' && !clean(req.body[field], limit))) {
          return res.status(400).json({ error: `${field} is required and must be ${limit} characters or fewer.` });
        }
        values[field] = clean(req.body[field], limit);
      }
    }
    if (req.body.experience !== undefined || req.body.experienceUnit !== undefined) {
      const requestedUnit = req.body.experienceUnit ?? current.experience_unit ?? 'years';
      const changingOnlyUnit = req.body.experience === undefined && requestedUnit !== (current.experience_unit || 'years');
      const experience = changingOnlyUnit
        ? convertExperience(current.experience, current.experience_unit || 'years', requestedUnit)
        : validExperience(req.body.experience ?? current.experience, requestedUnit, false);
      if (!experience) return experienceError(res);
      values.experience = experience.value;
      values.experience_unit = experience.unit;
    }
    if (req.body.skills !== undefined) {
      const skills = validatedSkills(req.body.skills);
      if (!skills) return res.status(400).json({ error: 'Skills must be a list of up to 30 names, each 80 characters or fewer.' });
      values.skills = JSON.stringify(skills);
    }
    const keys = Object.keys(values);
    if (keys.length) {
      db.transaction(() => {
        db.prepare(`UPDATE users SET ${keys.map((key) => `${key}=@${key}`).join(',')} WHERE id=@id`).run({ ...values, id: current.id });
        if (req.user!.role === 'fundi') audit(req.user!.id, 'profile.updated', current.id, keys.join(','));
      }).immediate();
    }
    const profile = db.prepare('SELECT id,name,email,role,phone,trade,location,experience,experience_unit,skills,availability,bio,verification_status,created_at FROM users WHERE id=?').get(current.id) as Record<string, any>;
    return res.json({ profile: { ...profile, skills: parseSkillList(profile.skills) } });
  });

  router.post('/api/jobs', auth, roles('foreman', 'administrator'), (req: AuthenticatedRequest, res: Response) => {
    const parsed = jobValues(req.body ?? {});
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const job = {
      id: id(), ...parsed.values, status: 'open',
      foreman_id: req.user!.id, foreman_name: req.user!.name, created_at: now(),
    };
    const create = db.transaction(() => {
      db.prepare(`INSERT INTO jobs
        (id,title,trade,location,description,pay,duration,start_date,workers_needed,min_experience,min_experience_unit,required_skills,verification_required,status,foreman_id,foreman_name,created_at)
        VALUES (@id,@title,@trade,@location,@description,@pay,@duration,@start_date,@workers_needed,@min_experience,@min_experience_unit,@required_skills,@verification_required,@status,@foreman_id,@foreman_name,@created_at)`).run(job);
      audit(req.user!.id, 'job.created', job.id, job.title);
    });
    create();
    return res.status(201).json({ job });
  });

  router.get('/api/jobs/:id', auth, (req: AuthenticatedRequest, res: Response) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id) as Record<string, any> | undefined;
    if (!job || (job.status !== 'open' && job.foreman_id !== req.user!.id && req.user!.role !== 'administrator')) {
      return res.status(404).json({ error: 'Job not found.' });
    }
    return res.json({ job });
  });

  router.patch('/api/jobs/:id', auth, roles('foreman', 'administrator'), (req: AuthenticatedRequest, res: Response) => {
    const current = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id) as Record<string, any> | undefined;
    if (!current || (req.user!.role !== 'administrator' && current.foreman_id !== req.user!.id)) {
      return res.status(404).json({ error: 'Job not found or access denied.' });
    }
    const parsed = jobValues(req.body, current);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const update = db.transaction(() => {
      db.prepare(`UPDATE jobs SET title=@title,trade=@trade,location=@location,description=@description,
        pay=@pay,duration=@duration,start_date=@start_date,workers_needed=@workers_needed,
        min_experience=@min_experience,min_experience_unit=@min_experience_unit,
        required_skills=@required_skills,verification_required=@verification_required WHERE id=@id`)
        .run({ ...parsed.values, id: current.id });
      audit(req.user!.id, 'job.updated', current.id, current.title);
    });
    update();
    return res.json({ job: db.prepare('SELECT * FROM jobs WHERE id=?').get(current.id) });
  });

  router.patch('/api/jobs/:id/status', auth, roles('foreman', 'administrator'), (req: AuthenticatedRequest, res: Response) => {
    const status = req.body?.status;
    if (status !== 'open' && status !== 'closed') return res.status(400).json({ error: 'Job status must be open or closed.' });
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id) as Record<string, any> | undefined;
    if (!job || (req.user!.role !== 'administrator' && job.foreman_id !== req.user!.id)) {
      return res.status(404).json({ error: 'Job not found or access denied.' });
    }
    if (job.status === status) return res.status(409).json({ error: `This job is already ${status}.` });
    const update = db.transaction(() => {
      db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, job.id);
      audit(req.user!.id, `job.${status}`, job.id, job.title);
    });
    update();
    return res.json({ id: job.id, status });
  });

  router.get('/api/jobs/:id/matches', auth, roles('foreman', 'administrator'), (req: AuthenticatedRequest, res: Response) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id) as (Record<string, any> & MatchJob) | undefined;
    if (!job || (req.user!.role !== 'administrator' && job.foreman_id !== req.user!.id)) {
      return res.status(404).json({ error: 'Job not found or access denied.' });
    }
    const performance = new Map((db.prepare(`SELECT review.worker_id,AVG(review.rating) AS average
      FROM performance_reviews review
      JOIN assignments assignment
        ON assignment.id=review.assignment_id
        AND assignment.worker_id=review.worker_id
      JOIN users worker ON worker.id=review.worker_id AND worker.role='fundi'
      JOIN users reviewer ON reviewer.id=review.foreman_id
        AND reviewer.role IN ('foreman','administrator')
      WHERE review.status='published'
        AND (
          (reviewer.role='foreman' AND assignment.foreman_id=review.foreman_id)
          OR reviewer.role='administrator'
        )
        AND EXISTS (
          SELECT 1 FROM attendance
          JOIN users verifier ON verifier.id=attendance.verified_by
          WHERE attendance.assignment_id=assignment.id
            AND attendance.worker_id=assignment.worker_id
            AND attendance.foreman_id=assignment.foreman_id
            AND attendance.recorded_by=attendance.verified_by
            AND attendance.verification_status='verified'
            AND (
              (verifier.role='foreman' AND attendance.verified_by=assignment.foreman_id)
              OR verifier.role='administrator'
            )
            AND attendance.status IN ('present','late')
        )
        AND typeof(review.rating)='integer'
        AND review.rating BETWEEN 1 AND 5
      GROUP BY review.worker_id`).all() as { worker_id: string; average: number }[])
      .map((row) => [row.worker_id, row.average]));
    const candidates = (db.prepare(`SELECT id,name,role,trade,location,experience,experience_unit,skills,
      availability,bio,verification_status,created_at FROM users WHERE role='fundi'`).all() as Record<string, any>[])
      .map((fundi) => match(job, fundi, performance.get(fundi.id)))
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score)
      .slice(0, 50);
    return res.json({ candidates });
  });

  router.get('/api/jobs/:id/applications', auth, roles('foreman', 'administrator'), (req: AuthenticatedRequest, res: Response) => {
    const job = db.prepare('SELECT id,foreman_id FROM jobs WHERE id=?').get(req.params.id) as { id: string; foreman_id: string } | undefined;
    if (!job || (req.user!.role !== 'administrator' && job.foreman_id !== req.user!.id)) {
      return res.status(404).json({ error: 'Job not found or access denied.' });
    }
    const rows = db.prepare(`SELECT application.id,application.job_id,application.job_title,application.trade,
      application.location,application.message,application.status,application.created_at,
      COALESCE((SELECT MAX(log.created_at) FROM audit_logs log
        WHERE log.target=application.id AND log.action LIKE 'application.%'),application.created_at) AS updated_at,
      worker.id AS applicant_id,worker.name AS applicant_name,worker.trade AS applicant_trade,
      worker.location AS applicant_location,worker.experience AS applicant_experience,
      worker.experience_unit AS applicant_experience_unit,worker.skills AS applicant_skills,
      worker.availability AS applicant_availability,worker.verification_status AS applicant_verification_status,
      worker.bio AS applicant_bio
      FROM applications application
      JOIN users worker ON worker.id=application.fundi_id AND worker.role='fundi'
      WHERE application.job_id=? ORDER BY application.created_at DESC`).all(job.id) as Record<string, any>[];
    return res.json({ applications: rows.map((application) => ({
      id: application.id, job_id: application.job_id, job_title: application.job_title,
      trade: application.trade, location: application.location, message: application.message,
      status: publicApplicationStatus(application.status), created_at: application.created_at, updated_at: application.updated_at,
      applicant: {
        id: application.applicant_id, name: application.applicant_name, trade: application.applicant_trade,
        location: application.applicant_location, experience: application.applicant_experience,
        experience_unit: application.applicant_experience_unit || 'years',
        skills: parseSkillList(application.applicant_skills), availability: application.applicant_availability,
        verification_status: application.applicant_verification_status, bio: application.applicant_bio,
      },
    })) });
  });

  router.get('/api/applications', auth, roles('fundi'), (req: AuthenticatedRequest, res: Response) => {
    const rows = db.prepare(`SELECT application.id,application.job_id,application.job_title,application.trade,
      application.location,application.message,application.status,application.created_at,
      COALESCE((SELECT MAX(log.created_at) FROM audit_logs log
        WHERE log.target=application.id AND log.action LIKE 'application.%'),application.created_at) AS updated_at,
      job.status AS job_status
      FROM applications application JOIN jobs job ON job.id=application.job_id
      WHERE application.fundi_id=? ORDER BY application.created_at DESC`).all(req.user!.id);
    const applications = (rows as Record<string, any>[]).map((application) => ({
      ...application, status: publicApplicationStatus(application.status),
    }));
    return res.json({ applications });
  });

  router.patch('/api/applications/:id', auth, roles('fundi'), (req: AuthenticatedRequest, res: Response) => {
    const body = req.body ?? {};
    if (Object.hasOwn(body, 'status')) return res.status(400).json({ error: 'Application status can only be changed by its employer.' });
    if (typeof body.message !== 'string' || body.message.length > 1000) {
      return res.status(400).json({ error: 'Application message must be 1,000 characters or fewer.' });
    }
    const application = db.prepare('SELECT * FROM applications WHERE id=? AND fundi_id=?')
      .get(req.params.id, req.user!.id) as Record<string, any> | undefined;
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    if (!isPendingApplication(application.status)) return res.status(409).json({ error: 'Only pending applications can be edited.' });
    const updatedAt = now();
    const update = db.transaction(() => {
      db.prepare("UPDATE applications SET message=? WHERE id=? AND fundi_id=? AND status IN ('submitted','pending')")
        .run(clean(body.message, 1000), application.id, req.user!.id);
      audit(req.user!.id, 'application.updated', application.id, application.job_title);
    });
    update();
    return res.json({ id: application.id, status: 'pending', message: clean(body.message, 1000), updated_at: updatedAt });
  });

  router.post('/api/applications/:id/withdraw', auth, roles('fundi'), (req: AuthenticatedRequest, res: Response) => {
    const application = db.prepare('SELECT * FROM applications WHERE id=? AND fundi_id=?')
      .get(req.params.id, req.user!.id) as Record<string, any> | undefined;
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    if (!isPendingApplication(application.status)) return res.status(409).json({ error: 'Only pending applications can be withdrawn.' });
    const updatedAt = now();
    const withdraw = db.transaction(() => {
      const result = db.prepare("UPDATE applications SET status='withdrawn' WHERE id=? AND fundi_id=? AND status IN ('submitted','pending')")
        .run(application.id, req.user!.id);
      if (!result.changes) return false;
      notify(application.foreman_id, 'Application withdrawn', `${application.fundi_name} withdrew an application for ${application.job_title}.`);
      audit(req.user!.id, 'application.withdrawn', application.id, application.job_title);
      return true;
    });
    if (!withdraw()) return res.status(409).json({ error: 'Only pending applications can be withdrawn.' });
    return res.json({ id: application.id, status: 'withdrawn', updated_at: updatedAt });
  });

  router.patch('/api/applications/:id/status', auth, roles('foreman', 'administrator'), (req: AuthenticatedRequest, res: Response) => {
    const status = req.body?.status;
    if (status !== 'accepted' && status !== 'rejected') {
      return res.status(400).json({ error: 'Application status must be accepted or rejected.' });
    }
    const application = db.prepare(`SELECT application.*,job.foreman_id AS job_foreman_id
      FROM applications application JOIN jobs job ON job.id=application.job_id
      WHERE application.id=?`).get(req.params.id) as Record<string, any> | undefined;
    if (!application || application.foreman_id !== application.job_foreman_id
      || (req.user!.role !== 'administrator' && application.job_foreman_id !== req.user!.id)) {
      return res.status(404).json({ error: 'Application not found or access denied.' });
    }
    if (!isPendingApplication(application.status)) return res.status(409).json({ error: 'Only pending applications can be reviewed.' });
    const updatedAt = now();
    const review = db.transaction(() => {
      const result = db.prepare("UPDATE applications SET status=? WHERE id=? AND status IN ('submitted','pending')")
        .run(status, application.id);
      if (!result.changes) return false;
      const action = status === 'accepted' ? 'accepted' : 'rejected';
      notify(application.fundi_id, `Application ${action}`, `Your application for ${application.job_title} was ${action}.`);
      audit(req.user!.id, `application.${action}`, application.id, application.job_title);
      return true;
    });
    if (!review()) return res.status(409).json({ error: 'Only pending applications can be reviewed.' });
    return res.json({ id: application.id, status, updated_at: updatedAt });
  });

  router.post('/api/jobs/:id/apply', auth, roles('fundi'), (req: AuthenticatedRequest, res: Response) => {
    const body = req.body ?? {};
    if (body.message !== undefined && typeof body.message !== 'string') {
      return res.status(400).json({ error: 'Application message must be text.' });
    }
    if (typeof body.message === 'string' && body.message.length > 1000) {
      return res.status(400).json({ error: 'Application message must be 1,000 characters or fewer.' });
    }
    const job = db.prepare("SELECT * FROM jobs WHERE id=? AND status='open'").get(req.params.id) as (Record<string, any> & MatchJob) | undefined;
    if (!job) return res.status(404).json({ error: 'This job is no longer open.' });
    const fundi = db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id) as Record<string, any> | undefined;
    if (!fundi) return res.status(404).json({ error: 'Fundi profile not found.' });
    const publishedRatings = db.prepare(`SELECT AVG(review.rating) AS average
      FROM performance_reviews review
      JOIN assignments assignment
        ON assignment.id=review.assignment_id
        AND assignment.worker_id=review.worker_id
      JOIN users reviewer ON reviewer.id=review.foreman_id
        AND reviewer.role IN ('foreman','administrator')
      WHERE review.worker_id=?
        AND review.status='published'
        AND (
          (reviewer.role='foreman' AND assignment.foreman_id=review.foreman_id)
          OR reviewer.role='administrator'
        )
        AND EXISTS (
          SELECT 1 FROM attendance
          JOIN users verifier ON verifier.id=attendance.verified_by
          WHERE attendance.assignment_id=assignment.id
            AND attendance.worker_id=assignment.worker_id
            AND attendance.foreman_id=assignment.foreman_id
            AND attendance.recorded_by=attendance.verified_by
            AND attendance.verification_status='verified'
            AND (
              (verifier.role='foreman' AND attendance.verified_by=assignment.foreman_id)
              OR verifier.role='administrator'
            )
            AND attendance.status IN ('present','late')
        )
        AND typeof(review.rating)='integer'
        AND review.rating BETWEEN 1 AND 5`).get(fundi.id) as { average: number | null };
    const result = match(job, fundi, publishedRatings.average === null ? undefined : publishedRatings.average);
    if (!result.eligible) {
      return res.status(403).json({ error: 'You do not meet this job’s eligibility requirements.', unmet: result.unmet });
    }
    const applicationId = id();
    const createdAt = now();
    try {
      const create = db.transaction(() => {
        const openJob = db.prepare("SELECT id FROM jobs WHERE id=? AND status='open'").get(job.id);
        if (!openJob) return 'closed' as const;
        const exists = db.prepare('SELECT id FROM applications WHERE job_id=? AND fundi_id=?').get(job.id, req.user!.id);
        if (exists) return 'duplicate' as const;
        db.prepare(`INSERT INTO applications
          (id,job_id,job_title,trade,location,foreman_id,fundi_id,fundi_name,message,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,'submitted',?)`)
          .run(applicationId, job.id, job.title, job.trade, job.location, job.foreman_id, req.user!.id,
            req.user!.name, clean(body.message, 1000), createdAt);
        notify(job.foreman_id, 'New job application', `${req.user!.name} applied for ${job.title}.`);
        audit(req.user!.id, 'job.applied', applicationId, job.title);
        return 'created' as const;
      });
      const result = create();
      if (result === 'closed') return res.status(409).json({ error: 'This job is no longer open.' });
      if (result === 'duplicate') return res.status(409).json({ error: 'You have already applied for this job.' });
      return res.status(201).json({ id: applicationId, status: 'pending' });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error
        && (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')) {
        return res.status(409).json({ error: 'You have already applied for this job.' });
      }
      throw error;
    }
  });

  router.get('/api/fundis', auth, roles('foreman', 'assessor', 'administrator'), (_req: AuthenticatedRequest, res: Response) => {
    const fundis = db.prepare("SELECT id,name,role,trade,location,experience,experience_unit,skills,availability,bio,verification_status,created_at FROM users WHERE role='fundi' ORDER BY created_at DESC").all() as Record<string, any>[];
    return res.json({ fundis: fundis.map((fundi) => ({
      ...fundi,
      experience_unit: fundi.experience_unit || 'years',
      skills: parseSkillList(fundi.skills),
    })) });
  });

  router.post('/api/reviews', auth, roles('foreman', 'administrator'), (req: AuthenticatedRequest, res: Response) => {
    const workerId = clean(req.body.workerId, 100);
    const assignmentId = clean(req.body.assignmentId, 100);
    if (!assignmentId) return res.status(400).json({ error: 'Choose a valid assignment for this review.' });
    const assignment = db.prepare(`SELECT a.id,a.foreman_id,a.worker_id,a.status
      FROM assignments a
      JOIN users u ON u.id=a.worker_id AND u.role='fundi'
      WHERE a.id=? AND a.status<>'cancelled'
        AND EXISTS (
          SELECT 1 FROM attendance
          JOIN users verifier ON verifier.id=attendance.verified_by
          WHERE attendance.assignment_id=a.id
            AND attendance.worker_id=a.worker_id
            AND attendance.foreman_id=a.foreman_id
            AND attendance.recorded_by=attendance.verified_by
            AND attendance.verification_status='verified'
            AND (
              (verifier.role='foreman' AND attendance.verified_by=a.foreman_id)
              OR verifier.role='administrator'
            )
            AND attendance.status IN ('present','late')
        )`).get(assignmentId) as { id: string; foreman_id: string; worker_id: string } | undefined;
    if (!assignment || assignment.worker_id !== workerId
      || (req.user!.role !== 'administrator' && assignment.foreman_id !== req.user!.id)) {
      return res.status(403).json({ error: 'You are not authorized to review this fundi for that assignment.' });
    }
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
    }
    const worker = db.prepare("SELECT id,name FROM users WHERE id=? AND role='fundi'").get(workerId) as { id: string; name: string };
    const reviewId = id();
    const created = db.transaction(() => {
      if (db.prepare('SELECT id FROM performance_reviews WHERE assignment_id=? AND worker_id=?').get(assignment.id, worker.id)) return false;
      db.prepare('INSERT INTO performance_reviews VALUES (?,?,?,?,?,?,?,?)')
        .run(reviewId, worker.id, req.user!.id, assignment.id, rating, clean(req.body.feedback, 1500), 'published', now());
      notify(worker.id, 'New performance review', 'A foreman added feedback to your work history.');
      audit(req.user!.id, 'performance.reviewed', reviewId, worker.name);
      return true;
    }).immediate();
    if (!created) return res.status(409).json({ error: 'A review already exists for this worker and assignment.' });
    return res.status(201).json({ id: reviewId });
  });

  return router;
}
