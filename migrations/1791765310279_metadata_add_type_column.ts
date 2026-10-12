import { sql, SqliteAdapter, type Kysely, type Transaction } from 'kysely'

async function transaction(db: any, dialect: string, cb: (trx: Transaction<any>) => void) {
	if (dialect === 'sqlite') await db.transaction().execute(cb);
	else await cb(db);
}

export async function up(db: Kysely<any>): Promise<void> {
	const dialect = db.getExecutor().adapter.constructor.name == 'SqliteAdapter' ? 'sqlite' : 'postgres';

	await transaction(db, dialect, async (trx) => {
		await trx.schema.dropIndex('metadata_idx').ifExists().execute();
		await trx.schema.dropTable('metadata').ifExists().execute();

		await trx.schema.createTable('metadata')
			.addColumn('id', 'text', (col) => col.primaryKey())
			.addColumn('imdb_id', 'text', (col) => col.defaultTo(null))
			.addColumn('tvdb_id', 'text', (col) => col.defaultTo(null))
			.addColumn('tmdb_id', 'text', (col) => col.defaultTo(null))
			.addColumn('type', 'text', (col) => col.notNull())
			.addColumn('data', 'jsonb')
			.addColumn('updated_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.addColumn('created_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.execute();

		await trx.schema
			.createIndex('metadata_idx')
			.on('metadata')
			.columns(['id', 'type', 'imdb_id', 'tvdb_id', 'tmdb_id', 'updated_at', 'created_at'])
			.execute();
	});
}

export async function down(db: Kysely<any>): Promise<void> {
	const dialect = db.getExecutor().adapter instanceof SqliteAdapter ? 'sqlite' : 'postgres';

	await transaction(db, dialect, async (trx) => {
		await trx.schema.dropIndex('metadata_idx').ifExists().execute();
		await trx.schema.dropTable('metadata').execute();

		await trx.schema.createTable('metadata')
			.addColumn('id', 'text', (col) => col.primaryKey())
			.addColumn('imdb_id', 'text', (col) => col.defaultTo(null).unique())
			.addColumn('tvdb_id', 'text', (col) => col.defaultTo(null).unique())
			.addColumn('tmdb_id', 'text', (col) => col.defaultTo(null).unique())
			.addColumn('data', 'jsonb')
			.addColumn('updated_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.addColumn('created_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.execute();

		await trx.schema
			.createIndex('metadata_idx')
			.on('metadata')
			.columns(['id', 'imdb_id', 'tvdb_id', 'tmdb_id', 'updated_at', 'created_at'])
			.execute();
	});
}
