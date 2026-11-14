
import nodemailer from 'nodemailer';
import { isProductionEmailConfigured } from './security';

export type PasswordResetMailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

type SendMail = (message: PasswordResetMailMessage) => Promise<unknown>;

export async function sendPasswordResetEmail(
  environment: NodeJS.ProcessEnv,
  email: string,
  link: string,
  sendMail?: SendMail,
) {
  if (!isProductionEmailConfigured(environment)) {
    throw new Error('Production password-reset email is not configured.');
  }

  const gmailUser = environment.GMAIL_USER!.trim();
  const appPassword = environment.GMAIL_APP_PASSWORD!.replace(/\s/g, '');

  const deliver = sendMail ?? (async (message: PasswordResetMailMessage) => {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: appPassword,
      },
    });

    await transporter.sendMail(message);
  });

  await deliver({
    from: `FundiConnect <${gmailUser}>`,
    to: email,
    subject: 'Reset your FundiConnect password',
    text: `We received a request to reset your FundiConnect password.

Use the link below to choose a new password. This link expires in 30 minutes and can only be used once.

${link}

If you did not request this change, you can ignore this email.`,
  });
}
