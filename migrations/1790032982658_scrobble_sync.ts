import { sql, SqliteAdapter, type Kysely, type Transaction } from 'kysely'

async function transaction(db: any, dialect: string, cb: (trx: Transaction<any>) => void) {
	if (dialect === 'sqlite') await db.transaction().execute(cb);
	else await cb(db);
}

export async function up(db: Kysely<any>): Promise<void> {
	const dialect = db.getExecutor().adapter.constructor.name == 'SqliteAdapter' ? 'sqlite' : 'postgres';

	await transaction(db, dialect, async (trx) => {
		await trx.schema.createTable('scrobble_sync')
			.addColumn('account_id', 'integer', (col) => col.primaryKey())
			.addColumn('viewed_at', 'integer') //Watermark: highest scrobble viewedAt (seconds) already ingested
			.addColumn('cursor', 'text')
			.addColumn('updated_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.execute();

		await trx.schema
			.createIndex('scrobble_sync_idx')
			.on('progress')
			.columns(['account_id', 'viewed_at', 'cursor', 'updated_at'])
			.execute();
	})
}

export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable('scrobble_sync').execute();
	await db.schema.dropIndex('scrobble_sync_idx').execute();
}
