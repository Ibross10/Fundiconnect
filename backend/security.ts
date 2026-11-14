
const developmentJwtSecret = 'local-development-secret-change-me';

function estimatedSecretEntropy(secret: string): number {
  const frequencies = new Map<string, number>();
  for (const character of secret) {
    frequencies.set(character, (frequencies.get(character) || 0) + 1);
  }
  let entropyPerCharacter = 0;
  for (const count of frequencies.values()) {
    const probability = count / secret.length;
    entropyPerCharacter -= probability * Math.log2(probability);
  }
  return entropyPerCharacter * secret.length;
}

function hasRepeatedPattern(secret: string): boolean {
  for (let period = 1; period <= Math.floor(secret.length / 2); period += 1) {
    if (secret.length % period === 0 && secret === secret.slice(0, period).repeat(secret.length / period)) {
      return true;
    }
  }
  return false;
}

export function resolveJwtSecret(environment: NodeJS.ProcessEnv): string {
  const configuredSecret = environment.JWT_SECRET?.trim();
  if (environment.NODE_ENV === 'development' || environment.NODE_ENV === 'test') {
    return configuredSecret || developmentJwtSecret;
  }
  if (environment.NODE_ENV !== 'production') {
    throw new Error('NODE_ENV must be explicitly set to development, test, or production.');
  }

  const isPlaceholder = configuredSecret
    ? /replace|change.?me|example|placeholder|generate|your.?secret/i.test(configuredSecret)
    : true;
  const isRandomBytesBase64 = configuredSecret
    ? /^[A-Za-z0-9+/]{64}$/.test(configuredSecret)
      && Buffer.from(configuredSecret, 'base64').length === 48
      && Buffer.from(configuredSecret, 'base64').toString('base64') === configuredSecret
    : false;

  if (
    !configuredSecret
    || !isRandomBytesBase64
    || new Set(configuredSecret).size < 16
    || hasRepeatedPattern(configuredSecret)
    || estimatedSecretEntropy(configuredSecret) < 128
    || configuredSecret === developmentJwtSecret
    || isPlaceholder
  ) {
    throw new Error('Production requires a unique JWT_SECRET encoded as 48 cryptographically random bytes in standard Base64; generate it with a cryptographically secure random generator.');
  }

  return configuredSecret;
}

export function resolveClientOrigin(environment: NodeJS.ProcessEnv): string {
  const isProduction = environment.NODE_ENV === 'production';
  const configuredOrigin = environment.CLIENT_ORIGIN?.trim()
    || (isProduction ? environment.RENDER_EXTERNAL_URL?.trim() : '');

  if (!configuredOrigin) {
    if (isProduction) throw new Error('Production requires an explicit HTTPS CLIENT_ORIGIN or RENDER_EXTERNAL_URL.');
    return 'http://localhost:5174';
  }

  let parsed: URL;
  try {
    parsed = new URL(configuredOrigin);
  } catch {
    throw new Error('CLIENT_ORIGIN must be a valid absolute URL origin.');
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.origin !== configuredOrigin.replace(/\/$/, '')
    || parsed.username
    || parsed.password
    || (isProduction && parsed.protocol !== 'https:')
  ) {
    throw new Error(isProduction
      ? 'Production CLIENT_ORIGIN must be an HTTPS origin without a path or credentials.'
      : 'CLIENT_ORIGIN must be an HTTP(S) origin without a path or credentials.');
  }

  return parsed.origin;
}

export function resolvePort(environment: NodeJS.ProcessEnv): number {
  const value = environment.PORT?.trim() || '4000';
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a whole number between 1 and 65535.');
  }
  return port;
}

export function resolveTrustProxy(environment: NodeJS.ProcessEnv): boolean | number | string {
  const value = environment.TRUST_PROXY?.trim();
  if (!value) return false;

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops) || hops < 1) {
      throw new Error('TRUST_PROXY hop count must be a positive whole number.');
    }
    return hops;
  }

  return value;
}

export function isProductionEmailConfigured(environment: NodeJS.ProcessEnv): boolean {
  const gmailUser = environment.GMAIL_USER?.trim();
  const appPassword = environment.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
  const origin = environment.CLIENT_ORIGIN?.trim();

  if (
    environment.EMAIL_PROVIDER !== 'gmail'
    || !gmailUser
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmailUser)
    || !appPassword
    || !/^[A-Za-z0-9]{16}$/.test(appPassword)
    || !origin
    || environment.PASSWORD_RESET_EMAIL_ENABLED !== 'true'
  ) {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:'
      && parsed.origin === origin.replace(/\/$/, '')
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}
