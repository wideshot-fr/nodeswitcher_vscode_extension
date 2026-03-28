import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'media/logo.svg'), 'utf8');

const resvgReadme = new Resvg(svg, {
	fitTo: { mode: 'width', value: 480 },
	background: 'rgba(0,0,0,0)'
});
fs.writeFileSync(path.join(root, 'media/readme-logo.png'), resvgReadme.render().asPng());
console.log('Wrote media/readme-logo.png');

const resvgIcon = new Resvg(svg, {
	fitTo: { mode: 'width', value: 128 },
	background: 'rgba(0,0,0,0)'
});
fs.writeFileSync(path.join(root, 'media/extension-icon.png'), resvgIcon.render().asPng());
console.log('Wrote media/extension-icon.png');
