import { describe, expect, it } from 'vitest';
import type { Metadata } from '../dto/Metadata.entity.js';
import { rewriteSession } from './sessions.js';

//The Now Playing entry Plex reports for a Flex item: a Plex-ingested clip under the owner
const plexSession = {
	ratingKey: '117',
	key: '/library/metadata/117',
	title: 'Half Loop',
	type: 'clip',
	librarySectionID: '-3',
	sessionKey: '3',
	viewOffset: 164000,
	Media: [{ id: '138', videoCodec: 'h264' }],
	User: { id: 1, title: 'blake0201', thumb: 'owner.png' },
	Player: { title: 'KoWindows', playbackSessionId: 'fa9ebdb5' },
	Session: { id: '5m86okf1pp1veafz59w25vbv', location: 'wan' },
};

const flexItem = {
	ratingKey: '68ec89c449b9526d4b7250a3',
	key: '/library/metadata/68ec89c449b9526d4b7250a3',
	title: 'Half Loop',
	type: 'episode',
	grandparentTitle: 'Severance',
	librarySectionID: 2,
	librarySectionTitle: 'TV Shows',
} as unknown as Metadata;

describe('rewriteSession', () => {
	it('shows Flex\'s item with the real viewer and Plex\'s playback state', () => {
		const rewritten = rewriteSession(plexSession, flexItem, { id: 7, title: 'Sam', thumb: 'sam.png' });

		expect(rewritten).toMatchObject({
			ratingKey: '68ec89c449b9526d4b7250a3',
			type: 'episode',
			grandparentTitle: 'Severance (Virtual)',
			librarySectionID: 2,
			sessionKey: '3',
			viewOffset: 164000,
			Player: plexSession.Player,
			Session: plexSession.Session,
			User: { id: 7, title: 'Sam', thumb: 'sam.png' },
		});
	});

	it('labels a virtual movie by its own title', () => {
		const movie = { ratingKey: '5d9c0000000000000000aa02', title: 'Heat', type: 'movie', librarySectionID: 1 } as unknown as Metadata;

		expect(rewriteSession(plexSession, movie, undefined)).toMatchObject({ title: 'Heat (Virtual)', type: 'movie' });
	});

	it('keeps Plex\'s user when no viewer was recorded', () => {
		expect(rewriteSession(plexSession, flexItem, undefined).User).toEqual(plexSession.User);
	});

	it('leaves sessions for items Flex does not map untouched', () => {
		expect(rewriteSession(plexSession, undefined, { id: 7, title: 'Sam' })).toBe(plexSession);
	});
});
