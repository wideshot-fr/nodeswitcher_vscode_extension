import * as fs from 'fs/promises';
import * as path from 'path';
import semver from 'semver';

export async function read_declared_node_range(workspace_root: string): Promise<string | undefined> {
	const read_first_meaningful_line = async (rel: string): Promise<string | undefined> => {
		try {
			const text = await fs.readFile(path.join(workspace_root, rel), 'utf8');
			const line = text
				.split(/\r?\n/)
				.find((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
			return line?.trim();
		} catch {
			return undefined;
		}
	};

	for (const rel of ['.nvmrc', '.node-version']) {
		const line = await read_first_meaningful_line(rel);
		if (line) {
			return line.replace(/^v/i, '');
		}
	}

	try {
		const raw = await fs.readFile(path.join(workspace_root, 'package.json'), 'utf8');
		const j = JSON.parse(raw) as { engines?: { node?: string } };
		if (j.engines?.node && typeof j.engines.node === 'string') {
			return j.engines.node.trim();
		}
	} catch {
		// ignore
	}

	try {
		const raw = await fs.readFile(path.join(workspace_root, '.npmrc'), 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const m = line.match(/^\s*node-version\s*=\s*(.+)$/i);
			if (m) {
				return m[1].trim().replace(/^v/i, '');
			}
		}
	} catch {
		// ignore
	}

	return undefined;
}

export async function workspace_looks_like_js_project(workspace_root: string): Promise<boolean> {
	for (const name of [
		'package.json',
		'.npmrc',
		'pnpm-lock.yaml',
		'yarn.lock',
		'package-lock.json',
		'npm-shrinkwrap.json'
	]) {
		try {
			await fs.access(path.join(workspace_root, name));
			return true;
		} catch {
			continue;
		}
	}
	return false;
}

export function active_satisfies_declared_range(active_version: string, range_spec: string): boolean {
	const v = semver.coerce(active_version);
	if (!v) {
		return false;
	}
	const trimmed = range_spec.trim();
	if (/^lts/i.test(trimmed) || trimmed === 'node' || trimmed === 'system') {
		return true;
	}
	const range = semver.validRange(trimmed);
	if (range) {
		return semver.satisfies(v, range);
	}
	const exact = semver.coerce(trimmed);
	if (exact) {
		return semver.eq(v, exact);
	}
	return true;
}
