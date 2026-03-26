import * as https from 'https';
import { compare_versions_desc, normalize_version, type NodeReleaseChannels } from './version_utils';

export type { NodeReleaseChannels } from './version_utils';

const INDEX_URL = 'https://nodejs.org/dist/index.json';
const END_OF_LIFE_API_URL = 'https://endoflife.date/api/nodejs.json';
const CACHE_MS = 6 * 60 * 60 * 1000;
const PLACEHOLDER_CACHE_MS = 60_000;

type IndexRow = {
	lts?: boolean | string;
	version?: string;
};

type IndexCache = {
	expiry_ms: number;
	lts_majors: Set<number>;
	latest_stable_by_major: Map<number, string>;
	current_major: number | null;
	active_lts_major: number | null;
	maintenance_lts_majors: Set<number>;
	status_by_major: Map<number, 'current' | 'active_lts' | 'maintenance_lts' | 'eol'>;
};

let cache: IndexCache | null = null;

export function get_lts_majors_or_empty(): Set<number> {
	return cache?.lts_majors ?? new Set();
}

export function get_node_release_channels(): NodeReleaseChannels {
	const c = cache;
	if (!c || c.latest_stable_by_major.size === 0) {
		return {
			current_major: null,
			active_lts_major: null,
			maintenance_lts_majors: new Set(),
			status_by_major: new Map(),
			has_index: false
		};
	}
	return {
		current_major: c.current_major,
		active_lts_major: c.active_lts_major,
		maintenance_lts_majors: new Set(c.maintenance_lts_majors),
		status_by_major: new Map(c.status_by_major),
		has_index: true
	};
}

export async function ensure_node_release_channels_loaded(): Promise<void> {
	await ensure_index_cache();
}

function is_official_stable_release(version_field: string): boolean {
	return /^v\d+\.\d+\.\d+$/.test(version_field);
}

export async function sort_versions_for_display(versions: string[]): Promise<string[]> {
	if (versions.length === 0) {
		return versions;
	}
	const { lts_majors } = await ensure_index_cache();
	return [...versions].sort((left, right) => compare_lts_major_first(left, right, lts_majors));
}

export async function get_latest_stable_per_major_sorted(limit: number): Promise<string[]> {
	const { lts_majors, latest_stable_by_major } = await ensure_index_cache();
	const list = [...latest_stable_by_major.values()];
	const sorted = list.sort((left, right) => compare_lts_major_first(left, right, lts_majors));
	return sorted.slice(0, limit);
}

async function ensure_index_cache(): Promise<IndexCache> {
	if (cache && Date.now() < cache.expiry_ms) {
		return cache;
	}
	try {
		const built = await build_index_cache_from_network();
		cache = { expiry_ms: Date.now() + CACHE_MS, ...built };
		return cache;
	} catch {
		if (cache) {
			return cache;
		}
		const empty: IndexCache = {
			expiry_ms: Date.now() + PLACEHOLDER_CACHE_MS,
			lts_majors: new Set(),
			latest_stable_by_major: new Map(),
			current_major: null,
			active_lts_major: null,
			maintenance_lts_majors: new Set(),
			status_by_major: new Map()
		};
		cache = empty;
		return empty;
	}
}

type PerMajorLatest = { version: string; is_lts_line: boolean };
type EndOfLifeRow = {
	cycle?: string;
	lts?: string | boolean;
	support?: string | boolean;
	eol?: string | boolean;
};

async function build_index_cache_from_network(): Promise<{
	lts_majors: Set<number>;
	latest_stable_by_major: Map<number, string>;
	current_major: number | null;
	active_lts_major: number | null;
	maintenance_lts_majors: Set<number>;
	status_by_major: Map<number, 'current' | 'active_lts' | 'maintenance_lts' | 'eol'>;
}> {
	const rows = (await fetch_json(INDEX_URL)) as IndexRow[];
	const per_major = new Map<number, PerMajorLatest>();
	const latest_stable_by_major = new Map<number, string>();

	for (const row of rows) {
		if (!row?.version || !is_official_stable_release(String(row.version))) {
			continue;
		}
		const normalized = normalize_version(String(row.version));
		const major = Number(normalized.split('.')[0]);
		if (Number.isNaN(major)) {
			continue;
		}
		const lts = row.lts;
		const is_lts_line = lts !== undefined && lts !== null && lts !== false;
		const prev = per_major.get(major);
		if (!prev || compare_versions_desc(prev.version, normalized) > 0) {
			per_major.set(major, { version: normalized, is_lts_line });
			latest_stable_by_major.set(major, normalized);
		}
	}

	const lts_majors = new Set<number>();
	const lts_majors_list: number[] = [];
	for (const [major, info] of per_major) {
		if (info.is_lts_line) {
			lts_majors.add(major);
			lts_majors_list.push(major);
		}
	}
	lts_majors_list.sort((a, b) => b - a);
	const active_lts_major = lts_majors_list.length > 0 ? lts_majors_list[0]! : null;
	const maintenance_lts_majors = new Set(lts_majors_list.slice(1));

	const non_lts_majors: number[] = [];
	for (const [major, info] of per_major) {
		if (!info.is_lts_line) {
			non_lts_majors.push(major);
		}
	}
	const current_major = non_lts_majors.length > 0 ? Math.max(...non_lts_majors) : null;
	const status_by_major = await load_status_by_major_from_lifecycle_api();
	if (status_by_major.size === 0) {
		if (current_major !== null) {
			status_by_major.set(current_major, 'current');
		}
		if (active_lts_major !== null) {
			status_by_major.set(active_lts_major, 'active_lts');
		}
		for (const major of maintenance_lts_majors) {
			status_by_major.set(major, 'maintenance_lts');
		}
	}

	return {
		lts_majors,
		latest_stable_by_major,
		current_major,
		active_lts_major,
		maintenance_lts_majors,
		status_by_major
	};
}

function parse_iso_date(value: string | boolean | undefined): Date | null {
	if (typeof value !== 'string' || value.trim() === '') {
		return null;
	}
	const ts = Date.parse(value);
	if (Number.isNaN(ts)) {
		return null;
	}
	return new Date(ts);
}

function is_lts_row(lts: string | boolean | undefined): boolean {
	return lts !== undefined && lts !== null && lts !== false;
}

async function load_status_by_major_from_lifecycle_api(): Promise<
	Map<number, 'current' | 'active_lts' | 'maintenance_lts' | 'eol'>
> {
	try {
		const rows = (await fetch_json(END_OF_LIFE_API_URL)) as EndOfLifeRow[];
		const today = new Date();
		const result = new Map<number, 'current' | 'active_lts' | 'maintenance_lts' | 'eol'>();
		const non_lts_supported: number[] = [];
		for (const row of rows) {
			const major = Number(row?.cycle ?? '');
			if (Number.isNaN(major)) {
				continue;
			}
			const eol_date = parse_iso_date(row.eol);
			const support_date = parse_iso_date(row.support);
			const is_eol = eol_date !== null && eol_date.getTime() < today.getTime();
			if (is_lts_row(row.lts)) {
				if (is_eol) {
					result.set(major, 'eol');
				} else if (support_date !== null && support_date.getTime() < today.getTime()) {
					result.set(major, 'maintenance_lts');
				} else {
					result.set(major, 'active_lts');
				}
				continue;
			}
			if (is_eol) {
				result.set(major, 'eol');
				continue;
			}
			non_lts_supported.push(major);
		}
		if (non_lts_supported.length > 0) {
			const current_major = Math.max(...non_lts_supported);
			result.set(current_major, 'current');
			for (const major of non_lts_supported) {
				if (major !== current_major && !result.has(major)) {
					result.set(major, 'eol');
				}
			}
		}
		return result;
	} catch {
		return new Map();
	}
}

function fetch_json(url: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { timeout: 12_000 }, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => {
				if (response.statusCode && response.statusCode >= 400) {
					reject(new Error(`HTTP ${response.statusCode}`));
					return;
				}
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on('error', reject);
		request.on('timeout', () => {
			request.destroy();
			reject(new Error('timeout'));
		});
	});
}

function compare_lts_major_first(left: string, right: string, lts_majors: Set<number>): number {
	const left_major = Number(left.split('.')[0]);
	const right_major = Number(right.split('.')[0]);
	const left_line = !Number.isNaN(left_major) && lts_majors.has(left_major);
	const right_line = !Number.isNaN(right_major) && lts_majors.has(right_major);
	if (left_line !== right_line) {
		return left_line ? -1 : 1;
	}
	if (left_major !== right_major) {
		return right_major - left_major;
	}
	return compare_versions_desc(left, right);
}
