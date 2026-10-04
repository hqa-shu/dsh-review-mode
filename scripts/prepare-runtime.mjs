import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length && (args[0] !== '--asar' || args.length !== 2)) {
  throw new Error('Usage: node scripts/prepare-runtime.mjs [--asar /absolute/path/to/app.asar]');
}
const archive = args[1] ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const bytes = fs.readFileSync(archive);
const headerSize = bytes.readUInt32LE(4);
const jsonSize = bytes.readUInt32LE(12);
if (jsonSize > headerSize || headerSize + 8 > bytes.length) throw new Error('Invalid ASAR header');
const tree = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'));
const dataStart = 8 + headerSize;
function nodeAt(rel) {
  let node = tree;
  for (const part of rel.split('/')) node = node?.files?.[part];
  return node;
}
function read(rel) {
  const node = nodeAt(rel);
  if (!node || node.files || node.link) throw new Error(`Missing regular ASAR file: ${rel}`);
  if (node.unpacked) return fs.readFileSync(path.join(`${archive}.unpacked`, rel));
  const start = dataStart + Number(node.offset);
  if (!Number.isSafeInteger(start) || start < dataStart || start + node.size > bytes.length) throw new Error(`Invalid ASAR offset: ${rel}`);
  return bytes.subarray(start, start + node.size);
}
const selected = ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope', '@deepseek-ai/schemastery', 'js-yaml', 'zod'];
const seen = new Set();
const output = path.join(root, 'node_modules');
function visit(name, required = true) {
  if (seen.has(name)) return;
  if (!/^(@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`Invalid package name: ${name}`);
  const rel = `dsh/node_modules/${name}`;
  if (!nodeAt(`${rel}/package.json`)) {
    if (required) throw new Error(`Package ${name} is absent from this host build`);
    return;
  }
  const pkg = JSON.parse(read(`${rel}/package.json`).toString('utf8'));
  seen.add(name);
  const dest = path.join(output, name);
  if (fs.existsSync(dest)) {
    if (fs.lstatSync(dest).isSymbolicLink()) throw new Error(`Refusing package symlink: ${name}`);
    const existing = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
    if (existing.version !== pkg.version) throw new Error(`Version mismatch for ${name}; use a fresh checkout`);
  } else {
    function extract(node, at, target) {
      if (node.link) throw new Error(`ASAR links are unsupported: ${at}`);
      if (node.files) {
        fs.mkdirSync(target, { recursive: true });
        for (const [key, child] of Object.entries(node.files)) {
          if (key === '.' || key === '..' || /[\\/]/.test(key)) throw new Error('Unsafe ASAR path');
          extract(child, `${at}/${key}`, path.join(target, key));
        }
      } else fs.writeFileSync(target, read(at));
    }
    extract(nodeAt(rel), rel, dest);
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
  for (const dep of Object.keys(pkg.peerDependencies ?? {})) visit(dep, !pkg.peerDependenciesMeta?.[dep]?.optional);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, false);
}
fs.mkdirSync(output, { recursive: true });
for (const name of selected) visit(name);
console.log(`Prepared ${seen.size} SDK/dependency packages in ignored node_modules/. Host files were only read.`);
