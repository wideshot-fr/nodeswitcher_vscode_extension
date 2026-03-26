import * as fs from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import semver from 'semver';

export type DeclarationScanStep =
	| 'nodeswitcher'
	| 'package_json'
	| 'nvm_files'
	| 'project_npmrc'
	| 'user_npmrc';

export type DeclarationScanEvent = {
	phase: 'done';
	step: DeclarationScanStep;
	found: boolean;
	value?: string;
};

export type ReadDeclaredNodeRangeOptions = {
	onProgress?: (ev: DeclarationScanEvent) => void | Promise<void>;
};

const SCAN_STEP_ORDER: DeclarationScanStep[] = [
	'nodeswitcher',
	'package_json',
	'project_npmrc',
	'nvm_files',
	'user_npmrc'
];

async function emit(
	onProgress: ReadDeclaredNodeRangeOptions['onProgress'],
	ev: DeclarationScanEvent
): Promise<void> {
	if (onProgress) {
		await onProgress(ev);
	}
}

async function read_first_meaningful_line(workspace_root: string, rel: string): Promise<string | undefined> {
	try {
		const text = await fs.readFile(path.join(workspace_root, rel), 'utf8');
		const line = text
			.split(/\r?\n/)
			.find((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
		return line?.trim();
	} catch {
		return undefined;
	}
}

async function read_nodeswitcher_current(workspace_root: string): Promise<string | undefined> {
	try {
		const raw = await fs.readFile(path.join(workspace_root, '.nodeswitcher'), 'utf8');
		const parsed = JSON.parse(raw) as { current?: unknown };
		if (typeof parsed.current === 'string') {
			const t = parsed.current.trim();
			if (t.length > 0) {
				return t.replace(/^v/i, '');
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function read_package_json_engines_node(workspace_root: string): Promise<string | undefined> {
	try {
		const raw = await fs.readFile(path.join(workspace_root, 'package.json'), 'utf8');
		const j = JSON.parse(raw) as { engines?: { node?: string } };
		if (j.engines?.node && typeof j.engines.node === 'string') {
			return j.engines.node.trim();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function read_nvm_or_node_version_files(workspace_root: string): Promise<string | undefined> {
	for (const rel of ['.nvmrc', '.node-version']) {
		const line = await read_first_meaningful_line(workspace_root, rel);
		if (line) {
			return line.replace(/^v/i, '');
		}
	}
	return undefined;
}

async function read_npmrc_node_version(file_path: string): Promise<string | undefined> {
	try {
		const raw = await fs.readFile(file_path, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const m = line.match(/^\s*node-version\s*=\s*(.+)$/i);
			if (m) {
				return m[1].trim().replace(/^v/i, '');
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function declaration_scan_step_count(): number {
	return SCAN_STEP_ORDER.length;
}

export function declaration_scan_step_label(step: DeclarationScanStep): string {
	switch (step) {
		case 'nodeswitcher':
			return '.nodeswitcher';
		case 'package_json':
			return 'package.json engines';
		case 'nvm_files':
			return '.nvmrc / .node-version';
		case 'project_npmrc':
			return 'project .npmrc';
		case 'user_npmrc':
			return 'user .npmrc (~/.npmrc)';
		default:
			return step;
	}
}

export async function read_declared_node_range(
	workspace_root: string,
	options?: ReadDeclaredNodeRangeOptions
): Promise<string | undefined> {
	const onProgress = options?.onProgress;

	const from_nodeswitcher = await read_nodeswitcher_current(workspace_root);
	if (from_nodeswitcher) {
		await emit(onProgress, {
			phase: 'done',
			step: 'nodeswitcher',
			found: true,
			value: from_nodeswitcher
		});
		return from_nodeswitcher;
	}
	await emit(onProgress, { phase: 'done', step: 'nodeswitcher', found: false });

	const from_pkg = await read_package_json_engines_node(workspace_root);
	if (from_pkg) {
		await emit(onProgress, {
			phase: 'done',
			step: 'package_json',
			found: true,
			value: from_pkg
		});
		return from_pkg;
	}
	await emit(onProgress, { phase: 'done', step: 'package_json', found: false });

	const project_npmrc = path.join(workspace_root, '.npmrc');
	const from_project_npmrc = await read_npmrc_node_version(project_npmrc);
	if (from_project_npmrc) {
		await emit(onProgress, {
			phase: 'done',
			step: 'project_npmrc',
			found: true,
			value: from_project_npmrc
		});
		return from_project_npmrc;
	}
	await emit(onProgress, { phase: 'done', step: 'project_npmrc', found: false });

	const from_nvm_files = await read_nvm_or_node_version_files(workspace_root);
	if (from_nvm_files) {
		await emit(onProgress, {
			phase: 'done',
			step: 'nvm_files',
			found: true,
			value: from_nvm_files
		});
		return from_nvm_files;
	}
	await emit(onProgress, { phase: 'done', step: 'nvm_files', found: false });

	const user_npmrc = path.join(homedir(), '.npmrc');
	const from_user = await read_npmrc_node_version(user_npmrc);
	if (from_user) {
		await emit(onProgress, {
			phase: 'done',
			step: 'user_npmrc',
			found: true,
			value: from_user
		});
		return from_user;
	}
	await emit(onProgress, { phase: 'done', step: 'user_npmrc', found: false });

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
