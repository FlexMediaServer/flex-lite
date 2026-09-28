export class PlayQueuesQuery {
	/* library path for target queue items */
	uri: string;
	key?: string;
	'x-plex-playback-session-id': string;
	
	/* Play queue options */
	type?: 'video' | 'audio' | 'photo';
	shuffle?: 0 | 1;
	repeat?: 0 | 1;
	continuous?: 0 | 1;
	extrasPrefixCount?: number;
	recursive?: 0 | 1;
	onDeck?: 0 | 1;
	
	/* Client identification */
	clientIdentifier?: string;
	accountId?: number;
}
