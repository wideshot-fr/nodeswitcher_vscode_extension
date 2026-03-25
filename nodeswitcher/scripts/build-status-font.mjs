import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, createWriteStream } from 'fs';
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont';
import svg2ttf from 'svg2ttf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'media', 'logo.svg');
const outDir = path.join(root, 'media', 'status-font');
const outSvg = path.join(outDir, 'nodeswitcher-status.svg');
const outTtf = path.join(outDir, 'nodeswitcher-status.ttf');

const CODEPOINT = 0xea01;

fs.mkdirSync(outDir, { recursive: true });

const fontStream = new SVGIcons2SVGFontStream({
	fontName: 'nodeswitcher-status',
	fontHeight: 1000,
	normalize: true,
	descent: 150,
	round: 10e12
});

const outStream = createWriteStream(outSvg);

fontStream.pipe(outStream);

outStream.on('finish', () => {
	const svgFont = fs.readFileSync(outSvg, 'utf8');
	const ttf = svg2ttf(svgFont, { ts: 0 });
	fs.writeFileSync(outTtf, Buffer.from(ttf.buffer));
	fs.unlinkSync(outSvg);
	console.log(
		`Wrote ${path.relative(root, outTtf)} — set fontCharacter to \\\\${CODEPOINT.toString(16)} (U+${CODEPOINT.toString(16).toUpperCase()})`
	);
});

const glyph = createReadStream(svgPath);
glyph.metadata = {
	name: 'nodeswitcher-logo',
	unicode: [String.fromCodePoint(CODEPOINT)]
};
fontStream.write(glyph);
fontStream.end();
