import Keyv from "keyv";
import Database from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
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
});

//Keyv only drops an expired entry when that key is read again, so a plain Map grows with every key ever cached.
//This store evicts the least recently used entry once it is full.
class BoundedMap<K, V> extends Map<K, V> {
	constructor(private readonly maxSize: number) {
		super();
	}

	get(key: K): V | undefined {
		if (!super.has(key)) return undefined;

		const value = super.get(key) as V;
		super.delete(key);
		super.set(key, value);
		return value;
	}

	set(key: K, value: V): this {
		super.delete(key);
		super.set(key, value);
		if (this.size > this.maxSize) super.delete(this.keys().next().value as K);
		return this;
	}
}

export const cache = new Keyv({ store: new BoundedMap(1000) });