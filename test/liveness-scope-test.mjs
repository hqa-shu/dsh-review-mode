/**
 * 活性灯的范围：**一次失败的「现在」有多长**。
 *
 * 用户 2026-10 现场读出来的那一行（逐字）：
 *   `跑不起来 · 审核失败  通道是通的，但最近一次运行失败（6148 秒前）：
 *    developer/message turn must be a non-negative safe integer · UNKNOWN`
 *
 * 6148 秒 ≈ 1.7 小时前，而且那条错误是**上一个 DSH 进程**留下的 —— 那个进程早就退出了。
 * 句子本身是真的，但把它说成**这个面板现在跑不起来**是假的：现在这一份宿主
 * （新的 `user/message` 投递路）根本没跑过，它会话日志里那条旧 `turn/end`
 * 是从盘上恢复回来的历史，不是本进程的结果。
 *
 * 所以这里钉死三件事：
 *   1. **范围 = 本进程**：`turn/end` 发生在本进程启动之前 → 不算「最近一次运行失败」，
 *      灯不许因为它在「跑不起来」；
 *   2. **不许把失败藏起来**：那条旧失败仍然是事实，`ping` 要如实报出来
 *      （`history`），面板用一句「历史」的话说它，不用 `fail` 那一态冒充；
 *   3. **本进程里的失败照旧立刻报**（这是反向变异：修 1 不能把真的当前失败也吞掉）。
 *
 * 客户端渲染断言用带真 effect 的极小 React（同 `liveness-test.mjs`）。
 */

import { readFileSync } from 'node:fs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用户读到那句话时的真实时间差（毫秒）。 */
const USER_AGE_MS = 6148 * 1000;
const USER_MESSAGE = 'developer/message turn must be a non-negative safe integer';

// ══════════════════════════════════════════════════════════
// 宿主侧：ping 的范围
// ══════════════════════════════════════════════════════════

/** 造一条「上一次进程里失败了」的会话事件流（时间戳在很久以前）。 */
function staleFailureEvents(at) {
  return [
    { type: 'turn/start', seq: 8, time: at - 40, data: { turn: 1 } },
    { type: 'turn/end', seq: 19, time: at, data: { turn: 1, reason: { kind: 'error', error: { message: USER_MESSAGE, code: 'UNKNOWN' } } } },
  ];
}

/** 造一条「本进程里刚刚失败了」的事件流后缀。 */
function freshFailureEvents(at, seq) {
  return [
    { type: 'turn/start', seq, time: at - 10, data: { turn: 2 } },
    { type: 'turn/end', seq: seq + 1, time: at, data: { turn: 2, reason: { kind: 'error', error: { message: 'no API key for provider route "deepseek-official"', code: 'MISSING_CREDENTIAL' } } } },
  ];
}

function makeAgent(events) {
  const session = {
    header: { id: 'review-1', cwd: '/w' },
    seq: events.length,
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' }, adapterDefaults: {} }),
    append() { return { type: 'x', seq: 0, data: {} }; },
  };
  return {
    id: 'review-1',
    options: { provider: 'deepseek-account', model: 'deepseek-flash' },
    session,
    inject() {}, followup() {},
  };
}

const events = staleFailureEvents(Date.now() - USER_AGE_MS);
const agent = makeAgent(events);
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
      get: (name) => (name === 'commands' ? scope.commands : undefined),
      effect: (fn) => fn(),
      commands: { register(definition) { registeredCommands.set(definition.name, definition); return () => {}; } },
    };
    cb(scope);
  },
  sessionProjections: {
    register: () => () => {},
    stateOf: (s, k) => (k === 'agentPreset' ? 'review' : null),
  },
  subagents: { start: async () => ({ id: 'r', result: Promise.resolve({ output: [] }), dispose: async () => {} }) },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, watchCodex: false });

const definition = registeredCommands.get('review-mode');
const run = (rawInput) => definition.handler({ agent, rawInput, commandId: 'cmd-1', attachments: [], signal: new AbortController().signal });
const PING = () => {
  const result = run('ping');
  return result.kind === 'success' ? JSON.parse(result.text) : null;
};

const stale = PING();
check('(1) 上一次进程留下的失败**不再**是「最近一次运行失败」（lastTurn 为空）',
  stale?.lastTurn === null, JSON.stringify(stale?.lastTurn));
check('(1) 但那条失败没有被藏起来：ping 仍然如实报出它（history）',
  stale?.history !== null && stale.history !== undefined
  && stale.history.code === 'UNKNOWN'
  && /non-negative safe integer/.test(String(stale.history.message)),
  JSON.stringify(stale?.history));
check('(1) history 明说自己不是当前状态（stale:true）且带真实时间差',
  stale?.history?.stale === true && Number.isFinite(stale?.history?.ageMs) && stale.history.ageMs >= USER_AGE_MS - 5000,
  JSON.stringify({ stale: stale?.history?.stale, ageMs: stale?.history?.ageMs }));
check('(1) ping 本身照旧成功（通道是通的这件事不因旧失败而改变）', stale?.pong === true);

// ── 反向变异：本进程里的失败必须照旧立刻报 ──────────────────
{
  const now = Date.now();
  for (const e of freshFailureEvents(now, 20)) events.push(e);
  const fresh = PING();
  check('(3) 本进程里刚失败的一轮仍然是 lastTurn.failed（范围收窄不能吞掉真的当前失败）',
    fresh?.lastTurn?.failed === true && fresh?.lastTurn?.code === 'MISSING_CREDENTIAL',
    JSON.stringify(fresh?.lastTurn));
  check('(3) 当前失败存在时，history 不再抢戏',
    fresh?.history === null || fresh?.history === undefined,
    JSON.stringify(fresh?.history));
}

// ── 一轮成功之后，当前失败被清掉（老纪律不变）──────────────
{
  const later = Date.now();
  events.push({ type: 'turn/start', seq: 22, time: later - 5, data: { turn: 3 } });
  events.push({ type: 'turn/end', seq: 23, time: later, data: { turn: 3, reason: { kind: 'completed' } } });
  const after = PING();
  check('(4) 成功一轮后 lastTurn 被清掉（灯不永久钉红）', after?.lastTurn === null, JSON.stringify(after?.lastTurn));
}

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;

// ══════════════════════════════════════════════════════════
// 客户端侧：那一行到底怎么画
// ══════════════════════════════════════════════════════════

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
async function bootClient(facts) {
  const react = makeReact();
  let registered = null;
  globalThis.window = {
    __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? react.React : {})); } },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener() {}, removeEventListener() {},
    __reviewRemoteTimeoutMs: 60,
    __reviewLocalTickMs: 1000,
    __reviewProbeIntervalMs: 100000,
    __reviewStaleMs: 5000,
  };
  await import(new URL(`../client.js?scope=${importId++}`, import.meta.url).href);
  let panel = null;
  registered.apply({
    remote: { commands: { execute: () => Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify(facts) } } }) } },
    slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.name === 'shell.overlay') panel = component; } },
  });
  let tree = null;
  const props = {
    sessionId: 's1',
    useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } } } }),
  };
  const render = () => { react.reset(); tree = panel(props); };
  react.onChange(render);
  render();
  return { get tree() { return tree; }, render };
}

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const livenessNode = (tree) => collect(tree, (n) => n.props?.['data-review-liveness'] !== undefined)[0];
const statusOf = (tree) => livenessNode(tree)?.props?.['data-review-liveness'] ?? null;
const textOf = (tree) => JSON.stringify(tree);

const TICK = { enabled: true, intervalMs: 5000, lastAt: Date.now() - 1000, ageMs: 1000, count: 3 };

// ── 场景 A：只有上一次进程的旧失败 ────────────────────────
{
  const facts = {
    ok: true, pong: true, hostNow: Date.now(), tick: TICK,
    scan: { at: Date.now(), ageMs: 0, conversations: 40, targetId: null },
    busy: false, uptimeMs: 1000,
    lastTurn: null,
    history: {
      failed: true, stale: true, code: 'UNKNOWN', message: USER_MESSAGE,
      at: Date.now() - USER_AGE_MS, ageMs: USER_AGE_MS, turn: 1,
    },
  };
  const panel = await bootClient(facts);
  await sleep(15);
  check('(2) 旧失败不把灯打成「跑不起来」——状态必须是已连接 · 监控中',
    statusOf(panel.tree) === 'ok', String(statusOf(panel.tree)));
  check('(2) 旧失败的字样仍然在屏幕上（不许把它藏掉）',
    textOf(panel.tree).includes('non-negative safe integer'));
  check('(2) 它被说成「上一次进程 / 历史」，不是「最近一次运行」',
    collect(panel.tree, (n) => n.props?.['data-review-liveness-history'] !== undefined).length === 1
    && !/跑不起来/.test(textOf(panel.tree)),
    String(collect(panel.tree, (n) => n.props?.['data-review-liveness-history'] !== undefined)[0]?.props?.['data-review-liveness-history']));
  check('(2) 已连接但无审核进行中时不假装在生成',
    collect(panel.tree, (n) => String(n.props?.className ?? '').includes('review-mode-spin')).length === 0);
}

// ── 场景 B：本进程里刚失败 → 仍然是「跑不起来」（老纪律）──
{
  const facts = {
    ok: true, pong: true, hostNow: Date.now(), tick: TICK,
    scan: { at: Date.now(), ageMs: 0, conversations: 40, targetId: null },
    busy: false, uptimeMs: 1000,
    lastTurn: {
      failed: true, code: 'MISSING_CREDENTIAL',
      message: 'no API key for provider route "deepseek-official"',
      at: Date.now() - 3000, ageMs: 3000, turn: 2,
    },
    history: null,
  };
  const panel = await bootClient(facts);
  await sleep(15);
  check('(3) 本进程里的失败仍然降级成「跑不起来」并说出真因',
    statusOf(panel.tree) === 'fail'
    && /跑不起来/.test(textOf(panel.tree))
    && /MISSING_CREDENTIAL/.test(textOf(panel.tree)),
    String(statusOf(panel.tree)));
  check('(3) 「跑不起来」时不画转圈（用户原话：没有连接上就消失）',
    collect(panel.tree, (n) => String(n.props?.className ?? '').includes('review-mode-spin')).length === 0);
  check('(3) 没有旧失败时不画历史行（防恒真）',
    collect(panel.tree, (n) => n.props?.['data-review-liveness-history'] !== undefined).length === 0);
}

// ── 反向变异：范围判据本身不是恒真的 ──────────────────────
{
  const classify = (facts, startedAt) => {
    const failure = facts?.turnOutcome;
    if (failure === null || failure === undefined) return null;
    return Number.isFinite(failure.at) && failure.at >= startedAt ? failure : null;
  };
  check('反向变异：把 startedAt 拉到失败之前，同一条失败又会被当成当前（判据不是恒假）',
    classify({ turnOutcome: { at: USER_AGE_MS } }, USER_AGE_MS - 1) !== null);
  check('反向变异：把 startedAt 放到失败之后，它就不是当前（判据不是恒真）',
    classify({ turnOutcome: { at: USER_AGE_MS } }, USER_AGE_MS + 1) === null);
}

// 客户端源码里不许再出现「只回 lastTurn、完全不看范围」的旧写法。
{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  check('客户端源码里确有「历史失败」这一条专用痕迹（data-review-liveness-history）',
    source.includes('data-review-liveness-history'));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
