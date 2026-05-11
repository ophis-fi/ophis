import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

export const sql = postgres(databaseUrl, { max: 10, idle_timeout: 30 });
export const db = drizzle(sql, { schema });
export { schema };
