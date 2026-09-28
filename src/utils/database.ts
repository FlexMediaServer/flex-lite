import Keyv from "keyv";
import Database from 'better-sqlite3';
import { Kysely, ParseJSONResultsPlugin, PostgresDialect, SqliteDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from "./db.js";

let dialect;
if (process.env.DATABASE_URL?.startsWith('postgresql://')) {
	dialect = new PostgresDialect({
		pool: new Pool({
			connectionString: process.env.DATABASE_URL,
			max: 10,
		}),
	});
} else {
	const fileName = process.env.DATABASE_URL?.startsWith('sqlite://') ? process.env.DATABASE_URL.replace('sqlite://', '') : 'db.sqlite';
	dialect = new SqliteDialect({
		database: async () => new Database(fileName),
	});
}
export const isSqlite: boolean = dialect instanceof SqliteDialect;

export const db = new Kysely<DB>({
	dialect,
	plugins: [new ParseJSONResultsPlugin()].filter((plugin) => {
		return plugin;
	}),
});

export const cache = new Keyv();