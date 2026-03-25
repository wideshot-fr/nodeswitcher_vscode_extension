export function parse_versions(raw: string): string[] {
	const matches = raw.match(/\bv?\d+\.\d+\.\d+\b/g) ?? [];
	return [...new Set(matches.map(normalize_version))];
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
