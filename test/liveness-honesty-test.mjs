/**
 * 面板活性灯的**诚实性**（用户 2026-10 亲手抓到的谎）。
 *
 * 用户当时看到的两件事**同时**成立：
 *   - 对话区：`本轮运行失败 llm-deepseek: no API key for provider route
 *     "deepseek-official"; … MISSING_CREDENTIAL`（一次都跑不起来）；
 *   - 面板：`✅ 已连接 · 监控中   主机心跳 9 秒前 · 间隔 5s · 上次扫描 40 条对话`
 *     —— 绿的、还在转。
 *
 * 他的原话：「API key 没有连接，它怎么自己还能在那边不断转太多了」。
 * **一个恰好在系统坏掉时报绿的灯，比没有灯更糟**，因为人会被它骗着不去查。
 *
 * 所以这里钉死三件事：
 *   1. `ping` 必须**同时**回「通道答话了」和「最近一次真实运行的结果」——
 *      判据是会话日志里最近一条 `turn/end`（shipped 客户端渲染
 *      「本轮运行失败」用的就是同一条事件，见 `failureOfTurnEnd` 的注释）；
 *   2. 失败时灯**不是绿的、也不转**（转圈元素数为 0），并且**说出到底哪里错了**
 *      （provider route 没凭据）；
 *   3. 它仍然**零成本**：不调模型、不派子 Agent、不碰文件系统、不写会话事件。
 *
 * 客户端侧的渲染断言在 `test/liveness-test.mjs`（那里有带真 effect 的极小 React）。
 */

import fs from 'node:fs';
import { listCodex } from '../reviewer.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 真实的那条失败事件（逐字抄自会话日志 session-5d5b0bb5 的 seq 19）──
const CREDENTIAL_MESSAGE = 'llm-deepseek: no API key for provider route "deepseek-official"; '
  + 'store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), '
  + 'or export DEEPSEEK_API_KEY in the launching environment';

/** 造一条「刚跑完一轮、失败了」的会话事件流。 */
function failingEvents(at = Date.now()) {
  return [
    { type: 'turn/start', seq: 8, time: at - 40, data: { turn: 1 } },
    { type: 'step/start', seq: 11, time: at - 39, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 18, time: at - 2, data: { turn: 1, step: 1 } },
    {
      type: 'turn/end', seq: 19, time: at,
      data: { turn: 1, reason: { kind: 'error', error: { message: CREDENTIAL_MESSAGE, code: 'MISSING_CREDENTIAL' } } },
    },
  ];
}

/** 造一条「后来跑成功了」的事件流后缀。 */
function successEvents(at = Date.now()) {
  return [
    { type: 'turn/start', seq: 20, time: at - 10, data: { turn: 2 } },
    { type: 'assistant/message', seq: 21, time: at - 5, data: {} },
    { type: 'turn/end', seq: 22, time: at, data: { turn: 2, reason: { kind: 'completed' } } },
  ];
}

function makeAgent(events) {
  const appended = [];
  const session = {
    header: { id: 'review-1', cwd: '/w' },
    seq: events.length,
    snapshotEvents: () => events,
    requestHeader: () => ({
      config: { provider: 'deepseek-account', model: 'deepseek-flash' },
      adapterDefaults: {},
    }),
    append(type, data, opts) { appended.push({ type, data, opts }); this.seq += 1; return { type, seq: this.seq, data }; },
  };
  return {
    id: 'review-1',
    options: { provider: 'deepseek-account', model: 'deepseek-flash' },
    session,
    appended,
    injects: [],
    followups: [],
    inject(m) { this.injects.push(m); },
    followup(m) { this.followups.push(m); },
  };
}

let subagentStarts = 0;
let registeredCommands = new Map();
const intervals = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
globalThis.clearInterval = () => {};

const events = failingEvents();
const agent = makeAgent(events);

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
  subagents: {
    start: async () => {
      subagentStarts += 1;
      return { id: 'run-1', result: Promise.resolve({ output: [] }), dispose: async () => {} };
    },
  },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, watchCodex: true });

const definition = registeredCommands.get('review-mode');
const run = (rawInput) => definition.handler({ agent, rawInput, commandId: 'cmd-1', attachments: [], signal: new AbortController().signal });
const PING = () => {
  const result = run('ping');
  return { result, facts: result.kind === 'success' ? JSON.parse(result.text) : null };
};

// ── 1. 通道答话 ≠ 系统能跑 ────────────────────────────────
const first = PING();
check('(1) ping 仍然回 {kind:"success"} + pong（通道是通的，不撒谎说断了）',
  first.result.kind === 'success' && first.facts?.pong === true, JSON.stringify(first.result).slice(0, 90));
check('(1) ping **同时**报出最近一次真实运行失败的判据（lastTurn）',
  first.facts?.lastTurn !== null && first.facts?.lastTurn?.failed === true,
  JSON.stringify(first.facts?.lastTurn));
check('(1) 失败带上 shipped 的同一个错误码 MISSING_CREDENTIAL',
  first.facts?.lastTurn?.code === 'MISSING_CREDENTIAL', String(first.facts?.lastTurn?.code));
check('(1) 失败带上原话，面板能说出「到底哪里不对」',
  /no API key for provider route "deepseek-official"/.test(String(first.facts?.lastTurn?.message ?? '')),
  String(first.facts?.lastTurn?.message ?? '').slice(0, 60));
check('(1) 它同时说明那条 route 要什么凭据（用户不用去翻日志）',
  /DEEPSEEK_API_KEY/.test(String(first.facts?.lastTurn?.message ?? '')));
check('(1) 失败带时间戳（灯的「多久之前」有依据）',
  Number.isFinite(first.facts?.lastTurn?.at) && first.facts.lastTurn.ageMs >= 0,
  JSON.stringify({ at: first.facts?.lastTurn?.at, ageMs: first.facts?.lastTurn?.ageMs }));

// ── 2. 零成本：仍然不许碰盘 / 调模型 / 污染会话 ────────────
const FS_METHODS = ['readFileSync', 'readdirSync', 'statSync', 'existsSync', 'appendFileSync', 'openSync', 'readSync', 'realpathSync', 'lstatSync', 'readlinkSync'];
const originals = {};
let fsCalls = 0;
for (const method of FS_METHODS) {
  if (typeof fs[method] !== 'function') continue;
  originals[method] = fs[method];
  fs[method] = (...args) => { fsCalls += 1; return originals[method](...args); };
}
const fsBase = fsCalls;
listCodex(1000);
check('(2) 正对照：扫一遍 ~/.codex 确实会碰文件系统（探针有效）', fsCalls > fsBase, `fsCalls +${fsCalls - fsBase}`);
const afterScan = fsCalls;
PING(); PING();
check('(2) 折「上一次运行结果」也是零文件系统调用（用的是内存事件快照）',
  fsCalls === afterScan, `fsCalls +${fsCalls - afterScan}`);
for (const method of Object.keys(originals)) fs[method] = originals[method];
check('(2) 零模型：一次子 Agent 都没派', subagentStarts === 0, `starts=${subagentStarts}`);
check('(2) 零污染：没写任何会话事件 / 没投递 / 没唤醒',
  agent.appended.length === 0 && agent.followups.length === 0, `appended=${agent.appended.length}`);

// ── 3. 一轮成功后失败必须消失（否则是另一种说谎）──────────
{
  const later = Date.now();
  for (const e of successEvents(later)) events.push(e);
  const after = PING();
  check('(3) 后面一轮跑成功之后，失败被清掉（灯不该永久钉红）',
    after.facts?.lastTurn === null, JSON.stringify(after.facts?.lastTurn));
  check('(3) 清掉之后 ping 照旧成功', after.facts?.pong === true);
}

// ── 4. 后来**又**失败：仍然立刻重新报出 ───────────────────
{
  const again = Date.now();
  events.push({ type: 'turn/start', seq: 23, time: again - 5, data: { turn: 3 } });
  events.push({ type: 'turn/end', seq: 24, time: again, data: { turn: 3, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } } });
  const after = PING();
  check('(4) 再失败一次也立刻报出来（code 兜底 UNKNOWN）',
    after.facts?.lastTurn?.failed === true && after.facts?.lastTurn?.code === 'UNKNOWN',
    JSON.stringify(after.facts?.lastTurn));
}

// ── 5. 坏输入照旧不抛 ─────────────────────────────────────
check('(5) ping 后面的多余参数被忽略', run('ping now')?.kind === 'success');
check('(5) 未知动词照旧 error',
  (() => { try { return run('nonsense')?.kind === 'error'; } catch { return false; } })());

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
