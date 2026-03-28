import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'publishBuild');
fs.mkdirSync(outDir, { recursive: true });
const r = spawnSync('npx', ['@vscode/vsce', 'package', '--out', outDir], {
	cwd: root,
	stdio: 'inherit',
	shell: true
});
process.exit(r.status === null ? 1 : r.status);
