import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db } from './db.js';

const schemaPath = resolve(process.cwd(), 'database/schema.sql');
const schema = await readFile(schemaPath, 'utf8');

try {
  await db.query(schema);
  console.log('Attendra database schema is up to date.');
} finally {
  await db.end();
}
