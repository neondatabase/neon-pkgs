import "dotenv/config";

import { Pool } from "@neondatabase/serverless";

const pool = new Pool({ connectionString: required("DATABASE_URL") });

try {
	await pool.query(`
    CREATE TABLE IF NOT EXISTS neon_live_todos (
      id serial PRIMARY KEY,
      title text NOT NULL,
      status text NOT NULL CHECK (status IN ('active', 'completed'))
    )
  `);
	await pool.query("ALTER TABLE neon_live_todos REPLICA IDENTITY FULL");
	await pool.query(`
    INSERT INTO neon_live_todos (title, status)
    SELECT 'Open this app in another tab', 'active'
    WHERE NOT EXISTS (SELECT 1 FROM neon_live_todos)
  `);
	console.log("Todo table is ready.");
} finally {
	await pool.end();
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}
