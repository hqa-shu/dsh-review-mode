import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let failures = 0;
function check(label, pass) { console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`); if (!pass) failures++; }
for (const name of ['index.js','client.js','remote.js','reviewer.js','rubric.js','cordis.patch.yml','icon.svg']) {
  check(`Package includes ${name}`, pkg.files.includes(name) && fs.existsSync(path.join(root, name)));
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (['node_modules','.git','artifacts','evidence'].includes(e.name)) return [];
    const p = path.join(dir,e.name); return e.isDirectory() ? walk(p) : [p];
  });
}
for (const p of walk(root)) {
  const rel = path.relative(root,p);
  if (/\.(js|mjs)$/.test(p)) {
    const result = spawnSync(process.execPath, ['--check',p], { encoding:'utf8' });
    if (result.status !== 0) { check(`Syntax: ${rel}`, false); console.error(result.stderr); }
  }
  if (/\.(json|yml|md|js|mjs|svg)$/.test(p)) {
    const text = fs.readFileSync(p,'utf8');
    if (/\/Users\/(?!example\/)[A-Za-z0-9._-]+\/(?:Documents|Desktop|Downloads)\b|--Users-(?!example-)[A-Za-z0-9._-]+-(?:Documents|Desktop|Downloads)-|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) check(`Private-data scan: ${rel}`,false);
  }
}
for (const name of ['README.md','README.zh-CN.md']) {
  check(`${name} marks development status`, /under development|正在开发中/.test(fs.readFileSync(path.join(root,name),'utf8')));
}
check('Portable test command declared', pkg.scripts?.test === 'node test/run.mjs');
check('No third-party runtime dependency', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
if (!failures) console.log('PASS syntax and public-package checks');
process.exitCode = failures ? 1 : 0;
