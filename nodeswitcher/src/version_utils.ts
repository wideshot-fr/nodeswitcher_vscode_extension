import semver from 'semver';

export function parse_versions(raw: string): string[] {
	const matches = raw.match(/\bv?\d+\.\d+\.\d+\b/g) ?? [];
	return [...new Set(matches.map(normalize_version))];
}

export function collect_stable_semver_versions_from_text(raw: string): string[] {
	const matches = raw.match(/\bv?\d+\.\d+\.\d+\b/g) ?? [];
	const set = new Set<string>();
	for (const m of matches) {
		const n = normalize_version(m);
		if (semver.valid(n) && semver.prerelease(n) === null) {
			set.add(n);
		}
	}
	return [...set];
}

export function sort_versions_semver_desc(versions: string[]): string[] {
	return [...versions].filter((v) => semver.valid(v)).sort((a, b) => semver.rcompare(a, b));
}

export function normalize_version(version: string): string {
	return version.startsWith('v') ? version.slice(1) : version;
}

export function sanitize_version(version: string): string {
	const normalized = normalize_version(version.trim());
	if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
		return '';
	}
	return normalized;
}

export function compare_versions_desc(left: string, right: string): number {
	const left_parts = left.split('.').map((value) => Number(value));
	const right_parts = right.split('.').map((value) => Number(value));
	for (let index = 0; index < 3; index += 1) {
		const diff = (right_parts[index] ?? 0) - (left_parts[index] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

export type VersionMajorColorKey = 'red' | 'yellow' | 'blue' | 'green';

export function version_major_color_key(version: string): VersionMajorColorKey {
	const major = Number(version.split('.')[0] ?? 0);
	if (major >= 22) {
		return 'green';
	}
	if (major >= 20) {
		return 'blue';
	}
	if (major >= 18) {
		return 'yellow';
	}
	return 'red';
}

const CHARTS_THEME_COLOR: Record<VersionMajorColorKey, string> = {
	red: 'charts.red',
	yellow: 'charts.yellow',
	blue: 'charts.blue',
	green: 'charts.green'
};

export function get_version_color(version: string): string {
	return CHARTS_THEME_COLOR[version_major_color_key(version)];
}

const DEPRECATED_MAJOR_MAX = 17;

export type NodeReleaseChannels = {
	current_major: number | null;
	active_lts_major: number | null;
	maintenance_lts_majors: Set<number>;
	status_by_major?: Map<number, 'current' | 'active_lts' | 'maintenance_lts' | 'eol'>;
	has_index: boolean;
};

export type VersionReleaseSemantics = {
	logoFilename: string;
	badge: string;
};

function logo_filename_for_major_fallback(version: string): string {
	const band = version_major_color_key(version);
	if (band === 'green') {
		return 'logo-current.svg';
	}
	if (band === 'blue') {
		return 'logo-lts.svg';
	}
	return 'logo-eol.svg';
}

function badge_for_major_fallback(version: string): string {
	return '';
}

export function resolve_version_release_semantics(
	version: string,
	channels: NodeReleaseChannels
): VersionReleaseSemantics {
	const normalized = normalize_version(version.trim());
	const major = Number(normalized.split('.')[0]);
	if (Number.isNaN(major)) {
		return { logoFilename: 'logo-eol.svg', badge: 'EOL' };
	}
	if (major <= DEPRECATED_MAJOR_MAX) {
		return { logoFilename: 'logo-eol.svg', badge: 'EOL' };
	}
	if (channels.has_index) {
		const mapped = channels.status_by_major?.get(major);
		if (mapped === 'current') {
			return { logoFilename: 'logo-current.svg', badge: 'Current' };
		}
		if (mapped === 'active_lts') {
			return { logoFilename: 'logo-lts.svg', badge: 'Active LTS' };
		}
		if (mapped === 'maintenance_lts') {
			return { logoFilename: 'logo-maintenance.svg', badge: 'Maintenance LTS' };
		}
		if (mapped === 'eol') {
			return { logoFilename: 'logo-eol.svg', badge: 'EOL' };
		}
		return { logoFilename: logo_filename_for_major_fallback(version), badge: '' };
	}
	return {
		logoFilename: logo_filename_for_major_fallback(version),
		badge: badge_for_major_fallback(version)
	};
}

export function resolve_version_logo_filename(version: string, channels: NodeReleaseChannels): string {
	return resolve_version_release_semantics(version, channels).logoFilename;
}
