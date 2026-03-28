import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeswitcherRoot = path.join(__dirname, '..');
const repoRoot = path.join(nodeswitcherRoot, '..');

function run(cmd, cwd = nodeswitcherRoot) {
	execSync(cmd, { stdio: 'inherit', cwd, shell: true });
}

function runOut(cmd, cwd = nodeswitcherRoot) {
	return execSync(cmd, { encoding: 'utf8', cwd, shell: true }).trim();
}

const argv = process.argv.slice(2);
const noPush = argv.includes('--no-push');
const bump = argv.find((a) => ['patch', 'minor', 'major'].includes(a)) || 'patch';

run('npm run lint');
run(`npm version ${bump} --no-git-tag-version`);

const pkg = JSON.parse(fs.readFileSync(path.join(nodeswitcherRoot, 'package.json'), 'utf8'));
const v = pkg.version;
const today = new Date().toISOString().slice(0, 10);

const changelogPath = path.join(nodeswitcherRoot, 'CHANGELOG.md');
let cl = fs.readFileSync(changelogPath, 'utf8');
if (!cl.includes(`## [${v}]`)) {
	const idx = cl.search(/\n## \[\d/);
	const insertAt = idx === -1 ? cl.length : idx + 1;
	const block = `## [${v}] - ${today}\n\n- Release ${v}.\n\n`;
	cl = cl.slice(0, insertAt) + block + cl.slice(insertAt);
	fs.writeFileSync(changelogPath, cl);
}

run('npm run publish:vsix');

run('git add -A', repoRoot);
const msg = `chore(release): nodeswitcher v${v}`;
run(`git commit -m ${JSON.stringify(msg)}`, repoRoot);
run(`git tag -a ${JSON.stringify('v' + v)} -m ${JSON.stringify(msg)}`, repoRoot);

if (!noPush) {
	const branch = runOut('git rev-parse --abbrev-ref HEAD', repoRoot);
	run(`git push -u origin ${JSON.stringify(branch)}`, repoRoot);
	run(`git push origin ${JSON.stringify('v' + v)}`, repoRoot);
}

console.log(`\nDone. VSIX: publishBuild/nodeswitcher-${v}.vsix (gitignored). Upload that file to the Marketplace when ready.\n`);
