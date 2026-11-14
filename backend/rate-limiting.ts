import type { Express, NextFunction, Request, Response } from 'express';

type LimitOptions = { maximum: number; windowMs: number };
type RateLimitEnvironment = NodeJS.ProcessEnv;
type RateLimitCategory = 'login' | 'registration' | 'password-reset-request' | 'password-reset-submit';

const defaults: Record<RateLimitCategory, LimitOptions> = {
  login: { maximum: 10, windowMs: 15 * 60 * 1000 },
  registration: { maximum: 5, windowMs: 60 * 60 * 1000 },
  'password-reset-request': { maximum: 5, windowMs: 60 * 60 * 1000 },
  'password-reset-submit': { maximum: 10, windowMs: 15 * 60 * 1000 },
};

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive whole number.`);
  }
  return parsed;
}

export function resolveRateLimitOptions(environment: RateLimitEnvironment): Record<RateLimitCategory, LimitOptions> {
  return {
    login: {
      maximum: positiveInteger(environment.LOGIN_RATE_LIMIT_MAX, defaults.login.maximum, 'LOGIN_RATE_LIMIT_MAX'),
      windowMs: positiveInteger(environment.LOGIN_RATE_LIMIT_WINDOW_MS, defaults.login.windowMs, 'LOGIN_RATE_LIMIT_WINDOW_MS'),
    },
    registration: {
      maximum: positiveInteger(environment.REGISTRATION_RATE_LIMIT_MAX, defaults.registration.maximum, 'REGISTRATION_RATE_LIMIT_MAX'),
      windowMs: positiveInteger(environment.REGISTRATION_RATE_LIMIT_WINDOW_MS, defaults.registration.windowMs, 'REGISTRATION_RATE_LIMIT_WINDOW_MS'),
    },
    'password-reset-request': {
      maximum: positiveInteger(environment.PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX, defaults['password-reset-request'].maximum, 'PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX'),
      windowMs: positiveInteger(environment.PASSWORD_RESET_REQUEST_RATE_LIMIT_WINDOW_MS, defaults['password-reset-request'].windowMs, 'PASSWORD_RESET_REQUEST_RATE_LIMIT_WINDOW_MS'),
    },
    'password-reset-submit': {
      maximum: positiveInteger(environment.PASSWORD_RESET_SUBMIT_RATE_LIMIT_MAX, defaults['password-reset-submit'].maximum, 'PASSWORD_RESET_SUBMIT_RATE_LIMIT_MAX'),
      windowMs: positiveInteger(environment.PASSWORD_RESET_SUBMIT_RATE_LIMIT_WINDOW_MS, defaults['password-reset-submit'].windowMs, 'PASSWORD_RESET_SUBMIT_RATE_LIMIT_WINDOW_MS'),
    },
  };
}

function createRateLimiter(options: LimitOptions, clock: () => number = Date.now) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let requestsSinceCleanup = 0;

  return (req: Request, res: Response, next: NextFunction) => {
    const now = clock();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup >= 512 || buckets.size > 10_000) {
      for (const [address, entry] of buckets) {
        if (entry.resetAt <= now) buckets.delete(address);
      }
      requestsSinceCleanup = 0;
    }

    const remaining = Math.max(0, options.maximum - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.set({
      'RateLimit-Limit': String(options.maximum),
      'RateLimit-Remaining': String(remaining),
      'RateLimit-Reset': String(resetSeconds),
      'Cache-Control': 'no-store',
    });
    if (bucket.count > options.maximum) {
      res.set('Retry-After', String(resetSeconds));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    return next();
  };
}

function categoryFor(method: string, pathname: string): RateLimitCategory | undefined {
  if (method !== 'POST') return undefined;
  if (pathname === '/api/auth/login') return 'login';
  if (pathname === '/api/auth/register') return 'registration';
  if (pathname === '/api/auth/forgot-password') return 'password-reset-request';
  if (pathname === '/api/auth/reset-password') return 'password-reset-submit';
  return undefined;
}

export function installSensitiveRouteRateLimits(app: Express, environment: RateLimitEnvironment) {
  const options = resolveRateLimitOptions(environment);
  const limiters = Object.fromEntries(
    Object.entries(options).map(([category, config]) => [category, createRateLimiter(config)]),
  ) as Record<RateLimitCategory, ReturnType<typeof createRateLimiter>>;

  app.use((req, res, next) => {
    const category = categoryFor(req.method, req.path);
    if (!category) return next();
    return limiters[category](req, res, next);
  });
}
