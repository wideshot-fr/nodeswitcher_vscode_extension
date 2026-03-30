import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const repo_root = path.join(root, '..');

function load_dotenv(file_path) {
	if (!fs.existsSync(file_path)) {
		return;
	}
	let text = fs.readFileSync(file_path, 'utf8');
	if (text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim().replace(/^\uFEFF/, '');
		if (!t || t.startsWith('#')) {
			continue;
		}
		const eq = t.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const key = t.slice(0, eq).trim().replace(/^\uFEFF/, '');
		let val = t
			.slice(eq + 1)
			.trim()
			.replace(/\r/g, '')
			.replace(/\u200B/g, '');
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1).trim();
		}
		if (!key) {
			continue;
		}
		const cur = process.env[key];
		const cur_empty = cur === undefined || (typeof cur === 'string' && !cur.trim());
		if (cur_empty) {
			process.env[key] = val;
		}
	}
}

load_dotenv(path.join(repo_root, '.env'));
load_dotenv(path.join(root, '.env'));

function apply_ovsx_pat_from_file(file_path) {
	if (!fs.existsSync(file_path)) {
		return;
	}
	let text = fs.readFileSync(file_path, 'utf8');
	if (text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim().replace(/^\uFEFF/, '');
		if (!t || t.startsWith('#')) {
			continue;
		}
		const eq = t.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const key = t.slice(0, eq).trim();
		if (key !== 'OVSX_PAT') {
			continue;
		}
		let val = t
			.slice(eq + 1)
			.trim()
			.replace(/\r/g, '')
			.replace(/\u200B/g, '');
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1).trim();
		}
		if (val) {
			process.env.OVSX_PAT = val;
		}
	}
}

apply_ovsx_pat_from_file(path.join(repo_root, '.env'));
apply_ovsx_pat_from_file(path.join(root, '.env'));

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = path.join(root, 'publishBuild', `nodeswitcher-${pkg.version}.vsix`);

if (!fs.existsSync(vsix)) {
	console.error(`Missing VSIX: ${vsix}\nRun: npm run publish:vsix`);
	process.exit(1);
}
if (!process.env.OVSX_PAT?.trim()) {
	console.error(
		'OVSX_PAT is not set. Add it to repo-root `.env`, `nodeswitcher/.env` (see .env.example), or your environment.'
	);
	process.exit(1);
}

const r = spawnSync('npx', ['ovsx', 'publish', vsix], {
	cwd: root,
	env: process.env,
	stdio: 'inherit',
	shell: true
});
process.exit(r.status === null ? 1 : r.status);
