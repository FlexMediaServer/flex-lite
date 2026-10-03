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
			.createTable('progress')
			.addColumn('id', dialect === 'postgres' ? 'serial' : 'integer', (col) =>
				dialect === 'postgres' ? col.primaryKey() : col.autoIncrement().primaryKey(),
			)
			.addColumn('account_id', 'integer')
			.addColumn('guid', 'text', (col) => col.notNull()) //Plex GUID
			.addUniqueConstraint('progress_unique', ['account_id', 'guid'])
			.addColumn('grandparent_guid', 'text') //Plex GUID
			.addColumn('index', 'integer')
			.addColumn('parent_index', 'integer')
			.addColumn('view_count', 'integer')
			.addColumn('view_offset', 'integer')
			.addColumn('last_viewed_at', 'integer')
			.addColumn('updated_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.addColumn('created_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.execute();

		await trx.schema
			.createIndex('progress_idx')
			.on('progress')
			.columns(['account_id', 'guid', 'grandparent_guid', 'index', 'parent_index', 'last_viewed_at'])
			.execute();

		await trx.schema
			.createTable('item_mappings')
			.addColumn('guid', 'text', (col) => col.primaryKey() )
			.addColumn('item_id', 'text', (col) => col.notNull()) //Plex local ID
			.addColumn('url', 'text', (col) => col.notNull().unique()) //Source URL of media
			.addUniqueConstraint('mapping_unique', ['guid', 'item_id', 'url'])
			.execute();

		await trx.schema
			.createIndex('item_mappings_idx')
			.on('item_mappings')
			.columns(['guid', 'item_id', 'url'])
			.execute();

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
			.execute()


		await trx.schema
			.createIndex('metadata_idx')
			.on('metadata')
			.columns(['id', 'imdb_id', 'tvdb_id', 'tmdb_id', 'updated_at', 'created_at'])
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
			.columns(['id', 'playbackSessionId'])
			.execute();
	})
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
	const dialect = db.getExecutor().adapter instanceof SqliteAdapter ? 'sqlite' : 'postgres';
	await transaction(db, dialect, async (trx) => {
		await trx.schema.dropTable('item_mappings').execute();
		await trx.schema.dropIndex('item_mappings_idx').execute();
		await trx.schema.dropTable('item_mappings').execute();
		await trx.schema.dropIndex('item_mappings_idx').execute();
		await trx.schema.dropTable('metadata').execute();
		await trx.schema.dropIndex('metadata_idx').execute();
		await trx.schema.dropTable('play_queues').execute();
		await trx.schema.dropIndex('play_queues_idx').execute();
	});
}
