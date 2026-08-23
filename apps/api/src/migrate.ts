import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const schemaPath = resolve(repoRoot, 'database/schema.sql');
const seedPath = resolve(repoRoot, 'database/demo_seed.sql');

try {
  const schema = await readFile(schemaPath, 'utf8');
  await db.query(schema);

  if (process.env.ATTENDRA_DEMO_SEED === 'true') {
    const seed = await readFile(seedPath, 'utf8');
    await db.query(seed);
    console.log('Attendra demo data is up to date.');
  }

  console.log('Attendra database schema is up to date.');
} finally {
  await db.end();
}
