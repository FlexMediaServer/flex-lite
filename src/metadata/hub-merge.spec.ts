import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Hub } from '../dto/Hub.entity.js';
import type { Metadata } from '../dto/Metadata.entity.js';
import { mergeContinueWatching, mergeHubs, mergeSearch, uniqueByGuid, withoutItems } from './hub-merge.js';

const item = (guid: string, extra: Partial<Metadata> = {}) => ({ guid, ratingKey: guid, type: 'movie', ...extra }) as Metadata;
const hub = (hubIdentifier: string, type: Hub['type'], Metadata: Metadata[]) =>
	new Hub({ hubIdentifier, type, hubKey: '', key: '', title: hubIdentifier, more: false, Metadata });

describe('uniqueByGuid', () => {
	it('keeps the first copy of each guid', () => {
		expect(uniqueByGuid([item('a', { title: 'plex' }), item('a', { title: 'flex' })])).toEqual([item('a', { title: 'plex' })]);
	});
});

describe('withoutItems', () => {
	it('accepts a hub straight from Plex JSON, which carries a size field', () => {
		const fromPlex = { hubIdentifier: 'show', type: 'show', size: 2, Metadata: [item('a', { librarySectionID: 5 }), item('b', { librarySectionID: 2 })] } as unknown as Hub;

		expect(withoutItems([fromPlex], (i) => i.librarySectionID === 2)[0].Metadata?.map((i) => i.guid)).toEqual(['a']);
	});

	it('drops items and hubs left empty', () => {
		const hubs = withoutItems([hub('h1', 'movie', [item('a', { librarySectionID: 1 }), item('b', { librarySectionID: 3 })]), hub('h2', 'movie', [item('c', { librarySectionID: 1 })])], (i) => i.librarySectionID === 1);

		expect(hubs.map((h) => h.Metadata?.map((i) => i.guid))).toEqual([['b']]);
	});
});

describe('mergeHubs', () => {
	it('puts upstream first and joins hubs sharing an identifier', () => {
		const merged = mergeHubs([hub('up', 'movie', [item('a')])], [hub('flex', 'show', [item('b')]), hub('up', 'movie', [item('a'), item('c')])]);

		expect(merged.map((h) => h.hubIdentifier)).toEqual(['up', 'flex']);
		expect(merged[0].Metadata?.map((i) => i.guid)).toEqual(['a', 'c']);
	});
});

describe('mergeContinueWatching', () => {
	it('orders by last viewed time across Plex and Flex, deduped by guid', () => {
		const plex = [item('a', { lastViewedAt: 100 })];
		const flex = [item('b', { lastViewedAt: 300 }), item('a', { lastViewedAt: 50 })];

		expect(mergeContinueWatching(plex, flex).map((i) => [i.guid, i.lastViewedAt])).toEqual([
			['b', 300],
			['a', 100],
		]);
	});
});

describe('mergeSearch', () => {
	it('appends results to the upstream hub of the same kind, or adds a hub', () => {
		const merged = mergeSearch([hub('movies', 'movie', [item('a')])], [item('b'), item('s', { type: 'show' })]);

		expect(merged.map((h) => [h.hubIdentifier, h.Metadata?.map((i) => i.guid)])).toEqual([
			['movies', ['a', 'b']],
			['flex.search.show', ['s']],
		]);
	});

	it('keeps the upstream copy and the Flex copy of the same show, one per library', () => {
		const merged = mergeSearch([hub('shows', 'show', [item('a', { type: 'show', librarySectionID: 5 })])], [item('a', { type: 'show', librarySectionID: 2 })]);

		expect(merged[0].Metadata?.map((i) => i.librarySectionID)).toEqual([5, 2]);
	});
});
