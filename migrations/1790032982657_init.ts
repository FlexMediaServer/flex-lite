import { sql, SqliteAdapter, type Kysely, type Transaction } from 'kysely'

async function transaction(db: any, dialect: string, cb: (trx: Transaction<any>) => void) {
	if (dialect === 'sqlite') await db.transaction().execute(cb);
	else await cb(db);
}


// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
	const dialect = db.getExecutor().adapter.constructor.name == 'SqliteAdapter' ? 'sqlite' : 'postgres';

	await transaction(db, dialect, async (trx) => {
		await trx.schema
			.createTable('item_mappings')
			.addColumn('guid', 'text', (col) => col.primaryKey() )
			.addColumn('item_id', 'text', (col) => col.notNull()) //Plex local ID
			.execute();

		await trx.schema
			.createIndex('item_mappings_idx')
			.on('item_mappings')
			.columns(['guid', 'item_id'])
			.execute();

		await trx.schema.createTable('play_queues')
			.addColumn('id', 'integer', (col) =>
				col.primaryKey().defaultTo(dialect === 'postgres' ? sql`((random() * 2147483647)::int)` : sql`(random() & 2147483647)`)
			)
			.addColumn('playbackSessionId', 'text', (col) => col.notNull()) //User ID
			.addColumn('currentItem', 'text', (col) => col.notNull()) //GUID of the currently playing item
			.addColumn('item', 'text', (col) => col.notNull()) //Show or movie Plex GUID (plex://show/<id> | plex://movie/<id>)
			.addColumn('offset', 'integer', (col) => col.notNull().defaultTo(0)) //Internal, client-invisible offset into the episode list
			.addColumn('updated_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.addColumn('created_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.execute()

		await trx.schema
			.createIndex('play_queues_idx')
			.on('play_queues')
			.columns(['id', 'playbackSessionId', 'currentItem'])
			.execute();
	})
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
	const dialect = db.getExecutor().adapter instanceof SqliteAdapter ? 'sqlite' : 'postgres';
	await transaction(db, dialect, async (trx) => {
		await trx.schema.dropTable('item_mappings').execute();
		await trx.schema.dropIndex('item_mappings_idx').execute();
		await trx.schema.dropTable('play_queues').execute();
		await trx.schema.dropIndex('play_queues_idx').execute();
	});
}
