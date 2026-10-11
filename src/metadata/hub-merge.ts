import { Hub } from '../dto/Hub.entity.js';
import type { Metadata } from '../dto/Metadata.entity.js';

//Keeps the first copy of each item. Callers pass the Plex copy first, since Plex plays it directly.
export function uniqueByGuid(items: Metadata[]): Metadata[] {
	const seen = new Set<string>();

	return items.filter((item) => {
		const key = item.guid ?? item.ratingKey;
		if (seen.has(key)) return false;

		seen.add(key);
		return true;
	});
}

export function withoutItems(hubs: Hub[], drop: (item: Metadata) => boolean): Hub[] {
	return hubs.flatMap((hub) => {
		const Metadata = hub.Metadata?.filter((item) => !drop(item));
		return Metadata?.length === 0 ? [] : [new Hub({ ...hub, Metadata })];
	});
}

//Upstream hubs first. A Flex hub joins the upstream hub with the same identifier, or is appended.
export function mergeHubs(upstream: Hub[], flex: Hub[]): Hub[] {
	const merged = new Map<string, Hub>();

	for (const hub of [...upstream, ...flex]) {
		const existing = merged.get(hub.hubIdentifier);
		merged.set(
			hub.hubIdentifier,
			existing ? new Hub({ ...existing, Metadata: uniqueByGuid([...(existing.Metadata ?? []), ...(hub.Metadata ?? [])]) }) : hub,
		);
	}

	return [...merged.values()];
}

//Continue Watching is one timeline: most recently viewed first
export function mergeContinueWatching(plex: Metadata[], flex: Metadata[], limit = 20): Metadata[] {
	return uniqueByGuid([...plex, ...flex])
		.sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0))
		.slice(0, limit);
}

//Search results join the upstream hub of the same kind, or get a hub of their own.
//Upstream and Flex copies of one show are both kept: each sits in its own library.
export function mergeSearch(upstream: Hub[], results: Metadata[]): Hub[] {
	const hubs = [...upstream];

	for (const type of ['movie', 'show'] as const) {
		const items = uniqueByGuid(results.filter((item) => (item.type === 'movie' ? 'movie' : 'show') === type));
		if (!items.length) continue;

		const index = hubs.findIndex((hub) => hub.type === type);
		if (index >= 0) {
			hubs[index] = new Hub({ ...hubs[index], Metadata: [...(hubs[index].Metadata ?? []), ...items] });
		} else {
			hubs.push(
				new Hub({
					hubIdentifier: `flex.search.${type}`,
					hubKey: `/library/metadata/${items.map((item) => item.ratingKey).join(',')}`,
					key: `/hubs/search/${type}`,
					title: type === 'movie' ? 'Movies' : 'Shows',
					type,
					more: false,
					Metadata: items,
				}),
			);
		}
	}

	return hubs;
}
