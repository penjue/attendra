import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
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

  if (process.env.ATTENDRA_STAGING_COMPANY_INIT === 'true') {
    const url = new URL(process.env.DATABASE_URL ?? '');
    const expectedHost = 'dpg-dbajptdg1s2s73ccn61g-a';
    const hostMatches = url.hostname === expectedHost || url.hostname.startsWith(expectedHost + '.');
    const databaseMatches = decodeURIComponent(url.pathname.slice(1)) === 'attendra_staging_db';
    if (!hostMatches || !databaseMatches) {
      throw new Error('Refusing staging company initialization: DATABASE_URL is not the approved staging database.');
    }

    const companyName = 'Attendra Staging Test';
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(847362910)');
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM companies WHERE name = $1 ORDER BY created_at LIMIT 1',
        [companyName]
      );
      let companyId = existing.rows[0]?.id;
      if (!companyId) {
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO companies (name, country_code, timezone, currency) VALUES ($1, 'KE', 'Africa/Nairobi', 'KES') RETURNING id",
          [companyName]
        );
        companyId = inserted.rows[0]?.id;
      }
      await client.query('COMMIT');
      console.log('Staging company initialized. ADMIN_COMPANY_ID=' + companyId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  console.log('Attendra database schema is up to date.');
} finally {
  await db.end();
}
