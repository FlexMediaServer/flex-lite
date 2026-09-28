import type { ColumnType } from 'kysely';

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;

export interface ItemMappings {
	guid: string;
	item_id: string;
}

export interface PlayQueues {
	id: Generated<number>;
	playbackSessionId: string;
	currentItem: string;
	items: string | JSON;
	updated_at: Generated<number | null>;
	created_at: Generated<number | null>;
}

export interface DB {
	item_mappings: ItemMappings;
	play_queues: PlayQueues;
}
