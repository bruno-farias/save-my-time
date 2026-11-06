import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

await build({ entryPoints: ['src/background.ts'], outfile: 'dist/background.js', bundle: true, format: 'esm', target: 'chrome116', minify: true });
await build({ entryPoints: ['src/content.ts'], outfile: 'dist/extract.js', bundle: true, format: 'iife', globalName: 'SaveMyTimeExtractor', footer: { js: 'SaveMyTimeExtractor.result;' }, target: 'chrome116', minify: true });
await mkdir('dist/icons', { recursive: true });
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="30" fill="#526448"/><path d="M37 90 78 49M51 76C45 48 64 28 87 31c12 25-6 49-36 45Z" fill="none" stroke="#f8f8f2" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="96" cy="96" r="9" fill="#d7a17b"/></svg>`;
for (const size of [16, 32, 48, 128]) await sharp(Buffer.from(svg)).resize(size, size).png().toFile(`dist/icons/${size}.png`);
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
manifest.version = pkg.version;
await writeFile('dist/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log('Extension ready in dist/ — load it unpacked in Chrome or Brave.');
