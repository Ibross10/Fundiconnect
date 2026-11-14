import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getSchemaVersion, migrateDatabase } from './migrations';

const file = process.env.DATABASE_FILE || './data/fundiconnect.sqlite';
export const databaseFile = path.resolve(file);
fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

export const db = new Database(databaseFile);
db.pragma('journal_mode = WAL');
export const schemaVersion = migrateDatabase(db);

export { getSchemaVersion };
