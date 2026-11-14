import 'dotenv/config';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { z } from 'zod';

const credentialsSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(100, 'Name must be at most 100 characters.'),
  email: z.string().trim().max(160, 'Email must be at most 160 characters.').email('Enter a valid email address.'),
  password: z.string()
    .min(12, 'Password must be at least 12 characters.')
    .max(200, 'Password must be at most 200 characters.')
    .refine((value) => new Set(value).size >= 8, 'Password must contain at least 8 different characters.'),
});

export type AdministratorCredentials = z.infer<typeof credentialsSchema>;

export class BootstrapInputError extends Error {}

export async function bootstrapAdministrator(db: Database.Database, input: AdministratorCredentials) {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) throw new BootstrapInputError(parsed.error.issues[0]?.message || 'Invalid administrator details.');

  const name = parsed.data.name;
  const email = parsed.data.email.toLowerCase();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const accountId = randomUUID();
  const createdAt = new Date().toISOString();

  const createAdministrator = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM users WHERE role='administrator' LIMIT 1").get()) {
      throw new BootstrapInputError('An administrator already exists; bootstrap is available only once.');
    }
    if (db.prepare('SELECT 1 FROM users WHERE email=? LIMIT 1').get(email)) {
      throw new BootstrapInputError('An account with this email already exists.');
    }

    db.prepare(`INSERT INTO users
      (id,name,email,password_hash,role,verification_status,created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(accountId, name, email, passwordHash, 'administrator', 'pending', createdAt);
    db.prepare('INSERT INTO audit_logs (id,user_id,action,target,details,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), accountId, 'account.created', accountId, 'administrator', createdAt);
  });

  createAdministrator.immediate();
  return { id: accountId, name, email, role: 'administrator' as const, verification_status: 'pending' as const };
}

async function promptHidden(label: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Run administrator bootstrap from an interactive terminal.');
  }

  stdout.write(label);
  stdin.setEncoding('utf8');
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('Prompt cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          const characters = Array.from(value);
          if (characters.length) {
            characters.pop();
            value = characters.join('');
            stdout.write('\b \b');
          }
          continue;
        }
        if (character >= ' ' && character !== '\u007f') {
          value += character;
          stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function promptCredentials(): Promise<AdministratorCredentials> {
  const prompt = createInterface({ input: stdin, output: stdout });
  let name: string;
  let email: string;
  try {
    name = await prompt.question('Administrator name: ');
    email = await prompt.question('Administrator email: ');
  } finally {
    prompt.close();
  }

  const password = await promptHidden('Password (input hidden): ');
  const confirmation = await promptHidden('Confirm password (input hidden): ');
  if (password !== confirmation) throw new BootstrapInputError('Passwords do not match.');
  return { name, email, password };
}

async function main() {
  const databaseFile = path.resolve(process.env.DATABASE_FILE || './data/fundiconnect.sqlite');
  if (!fs.existsSync(databaseFile)) {
    throw new Error('The configured database file does not exist; bootstrap will not create or migrate a database.');
  }

  const db = new Database(databaseFile, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    if (db.prepare("SELECT 1 FROM users WHERE role='administrator' LIMIT 1").get()) {
      throw new BootstrapInputError('An administrator already exists; bootstrap is available only once.');
    }
    const credentials = await promptCredentials();
    await bootstrapAdministrator(db, credentials);
    stdout.write('Administrator account created successfully.\n');
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    if (error instanceof BootstrapInputError) {
      stdout.write(`${error.message}\n`);
    } else {
      stdout.write('Administrator bootstrap failed. No credentials were displayed.\n');
    }
    process.exitCode = 1;
  });
}
