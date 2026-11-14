import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { installSensitiveRouteRateLimits, resolveRateLimitOptions } from './rate-limiting';

test('sensitive endpoints have configurable, independent per-IP limits and retry headers', async () => {
  const environment = {
    LOGIN_RATE_LIMIT_MAX: '2',
    LOGIN_RATE_LIMIT_WINDOW_MS: '60000',
    REGISTRATION_RATE_LIMIT_MAX: '2',
    REGISTRATION_RATE_LIMIT_WINDOW_MS: '60000',
    PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX: '2',
    PASSWORD_RESET_REQUEST_RATE_LIMIT_WINDOW_MS: '60000',
    PASSWORD_RESET_SUBMIT_RATE_LIMIT_MAX: '2',
    PASSWORD_RESET_SUBMIT_RATE_LIMIT_WINDOW_MS: '60000',
  };
  const app = express();
  installSensitiveRouteRateLimits(app, environment);
  app.use(express.json());
  for (const route of [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
  ]) {
    app.post(route, (_req, res) => res.status(200).json({ ok: true }));
  }
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const route of [
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
    ]) {
      assert.equal((await fetch(`${baseUrl}${route}`, { method: 'GET' })).status, 404);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.equal((await fetch(`${baseUrl}${route}`, { method: 'POST' })).status, 200);
      }
      const limited = await fetch(`${baseUrl}${route}`, { method: 'POST' });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('ratelimit-limit'), '2');
      assert.equal(limited.headers.get('ratelimit-remaining'), '0');
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
    }
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('rate-limit defaults are usable and invalid configuration fails explicitly', () => {
  const defaults = resolveRateLimitOptions({});
  assert.deepEqual(defaults, {
    login: { maximum: 10, windowMs: 900000 },
    registration: { maximum: 5, windowMs: 3600000 },
    'password-reset-request': { maximum: 5, windowMs: 3600000 },
    'password-reset-submit': { maximum: 10, windowMs: 900000 },
  });
  assert.throws(() => resolveRateLimitOptions({ LOGIN_RATE_LIMIT_MAX: '0' }), /LOGIN_RATE_LIMIT_MAX/);
  assert.throws(() => resolveRateLimitOptions({ REGISTRATION_RATE_LIMIT_WINDOW_MS: '1.5' }), /REGISTRATION_RATE_LIMIT_WINDOW_MS/);
});
