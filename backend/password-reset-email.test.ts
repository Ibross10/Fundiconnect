import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendPasswordResetEmail } from './password-reset-email';

const providerEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 'test-provider-key',
  EMAIL_FROM: 'FundiConnect <security@example.test>',
  CLIENT_ORIGIN: 'https://fundiconnect.example.test',
  PASSWORD_RESET_EMAIL_ENABLED: 'true',
};

test('Resend receives configured password-reset email and accepted delivery is not overstated', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(null, { status: 202 });
  };
  await sendPasswordResetEmail(
    providerEnvironment,
    'worker@example.test',
    'https://fundiconnect.example.test/?resetToken=opaque-test-token',
    fetcher,
  );
  assert.equal(requestUrl, 'https://api.resend.com/emails');
  assert.equal(requestInit?.method, 'POST');
  assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer test-provider-key');
  const message = JSON.parse(String(requestInit?.body)) as { from: string; to: string[]; text: string };
  assert.equal(message.from, providerEnvironment.EMAIL_FROM);
  assert.deepEqual(message.to, ['worker@example.test']);
  assert.match(message.text, /opaque-test-token/);
});

test('unconfigured or rejected email delivery never reports provider success', async () => {
  let called = false;
  const fetcher: typeof fetch = async () => {
    called = true;
    return new Response('provider error', { status: 503 });
  };
  await assert.rejects(
    sendPasswordResetEmail({ ...providerEnvironment, PASSWORD_RESET_EMAIL_ENABLED: 'false' }, 'worker@example.test', 'https://example.test/reset', fetcher),
    /not configured/,
  );
  assert.equal(called, false);
  await assert.rejects(
    sendPasswordResetEmail(providerEnvironment, 'worker@example.test', 'https://example.test/reset', fetcher),
    /provider rejected/,
  );
});
