import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, createWriteStream } from 'fs';
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont';
import svg2ttf from 'svg2ttf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const glyphs = [
	{
		name: 'nodeswitcher-logo',
		svgPath: path.join(root, 'media', 'logo.svg'),
		codepoint: 0xea01
	},
	{
		name: 'nodeswitcher-bubble-green',
		svgPath: path.join(root, 'media', 'picker', 'bubble-green.svg'),
		codepoint: 0xea02
	}
];
const outDir = path.join(root, 'media', 'status-font');
const outSvg = path.join(outDir, 'nodeswitcher-status.svg');
const outTtf = path.join(outDir, 'nodeswitcher-status.ttf');

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
		`Wrote ${path.relative(root, outTtf)} with ${glyphs.length} glyphs`
	);
});

for (const glyphDef of glyphs) {
	const glyph = createReadStream(glyphDef.svgPath);
	glyph.metadata = {
		name: glyphDef.name,
		unicode: [String.fromCodePoint(glyphDef.codepoint)]
	};
	fontStream.write(glyph);
}
fontStream.end();
