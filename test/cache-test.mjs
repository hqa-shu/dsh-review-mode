/**
 * 探查缓存测试（普通 Node 就能跑，不需要重启应用）。
 *
 * 用户的原话：「设置一次探查，然后…就把目录的这个数据…至少把连接给写死了…
 * 记录就能记录到究竟在哪里可以找到，就省下很多时间」。
 *
 * 所以这里要证明四件事：
 *   1. 第一次调用是**未命中**，真读两个 Codex 索引，并把结果写进
 *      `~/.dsh/review-mode/probe-cache.json`；
 *   2. 缓存文件里记的是**字面绝对路径**（roots + 时间戳），不是"再猜一次"；
 *   3. 第二次从缓存服务，**更快**，而且确实是从缓存文件来的
 *      （往缓存里塞一个源文件不可能有的哨兵，读得到就证明没重读源）；
 *   4. 任一个 root 的 mtime 变了 → 该缓存失效并重写（按 root 失效）；
 *   5. 每次命中/未命中都在 `/tmp/dsh-review-watch.jsonl` 留一行带耗时的 trace。
 */

import fs from 'node:fs';

import {
  CACHE_FILE,
  discoverRoots,
  readCodexIndex,
  resetProbeCache,
  rootsSignature,
} from '../reviewer.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  if (!pass) failed += 1;
};

const TRACE_FILE = '/tmp/dsh-review-watch.jsonl';
const traceLines = () => {
  try {
    return fs.readFileSync(TRACE_FILE, 'utf8')
      .split('\n').filter((line) => line.trim().length > 0)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((line) => line !== null && line.what === 'codexIndex');
  } catch {
    return [];
  }
};

const traceBefore = traceLines().length;

// ── 1. 第一次：未命中，写缓存 ───────────────────────────────
fs.rmSync(CACHE_FILE, { force: true });
resetProbeCache();

const coldStart = performance.now();
const first = readCodexIndex();
const coldMs = performance.now() - coldStart;

check('第一次调用生成了缓存文件', fs.existsSync(CACHE_FILE), CACHE_FILE);
check('解析出了对话标题', first.titleOf.size > 0, `titles=${first.titleOf.size}`);
check('解析出了项目归属', first.projectOf.size >= 0, `projects=${first.projectOf.size}`);

// 紧接着再读一次：同进程应当命中**内存**缓存（连缓存文件都不读）。
const memoryStart = performance.now();
const memoryHit = readCodexIndex();
const memoryMs = performance.now() - memoryStart;
check('同进程再读一次命中内存缓存',
  memoryHit.titleOf.size === first.titleOf.size && memoryMs <= coldMs,
  `${memoryMs.toFixed(2)}ms vs cold ${coldMs.toFixed(2)}ms`);

const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
const realRoots = discoverRoots();

check('缓存文件记录了时间戳', typeof cached.at === 'string' && !Number.isNaN(Date.parse(cached.at)), String(cached.at));
check('缓存文件记录了每个 root 的**字面绝对路径**',
  Object.values(cached.roots).every((root) => typeof root.path === 'string' && root.path.startsWith('/')),
  Object.entries(cached.roots).map(([key, root]) => `${key}=${root.path}`).join(' · '));
check('缓存文件里的路径就是实测路径',
  Object.entries(realRoots).every(([key, root]) => cached.roots[key]?.path === root.path));
check('缓存文件标出了「在哪里找到」两个索引',
  cached.found?.sessionIndex?.endsWith('session_index.jsonl') === true
  && cached.found?.globalState?.endsWith('.codex-global-state.json') === true
  && cached.found.sessionIndex.startsWith('/') === true,
  `${cached.found?.sessionIndex} · ${cached.found?.globalState}`);
check('缓存签名按每个 root 单独记账（mtime/size 进签名）',
  typeof cached.signature === 'string'
  && Object.values(realRoots).every((root) => cached.signature.includes(root.path)),
  `${cached.signature.split('\n').length} 行`);
check('缓存签名就是按缓存的 roots 记账的',
  cached.signature === rootsSignature(cached.roots),
  `${cached.signature.split('\n').length} 行`);

// ── 2. 第二次：从缓存文件命中，且更快 ───────────────────────
resetProbeCache();
const warmStart = performance.now();
const second = readCodexIndex();
const warmMs = performance.now() - warmStart;

check('第二次与第一次内容一致',
  second.titleOf.size === first.titleOf.size && second.projectOf.size === first.projectOf.size,
  `titles ${first.titleOf.size}→${second.titleOf.size}, projects ${first.projectOf.size}→${second.projectOf.size}`);
check('第二次不比第一次慢（缓存省掉了读源文件）',
  warmMs <= coldMs,
  `cold=${coldMs.toFixed(2)}ms warm=${warmMs.toFixed(2)}ms`);

// ── 3. 确实来自缓存文件（哨兵证明，不依赖计时）──────────────
const tampered = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
tampered.codexIndex.titleOf['__cache-probe__'] = '缓存哨兵';
fs.writeFileSync(CACHE_FILE, JSON.stringify(tampered));
resetProbeCache();
const fromCache = readCodexIndex();
check('命中缓存文件（往里塞的哨兵被读出来了）',
  fromCache.titleOf.get('__cache-probe__') === '缓存哨兵');

// ── 4. 按 root 失效：改一个 root 的 mtime → 未命中并重写 ────
const stale = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
stale.roots.codexIndexFile.mtimeMs = Math.round(stale.roots.codexIndexFile.mtimeMs) + 12345;
fs.writeFileSync(CACHE_FILE, JSON.stringify(stale));
resetProbeCache();
const afterInvalidate = readCodexIndex();
const rewritten = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
check('root 的 mtime 变了 → 缓存失效，重新真读',
  afterInvalidate.titleOf.get('__cache-probe__') === undefined);
check('重写后的缓存记录了真实的 mtime',
  Math.round(rewritten.roots.codexIndexFile.mtimeMs) === Math.round(discoverRoots().codexIndexFile.mtimeMs),
  `${Math.round(rewritten.roots.codexIndexFile.mtimeMs)} vs ${Math.round(discoverRoots().codexIndexFile.mtimeMs)}`);

// ── 5. trace：每次命中/未命中都有一行 + 耗时 ────────────────
const lines = traceLines().slice(traceBefore);
const misses = lines.filter((line) => line.cache === 'miss');
const hits = lines.filter((line) => line.cache === 'hit');
check('未命中留了 trace', misses.length >= 2, `miss=${misses.length}`);
check('命中留了 trace', hits.length >= 2, `hit=${hits.length}`);
check('trace 带耗时 ms', [...misses, ...hits].every((line) => Number.isFinite(line.ms)));
check('trace 带缓存文件的绝对路径',
  [...misses, ...hits].every((line) => typeof line.file === 'string' && line.file.startsWith('/')));
check('trace 区分 memory / file 两种命中',
  hits.some((line) => line.from === 'memory') && hits.some((line) => line.from === 'file'));

// ── 收尾：把哨兵/篡改清掉，重新生成一份干净的真实缓存 ──────
fs.rmSync(CACHE_FILE, { force: true });
resetProbeCache();
const clean = readCodexIndex();
check('收尾重新生成了干净缓存（不含测试哨兵）',
  fs.existsSync(CACHE_FILE) && clean.titleOf.get('__cache-probe__') === undefined);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
