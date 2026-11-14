import { isProductionEmailConfigured } from './security';

export async function sendPasswordResetEmail(
  environment: NodeJS.ProcessEnv,
  email: string,
  link: string,
  fetcher: typeof fetch = fetch,
) {
  if (!isProductionEmailConfigured(environment)) {
    throw new Error('Production password-reset email is not configured.');
  }
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${environment.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: environment.EMAIL_FROM,
      to: [email],
      subject: 'Reset your FundiConnect password',
      text: `Use this link to reset your password. It expires in 30 minutes:\n\n${link}`,
    }),
  });
  if (!response.ok) throw new Error('Password reset email provider rejected the request.');
}
