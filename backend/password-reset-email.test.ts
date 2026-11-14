
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  sendPasswordResetEmail,
  type PasswordResetMailMessage,
} from './password-reset-email';

const providerEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  EMAIL_PROVIDER: 'gmail',
  GMAIL_USER: 'sender@example.test',
  GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
  CLIENT_ORIGIN: 'https://fundiconnect.example.test',
  PASSWORD_RESET_EMAIL_ENABLED: 'true',
};

test('Gmail receives the configured password-reset email', async () => {
  let sentMessage: PasswordResetMailMessage | undefined;

  const sendMail = async (message: PasswordResetMailMessage) => {
    sentMessage = message;
  };

  await sendPasswordResetEmail(
    providerEnvironment,
    'worker@example.test',
    'https://fundiconnect.example.test/?resetToken=opaque-test-token',
    sendMail,
  );

  assert.ok(sentMessage);
  assert.equal(sentMessage.from, 'FundiConnect <sender@example.test>');
  assert.equal(sentMessage.to, 'worker@example.test');
  assert.equal(sentMessage.subject, 'Reset your FundiConnect password');
  assert.match(sentMessage.text, /opaque-test-token/);
  assert.match(sentMessage.text, /30 minutes/);
});

test('unconfigured email delivery is rejected without sending', async () => {
  let called = false;

  const sendMail = async () => {
    called = true;
  };

  await assert.rejects(
    sendPasswordResetEmail(
      {
        ...providerEnvironment,
        PASSWORD_RESET_EMAIL_ENABLED: 'false',
      },
      'worker@example.test',
      'https://example.test/reset',
      sendMail,
    ),
    /not configured/,
  );

  assert.equal(called, false);
});

test('SMTP delivery errors are reported to the caller', async () => {
  const sendMail = async () => {
    throw new Error('SMTP provider rejected the request.');
  };

  await assert.rejects(
    sendPasswordResetEmail(
      providerEnvironment,
      'worker@example.test',
      'https://example.test/reset',
      sendMail,
    ),
    /SMTP provider rejected/,
  );
});
