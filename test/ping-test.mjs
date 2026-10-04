/**
 * 活性心跳（`ping`）的宿主侧证明。
 *
 * 用户的原话：「您那边如果一直不动……你要不弄一个一直在转的帮我显示他在连接……
 * 连接上那就在转，没有连接上就消失，不然我不知道他有没有（在工作）」。
 *
 * 面板是从 `reviewMode` 投影渲染的，用户不发消息 → 没有会话事件 → 投影不变 →
 * 面板一次都不重画。所以「安静地在干活」和「已经死了」长得一模一样。
 * 客户端必须有一个**真的**心跳：走已经打通的 `commands` 通道调 `/review-mode ping`。
 *
 * 这个测试钉死 ping 的四条硬要求（每一条都是用户明说的）：
 *   1. **真的回话**：`{kind:'success'}` + `pong:true`，并带上监控器最近的 tick 事实
 *      （最后一次 tick 什么时候 · tick 间隔 · 上次扫描看到几条对话）；
 *   2. **零成本**：不调模型 / 不派子 Agent —— 一次心跳 `subagents.start` 都不许被调用；
 *   3. **零扫描**：不碰文件系统（`~/.codex` 一根毛都不读）—— 用**探针**证明，
 *      并且用「直接扫一遍确实会碰 fs」当正对照，防止探针本身是坏的；
 *   4. **零污染**：不 append 任何会话事件、不 followup、不 inject —— 对话记录里
 *      不会因为心跳多出一个字符。
 *
 * 另外：`ping` 永不抛；未知动词照旧返回 error。
 */

import fs from 'node:fs';
import { listCodex } from '../reviewer.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 假宿主 ────────────────────────────────────────────────
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
let subagentStarts = 0;
let projection = null;
const registeredCommands = new Map();
const childScopes = [];
const intervals = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
// 只**捕获**定时器，不让它真的跑 —— 测试要自己决定什么时候 tick。
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
globalThis.clearInterval = () => {};

const mod = await import(new URL('../index.js', import.meta.url).pathname);
const topInject = mod.inject;
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
    childScopes.push(scope);
    cb(scope);
  },
  sessionProjections: {
    register: (def) => { projection = def; return () => {}; },
    stateOf: (s, k) => (k === 'agentPreset' ? 'review' : null),
  },
  // 一次心跳都不许走这里。
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

check('注册形状没变：顶层 inject 不含 commands',
  JSON.stringify(topInject) === JSON.stringify(['sessionProjections', 'subagents', 'agents']),
  JSON.stringify(topInject));
check('命令声明里加了 ping 动词',
  typeof definition?.input?.hint === 'string' && definition.input.hint.includes('ping'),
  String(definition?.input?.hint));
check('宿主 watchdog 只登记了 1 个定时器（间隔 5000ms）',
  intervals.length === 1 && intervals[0].ms === 5000,
  JSON.stringify(intervals.map((i) => i.ms)));

// ── 1. tick 之前：ping 也必须有话可回 ─────────────────────
const before = PING();
check('ping 返回 {kind:"success"}（不是 error，normalizeResult 才不会抛）',
  before.result.kind === 'success', JSON.stringify(before.result).slice(0, 100));
check('ping 带 pong:true', before.facts?.pong === true);
check('ping 报出 tick 间隔（5000ms）与监控开关',
  before.facts?.tick?.intervalMs === 5000 && before.facts?.tick?.enabled === true,
  JSON.stringify(before.facts?.tick));
check('还没 tick 过时 lastAt 是 null（如实报，不编）',
  before.facts?.tick?.lastAt === null && before.facts?.tick?.count === 0,
  JSON.stringify(before.facts?.tick));

// ── 2. 零扫描：文件系统探针 + 正对照 ──────────────────────
const FS_METHODS = ['readFileSync', 'readdirSync', 'statSync', 'existsSync', 'appendFileSync', 'openSync', 'readSync', 'realpathSync', 'lstatSync', 'readlinkSync'];
const originals = {};
let fsCalls = 0;
for (const method of FS_METHODS) {
  if (typeof fs[method] !== 'function') continue;
  originals[method] = fs[method];
  fs[method] = (...args) => { fsCalls += 1; return originals[method](...args); };
}
const base = fsCalls;
listCodex(1000);
check('正对照：扫一遍 ~/.codex 确实会碰文件系统（证明探针有效）', fsCalls > base, `fsCalls +${fsCalls - base}`);
const afterScan = fsCalls;
const p1 = PING();
const p2 = PING();
check('ping 零文件系统调用：不扫 ~/.codex', fsCalls === afterScan, `fsCalls +${fsCalls - afterScan}`);
check('两次 ping 都成功且内容一致（幂等、无副作用）',
  p1.facts?.pong === true && p2.facts?.pong === true && JSON.stringify(p1.facts.tick) === JSON.stringify(p2.facts.tick));
for (const method of Object.keys(originals)) fs[method] = originals[method];

// ── 3. 零模型 / 零污染 ────────────────────────────────────
check('ping 没有派任何子 Agent（零模型）', subagentStarts === 0, `starts=${subagentStarts}`);
check('ping 没有 append 任何会话事件（对话记录零污染）', appended.length === 0, `appended=${appended.length}`);
check('ping 没有 followup / inject（不唤醒、不打断）',
  agent.followups.length === 0 && agent.injects.length === 0,
  `followups=${agent.followups.length} injects=${agent.injects.length}`);
check('ping 不依赖 agent 参数（agent 为 undefined 也照回）',
  definition.handler({ agent: undefined, rawInput: 'ping' })?.kind === 'success');

// ── 4. 真的 tick 一次：ping 报出监控器的事实 ──────────────
// 面板上「主机心跳 N 秒前 · 间隔 5s · 上次扫描 M 条对话」就靠这一段。
const tick = intervals[0].fn;
tick();
const deadline = Date.now() + 4000;
let after = PING();
while ((after.facts?.tick?.count ?? 0) === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  after = PING();
}
check('tick 之后 ping 报出「最后一次 tick 是什么时候」',
  typeof after.facts?.tick?.lastAt === 'number' && after.facts.tick.ageMs >= 0,
  JSON.stringify(after.facts?.tick));
check('tick 之后 tick.count 增长（宿主确实在跑）', after.facts?.tick?.count >= 1, String(after.facts?.tick?.count));
const realTotal = listCodex(1000).length;
check('ping 报出「上次扫描看到几条对话」且与真实目录一致',
  after.facts?.scan?.conversations === realTotal && realTotal > 0,
  `scan=${after.facts?.scan?.conversations} real=${realTotal}`);
check('scan 事实来自**上一次真实扫描**，不是 ping 现算的（scan.at 是数字）',
  typeof after.facts?.scan?.at === 'number');

// ping 仍然零扫描（用新的探针窗口再验一次）
let fsCalls2 = 0;
const originals2 = {};
for (const method of FS_METHODS) {
  if (typeof fs[method] !== 'function') continue;
  originals2[method] = fs[method];
  fs[method] = (...args) => { fsCalls2 += 1; return originals2[method](...args); };
}
PING();
check('tick 之后 ping 仍然零文件系统调用', fsCalls2 === 0, `fsCalls=${fsCalls2}`);
for (const method of Object.keys(originals2)) fs[method] = originals2[method];

// ── 5. 坏输入不抛 ─────────────────────────────────────────
for (const bad of ['', 'nonsense']) {
  let result;
  let threw = false;
  try { result = run(bad); } catch { threw = true; }
  check(`坏输入 ${JSON.stringify(bad)} 返回 error 且不抛`,
    !threw && result?.kind === 'error', threw ? '抛了' : JSON.stringify(result).slice(0, 80));
}
check('ping 后面的多余参数被忽略（不是 error）', run('ping now please')?.kind === 'success');

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
