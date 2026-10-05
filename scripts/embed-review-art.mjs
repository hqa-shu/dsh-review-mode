import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const entries = [
  ['welcome', 'welcome.webp', 'image/webp'],
  ['advice', 'advice.webp', 'image/webp'],
  ['header', 'waiting.png', 'image/png'],
];
const art = Object.fromEntries(entries.map(([key, file, mime]) =>
  [key, `data:${mime};base64,${readFileSync(new URL(`assets/whale-girl/${file}`, root)).toString('base64')}`]));
const target = fileURLToPath(new URL('client.js', root));
const source = readFileSync(target, 'utf8');
const block = `    // BEGIN REVIEW ART (generated; artwork credits: assets/whale-girl/NOTICE.md)\n    const REVIEW_ART = ${JSON.stringify(art)};\n    // END REVIEW ART`;
const marker = /    \/\/ BEGIN REVIEW ART[^]*?    \/\/ END REVIEW ART/;
writeFileSync(target, marker.test(source) ? source.replace(marker, () => block)
  : source.replace('    const h = React.createElement;', `    const h = React.createElement;\n\n${block}`));
console.log('Embedded 3 local review illustrations; no remote image requests.');
