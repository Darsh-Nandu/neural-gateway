/**
 * @fileoverview Shared PostgreSQL client using connection pooling.
 *
 * WHY POOLING?
 * Opening a database connection is expensive — it involves TCP handshakes,
 * auth negotiation, etc. A "pool" keeps a set of connections open and ready,
 * handing them out to queries like a library lending books. When your query
 * finishes, the connection goes back to the pool instead of being destroyed.
 *
 * The `pg` library's `Pool` class handles this automatically.
 * We typically want 10–20 connections for an app like this.
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

let pool: Pool | null = null;

/**
 * Returns the singleton Pool instance.
 * Creates it on first call (lazy initialization).
 * All services import this and call db() to get the pool.
 */

export function getDB(): Pool {
    if(!pool) {
        pool =new Pool({
            connectionString: process.env.DATABASE_URL,
            max: 20,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000
        });

        pool.on('connect', () => {
            console.log(`[DB] New connection established to PostgreSQL pool`);
        });

        pool.on('error', (err) => {
            console.log(`[DB] Unexpected error on idle client`, err);
        });
    }
    return pool;    
}

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: any[]
): Promise<T[]> {
  const db = getDB();
  const result: QueryResult<T> = await db.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(sql: string, params?:any[]): Promise<T | null> {
    const rows = await query<T>(sql, params);
    if (rows.length > 1) {
        throw new Error(
            `queryOne returned ${rows.length} rows. Use quer() for multi-row results`
        );
    }
    return rows[0] ?? null;
}

/**
 * Runs multiple queries inside a transaction.
 * If any query throws, ALL changes are rolled back automatically.
 *
 * @example
 * await transaction(async (client) => {
 *   await client.query('INSERT INTO jobs ...', [...]);
 *   await client.query('UPDATE usage ...', [...]);
 * });
 */

export async function transaction<T>(
    fn: (client: PoolClient) => Promise<T>
): Promise<T> {
    const db = getDB();
    const client = await db.connect();
    try {
        client.query('BEGIN');
        const result = await fn(client);
        client.query('COMMIT');
        return result;
    } catch (err) {
        client.query('ROLLBACK');
        throw err;
    } finally {
        client.release()
    }
}

export async function closeDB(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
        console.log(`[DB] PostgreSQL pool closed`);
    }
}
