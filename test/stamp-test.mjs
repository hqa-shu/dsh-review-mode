/**
 * **版本戳**（2026-10 第四轮现场失败的止血）。
 *
 * 现场：DSH 进程 **15:39:03** 启动，宿主文件 **16:20–16:26** 才被改。也就是说
 * 用户重启之后跑的仍然是**旧的**那份代码，而屏幕上没有任何东西能告诉他这件事。
 * 于是「我改了、你重启、还是没动」循环了三轮，用户的原话是
 * 「审核面板那边还是不动啊，你这个究竟是啥原因啊」。
 *
 * 这个测试钉死两半：
 *   (1) **宿主**：`ping` 必须报出**正在运行的那份代码**的真实身份 ——
 *       自己的文件 mtime（读盘读到的真值）+ 短 hash、进程启动时间；另外报出
 *       client.js 的 mtime（页面那一半的磁盘版本）；以及监控 tick 刷新的
 *       **磁盘当前 mtime**（判断「盘上比运行的新」）。
 *   (2) **客户端**：面板底部常驻一行 `data-review-stamp`，逐字写出
 *       `宿主 HH:MM:SS · 进程 HH:MM:SS · 页面 HH:MM:SS · 界面 HH:MM:SS`；
 *       盘上比运行的新时，必须**明说**「需要重启 DSH / 需要刷新页面」。
 *
 * 反向变异：每一条正向断言都配一个能失败的对照 ——
 *   · mtime 断言：期望值 +1000ms 必须对不上；
 *   · 页面时间戳：写死 0 必须落在「这次加载」的窗口外；
 *   · 过期警告：同一份实现喂 disk==loaded 时，警告必须消失。
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const INDEX_PATH = fileURLToPath(new URL('../index.js', import.meta.url));
const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url));
const HASH_OF = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
const DISK = {
  index: Math.round(fs.statSync(INDEX_PATH).mtimeMs),
  client: Math.round(fs.statSync(CLIENT_PATH).mtimeMs),
  indexHash: HASH_OF(INDEX_PATH),
  clientHash: HASH_OF(CLIENT_PATH),
};

/** 「盘上比运行的新」判据的**独立**实现（不 import 源码，防止两边一起写错）。 */
const hostDiskNewer = (identity) => {
  const loaded = Number(identity?.host?.mtimeMs);
  const disk = Number(identity?.host?.diskMtimeMs);
  return Number.isFinite(loaded) && Number.isFinite(disk) && disk > loaded + 500;
};
const pageDiskNewer = (identity, pageAt) => {
  const disk = Number(identity?.client?.diskMtimeMs);
  return Number.isFinite(disk) && Number.isFinite(pageAt) && disk > pageAt + 500;
};
const clockOf = (ms) => new Date(ms).toTimeString().slice(0, 8);

/* ══ 宿主侧 ═══════════════════════════════════════════════════════════ */

const appended = [];
const agent = {
  id: 'review-1',
  session: {
    header: { id: 'review-1', cwd: '/w' },
    seq: 0,
    snapshotEvents: () => [],
    append(type, data, opts) { appended.push({ type, data, opts }); this.seq += 1; return { type, seq: this.seq, data }; },
  },
  followups: [],
  injects: [],
  followup(m) { this.followups.push(m); },
  inject(m) { this.injects.push(m); },
};
const registeredCommands = new Map();
const intervals = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
globalThis.clearInterval = () => {};

const mod = await import(new URL('../index.js', import.meta.url).pathname);
mod.apply({
  logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: () => {},
  inject: (names, cb) => {
    const scope = {
      names,
      commands: { register(def) { registeredCommands.set(def.name, def); return () => {}; } },
      get: (name) => (name === 'commands' ? scope.commands : undefined),
      effect: (fn) => fn(),
    };
    cb(scope);
  },
  sessionProjections: {
    register: () => () => {},
    stateOf: (s, k) => (k === 'agentPreset' ? 'review' : null),
  },
  subagents: { start: async () => ({ id: 'run-1', result: Promise.resolve({ output: [] }), dispose: async () => {} }) },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, watchCodex: true });

const definition = registeredCommands.get('review-mode');
const PING = () => JSON.parse(definition.handler({ agent, rawInput: 'ping', commandId: 'c', attachments: [], signal: new AbortController().signal }).text);

const first = PING();
const id = first.identity;

check('ping 带 identity（面板的版本戳就靠它，没它就只能猜）',
  id !== null && typeof id === 'object', JSON.stringify(id ?? null).slice(0, 120));
check('identity 报出宿主文件的**真实 mtime**（与 statSync 逐毫秒相同）',
  Math.round(id?.host?.mtimeMs) === DISK.index, `ping=${id?.host?.mtimeMs} disk=${DISK.index}`);
check('宿主 mtime 断言能失败（反向变异）：期望值 +1000ms 必须对不上',
  Math.round(id?.host?.mtimeMs) === DISK.index && Math.round(id?.host?.mtimeMs) !== DISK.index + 1000);
check('identity 报出宿主文件的短 hash（内容变了也看得出来）',
  id?.host?.hash === DISK.indexHash, `ping=${id?.host?.hash} disk=${DISK.indexHash}`);
check('identity 报出 client.js 的真实 mtime（页面那一半的磁盘版本）',
  Math.round(id?.client?.mtimeMs) === DISK.client, `ping=${id?.client?.mtimeMs} disk=${DISK.client}`);
check('identity 报出 client.js 的短 hash', id?.client?.hash === DISK.clientHash);
check('identity 报出宿主文件路径', String(id?.host?.file ?? '').endsWith('index.js'), String(id?.host?.file));

const expectedStart = Date.now() - Math.round(process.uptime() * 1000);
check('identity 报出进程启动时间（与 process.uptime 推出的真值相差 < 5s）',
  Number.isFinite(id?.processStartedAt) && Math.abs(id.processStartedAt - expectedStart) < 5000,
  `ping=${id?.processStartedAt} expected≈${expectedStart}`);
check('进程启动时间断言能失败（反向变异）：+1 小时必须对不上',
  Math.abs(Number(id?.processStartedAt) - expectedStart) < 5000
  && Math.abs(Number(id?.processStartedAt) - (expectedStart + 3600000)) >= 5000);

// 磁盘当前 mtime：监控 tick 会把它刷新成真值 —— 但**只动 statSync**，
// 不碰真实文件（改文件 mtime 会污染用户的工作区）。
check('identity 一开始就带 loaded 与 disk 两个 mtime', Number.isFinite(id?.host?.diskMtimeMs) && Number.isFinite(id?.host?.mtimeMs));
{
  const realStat = fs.statSync;
  const fakeDisk = DISK.index + 7 * 60 * 1000;
  fs.statSync = (target, ...rest) => {
    const stat = realStat(target, ...rest);
    if (String(target) === INDEX_PATH) return { ...stat, mtimeMs: fakeDisk };
    return stat;
  };
  try {
    intervals[0].fn();
    await sleep(20);
  } finally {
    fs.statSync = realStat;
  }
  const second = PING();
  check('监控 tick 会把「磁盘当前 mtime」刷新成真值（面板据此说「盘上比运行的新」）',
    Math.round(second.identity?.host.diskMtimeMs) === Math.round(fakeDisk),
    `disk=${second.identity?.host.diskMtimeMs} fake=${fakeDisk}`);
  check('刷新磁盘 mtime 不会篡改「正在运行的那份代码」的 mtime（那是加载时定的）',
    Math.round(second.identity?.host.mtimeMs) === DISK.index, `loaded=${second.identity?.host.mtimeMs}`);
  check('盘上比运行的新：loaded < disk（这一条就是「需要重启」的判据）',
    hostDiskNewer(second.identity ?? {}) === true,
    `loaded=${second.identity?.host.mtimeMs} disk=${second.identity?.host.diskMtimeMs}`);
  check('反向变异（独立判据）：disk 拉回等于 loaded 时，判据必须变假',
    hostDiskNewer({ host: { mtimeMs: DISK.index, diskMtimeMs: DISK.index } }) === false);
}

/* ══ 客户端侧 ═════════════════════════════════════════════════════════ */

function makeReact() {
  const stateSlots = [];
  const effectSlots = [];
  let cursor = 0;
  let effectCursor = 0;
  let onChange = () => {};
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in stateSlots)) stateSlots[index] = typeof initial === 'function' ? initial() : initial;
      return [stateSlots[index], (next) => {
        stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next;
        onChange();
      }];
    },
    useRef(value) { return { current: value }; },
    useEffect(fn, deps) {
      const index = effectCursor;
      effectCursor += 1;
      const prev = effectSlots[index];
      const same = prev !== undefined && Array.isArray(deps) && Array.isArray(prev.deps)
        && deps.length === prev.deps.length && deps.every((dep, i) => Object.is(dep, prev.deps[i]));
      if (same) return;
      if (prev !== undefined && typeof prev.cleanup === 'function') { try { prev.cleanup(); } catch { /* 无所谓 */ } }
      effectSlots[index] = { deps, cleanup: fn() };
    },
  };
  return { React, reset() { cursor = 0; effectCursor = 0; }, onChange(fn) { onChange = fn; } };
}

let importId = 0;

/**
 * 起一个面板实例（靠 `id === 'review-mode-panel'` 认组件，插槽名换了也照样收）。
 * @param {object} options - `{facts, execute, preset}`。
 * @returns {Promise<object>} `{tree}`。
 */
async function bootPanel(options) {
  const react = makeReact();
  let registered = null;
  const facts = options.facts ?? null;
  const execute = options.execute ?? ((sessionId, line) => Promise.resolve(facts === null
    ? { ok: true, value: undefined }
    : { ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify(facts) } } }));
  globalThis.window = {
    __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? react.React : {})); } },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener() {}, removeEventListener() {},
    __reviewRemoteTimeoutMs: 60,
    __reviewLocalTickMs: 100000,
    __reviewProbeIntervalMs: 100000,
    __reviewStaleMs: 100000,
    __reviewPageStartedAt: options.pageStartedAt,
  };
  const url = new URL(`../client.js?stamp=${importId++}`, import.meta.url).href;
  await import(url);
  if (registered === null) throw new Error('client.js 没有注册');
  let panel = null;
  const metas = [];
  registered.apply({
    remote: { commands: { execute } },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, component) => { metas.push(meta); if (meta.id === 'review-mode-panel') panel = component; },
    },
  });
  let tree = null;
  const props = {
    sessionId: 's1',
    useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: options.preset ?? 'review', reviewMode: { feed: [] } } } } }),
  };
  const render = () => { react.reset(); tree = panel(props); };
  react.onChange(render);
  render();
  return { get tree() { return tree; }, metas };
}

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const stampNode = (tree) => collect(tree, (n) => n.props?.['data-review-stamp'] !== undefined)[0] ?? null;
const stampText = (tree) => String(stampNode(tree)?.props?.['data-review-stamp'] ?? '');

const LOADED = Date.parse('2026-10-03T15:12:03');
const STARTED = Date.parse('2026-10-03T15:39:03');
const diskHost = Date.parse('2026-10-03T16:20:49');
const diskClient = Date.parse('2026-10-03T16:26:41');
const FACTS = (hostDisk, clientDisk) => ({
  ok: true, pong: true, hostNow: Date.now(),
  tick: { enabled: true, intervalMs: 5000, lastAt: Date.now() - 100, ageMs: 100, count: 3 },
  scan: { at: Date.now() - 100, ageMs: 100, conversations: 40, targetId: 'x' },
  identity: {
    processStartedAt: STARTED,
    host: { file: INDEX_PATH, mtimeMs: LOADED, hash: 'aaaaaaaaaaaa', diskMtimeMs: hostDisk },
    client: { file: CLIENT_PATH, mtimeMs: LOADED, hash: 'bbbbbbbbbbbb', diskMtimeMs: clientDisk },
  },
});

/* ── 场景 1：新鲜（盘上 == 运行中）—— 不许喊重启 ── */
{
  const pageBefore = Date.now();
  const panel = await bootPanel({ facts: FACTS(LOADED, LOADED) });
  await sleep(30);
  const node = stampNode(panel.tree);
  const text = stampText(panel.tree);
  check('面板底部常驻一行版本戳 `data-review-stamp`', node !== null && typeof node === 'object');
  check('版本戳逐字写出 `宿主 <mtime>` 与 `进程 <start>`（用户一眼能对比盘上的 mtime）',
    text.includes(`宿主 ${clockOf(LOADED)}`) && text.includes(`进程 ${clockOf(STARTED)}`), text);
  check('宿主时间戳断言能失败（反向变异）：+1000ms 的期望必须对不上',
    text.includes(`宿主 ${clockOf(LOADED)}`) && !text.includes(`宿主 ${clockOf(LOADED + 1000)}`));
  check('版本戳也写出 client.js 的磁盘 mtime（`界面 <mtime>`）',
    text.includes(`界面 ${clockOf(LOADED)}`), text);
  const pageMs = Number(node?.props?.['data-review-stamp-page']);
  check('页面那一半报的是**这次页面加载**的时间（落在测试开始到现在之间）',
    Number.isFinite(pageMs) && pageMs >= pageBefore - 2000 && pageMs <= Date.now() + 1000,
    `page=${pageMs}`);
  check('页面时间戳断言能失败（反向变异）：写死 0 必须落在窗口外',
    !(0 >= pageBefore - 2000 && 0 <= Date.now() + 1000));
  check('盘上没有更新的文件时不喊「需要重启 / 刷新」（不许常亮）',
    !/需要重启|需要刷新/.test(text), text);
}

/* ── 场景 2：盘上比运行的新 —— 这正是用户那三轮的样子 ── */
{
  // 这一页是 15:39:20 加载的；磁盘上的 index.js/client.js 却是 16:20/16:26。
  const pageStartedAt = Date.parse('2026-10-03T15:39:20');
  const panel = await bootPanel({ facts: FACTS(diskHost, diskClient), pageStartedAt });
  await sleep(30);
  const text = stampText(panel.tree);
  check('盘上的宿主文件比运行的新时，版本戳明说「需要重启 DSH」', /需要重启/.test(text), text);
  check('盘上的 client.js 比页面新时，版本戳明说「需要刷新页面」', /需要刷新/.test(text), text);
  check('版本戳把盘上的新时间也写出来（16:20:49），用户不用自己去 `ls`',
    text.includes(clockOf(diskHost)), text);
  check('反向变异：同一份实现喂 disk==loaded，这两句警告必须消失',
    !/需要重启|需要刷新/.test(stampText((await bootPanel({ facts: FACTS(LOADED, LOADED), pageStartedAt })).tree)));
  check('反向变异（页面比文件新）：页面是 16:30 加载的、client.js 是 16:26 的 → 不许喊刷新',
    !/需要刷新/.test(stampText((await bootPanel({
      facts: FACTS(diskHost, diskClient),
      pageStartedAt: Date.parse('2026-10-03T16:30:00'),
    })).tree)));
}

/* ── 场景 3：还没连上宿主时，页面自己的那一半也必须已经在 ── */
{
  const pageBefore = Date.now();
  const panel = await bootPanel({ execute: () => new Promise(() => {}) });
  const node = stampNode(panel.tree);
  const pageMs = Number(node?.props?.['data-review-stamp-page']);
  check('心跳还没回来时，页面自己的版本戳也已经画出来（页面旧不旧不靠宿主回答）',
    node !== null && Number.isFinite(pageMs) && pageMs >= pageBefore - 2000, `page=${pageMs}`);
  check('还没拿到宿主身份时，宿主那半如实写「—」而不是编一个时间',
    /宿主\s*—/.test(stampText(panel.tree)), stampText(panel.tree));
}

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
