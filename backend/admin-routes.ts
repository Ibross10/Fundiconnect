import { Router, type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';

type Role = 'fundi' | 'foreman' | 'assessor' | 'administrator';
type AuthenticatedRequest = Request & { user?: { id: string; role: Role; name: string; email: string } };
type Dependencies = {
  db: Database.Database;
  auth: (req: AuthenticatedRequest, res: Response, next: NextFunction) => unknown;
  roles: (...allowed: Role[]) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => unknown;
  clean: (value: unknown, max?: number) => string;
  id: () => string;
  now: () => string;
  hashPassword: (password: string) => Promise<string>;
  audit: (userId: string, action: string, target: string, details?: string) => void;
};

export function installAdminRoutes({ db, auth, roles, clean, id, now, hashPassword, audit }: Dependencies) {
  const router = Router();

  router.post('/api/admin/assessors', auth, roles('administrator'), async (req: AuthenticatedRequest, res: Response) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Provide assessor details as a JSON object.' });
    }
    const body = req.body as Record<string, unknown>;
    const name = typeof body.name === 'string' ? clean(body.name, 100) : '';
    const email = typeof body.email === 'string' ? clean(body.email, 160).toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (Object.keys(body).some((key) => !['name', 'email', 'password'].includes(key))
      || !name || name.length > 100
      || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 160
      || password.length < 12 || password.length > 200) {
      return res.status(400).json({ error: 'Provide a name, valid email and initial password between 12 and 200 characters.' });
    }

    const passwordHash = await hashPassword(password);
    const created = db.transaction(() => {
      if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return null;
      const assessor = { id: id(), name, email, password_hash: passwordHash, role: 'assessor' as const, created_at: now() };
      db.prepare(`INSERT INTO users (id,name,email,password_hash,role,created_at)
        VALUES (@id,@name,@email,@password_hash,@role,@created_at)`).run(assessor);
      audit(req.user!.id, 'assessor.provisioned', assessor.id, email);
      return { id: assessor.id, name: assessor.name, email: assessor.email, role: assessor.role, created_at: assessor.created_at };
    }).immediate();

    if (!created) return res.status(409).json({ error: 'An account with this email already exists.' });
    return res.status(201).json({ assessor: created });
  });

  return router;
}
