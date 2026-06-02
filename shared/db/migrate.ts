/**
 * @fileoverview Migration runner.
 * Reads SQL files from migrations/ in order and applies them.
 * Tracks which migrations have already run in a `_migrations` table
 * so it's safe to run multiple times (idempotent).
 *
 * Usage: npm run migrate
 */

import * as fs from "fs";
import * as path from 'path';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, "../../.env")});

async function runMigrations(): Promise<void> {
    const pool = new Pool({connectionString: process.env.DATABASE_URL});
    console.log(`[Migration] Connecting to PostgreSQL...`);
    // Create migrations tracking table if it doesn't exist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL      PRIMARY KEY,
        filename   TEXT        NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);

    // Read all .sql files in order
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        // Check if already applied
        const existing = await pool.query(
            `SELECT id FROM _migrations WHERE filenmae = $1`,
            [file]
        );

        if (existing.rows.length > 0) {
            console.log(`[Migration] Skipping ${file} (already applied)`);
            continue;
        }

        console.log(`[Migration] Applying ${file}...`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
            await client.query('COMMIT');
            console.log(`[Migration] ✓ ${file} applied successfully`);
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[Migration] ✗ Failed to apply ${file}:`, err);
            process.exit(1);
        } finally {
            client.release();
        }
    }

    await pool.end();
    console.log(`[Migration] ALL migrations complete ✓`);
}

runMigrations().catch((err) => {
    console.error(`[Migration] Unexpected error:`, err);
    process.exit(1);
});
