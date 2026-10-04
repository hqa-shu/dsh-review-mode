/**
 * **点面板不许搅动上面那条对话**（bug 46，2026-10 用户抓到）。
 *
 * 用户原话：「我点了之后你的这个对话框又在乱动了……我如果只点就在审核那边操作，
 * 它不应该跳出任何问题。」
 *
 * 真因（两层，都要说清楚）：
 *   1. **宿主侧**：面板的每一次操作（包括每 20 秒一次的活性 `ping`）都是一条会话命令，
 *      而会话命令的生命周期由 shipped 的 commands 服务落进会话日志：
 *      `dsh-commands/lib/index.js:334`（`command/run`）与 `:341`（`command/done`）。
 *      这是「前端 → 宿主」唯一通道的固有代价，第三方插件关不掉。
 *   2. **客户端侧（我们自己加的、可以去掉的）**：`conversation.chat.commandview` 这个
 *      keyed 插槽的专用视图一直在替它**画一行可见的字**（旧 `ReviewCommandLine`：
 *      `🔍 审核 · 读对话目录` / `🔍 审核 · 面板操作`）。对话流本来会为这条命令渲染
 *      一个节点（`dsh-client-ui-chat/lib/client.js:6808-6816` 的 `CommandNodeView`），
 *      我们那行字就是用户看到的「对话框又在乱动」。
 *
 * 改法：这个专用视图**什么都不画**（返回 `null`）。命令节点于是只剩
 * `CommandNodeView` 的那个空 `callRow`（`dsh-client-ui-chat/lib/client.js:6134-6146`），
 * 没有任何可读内容、没有高度、也不会带出 `command/done.text` 里的 JSON。
 *
 * 面板本身是 `position: fixed` 的浮层（`client.js` 的 `rootStyle`），不参与对话列布局，
 * 所以它不是这次「乱动」的原因 —— 这条也钉在这里，免得下次又去怪浮层。
 */

import { readFileSync } from 'node:fs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 有状态的极小 React（只为把组件挂起来；不点任何东西）────
let cursor = 0;
const stateSlots = [];
let rerender = () => {};
const FakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  useState(initial) {
    const index = cursor;
    cursor += 1;
    if (!(index in stateSlots)) stateSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [stateSlots[index], (next) => { stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next; rerender(); }];
  },
  useRef(value) { return { current: value }; },
  useEffect() {},
};

let registered = null;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? FakeReact : {})); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {}, removeEventListener() {},
};

let panel = null;
let commandView = null;
let commandViewMeta = null;
await import('../client.js');
if (registered === null) { console.log('FAIL  模块没注册'); process.exit(1); }
registered.apply({
  remote: { commands: { execute: () => Promise.resolve({ ok: true, value: undefined }) } },
  slots: {
    inject: (name, fn) => fn(),
    register: (meta, component) => {
      if (meta.id === 'review-mode-panel') panel = component;
      if (meta.key === 'review-mode') { commandView = component; commandViewMeta = meta; }
    },
  },
});

check('面板注册了 `conversation.chat.commandview` 的 `review-mode` 专用视图',
  commandView !== null && commandViewMeta?.name === 'conversation.chat.commandview',
  JSON.stringify(commandViewMeta));

// ── 专用视图必须**什么都不画**（四种面板命令、成功/失败都要）──
const NODES = [
  { name: 'review-mode', args: 'dir codex', outcome: { kind: 'success', text: '{"recent":[]}' } },
  { name: 'review-mode', args: 'pick codex a1', outcome: { kind: 'success', text: '{"ok":true}' } },
  { name: 'review-mode', args: 'ask 为什么这么说', outcome: { kind: 'success', text: '因为……' } },
  { name: 'review-mode', args: 'ping', outcome: { kind: 'success', text: '{"pong":true}' } },
  { name: 'review-mode', args: 'dir codex', outcome: { kind: 'error', text: '通道断了' } },
];
const outputs = NODES.map((node) => commandView({ node }));
check('面板命令在对话流里渲染为 `null`（一个字都不出现）',
  outputs.every((out) => out === null),
  JSON.stringify(outputs.map((out) => (out === null ? 'null' : String(out).slice(0, 40)))));
check('连 `command/done.text` 里的 JSON 也不会漏出来',
  outputs.every((out) => out === null) && !JSON.stringify(outputs).includes('recent'));

// 反向变异：旧的那行可见字，同一条判据必须为假。
const FakeH = FakeReact.createElement;
const oldVisible = FakeH('div', { 'data-review-command': '1' }, '🔍 审核 · 读对话目录');
check('反向变异：旧的那行可见字会让「什么都不画」这条判据为假',
  outputs.every((out) => out === null) && oldVisible !== null && oldVisible !== undefined,
  JSON.stringify(oldVisible).slice(0, 60));

// ── 源码纪律：旧的那行可见字已经彻底删掉 ───────────────────
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const hasOldNode = (code) => code.includes("'data-review-command'") || code.includes('🔍 审核 ·');
check('源码里不再有 `data-review-command` 这个可见节点', hasOldNode(source) === false);
check('反向变异：把旧节点拼回去，同一条判据会变红',
  hasOldNode(source) === false && hasOldNode(`${source}\nconst x = 'data-review-command';`) === true);

// ── 面板浮层不参与对话列布局（所以它不是「乱动」的原因）──────
check('面板根节点是 `position: fixed`（浮层，不占对话列布局）',
  /const rootStyle = open \? \{[\s\S]{0,200}?position: 'fixed'/.test(source));
check('但**同时**预留一列：注入把 shell 的 frame 挤窄的 CSS（padding-right + !important）',
  /RESERVE_CSS/.test(source)
  && /padding-right:var\(--review-reserved-w,0px\) !important/.test(source)
  && /data-review-reserved/.test(source));

// ── 宿主侧：面板操作只投**对话流看不见**的面事件 ──
// `user/message` + 生产者自有的 `source.kind`（不是 `developer/message`：
// 那类是步事件，必须落在开着的 turn+step 里，异步投递做不到）。
{
  const appended = [];
  const agent = {
    id: 'review-1',
    session: {
      header: { id: 'review-1', cwd: '/w' },
      seq: 3,
      snapshotEvents: () => [
        { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '哨兵_安静面板' }] } },
        { type: 'tool/call', seq: 2, data: { name: 'read' } },
      ],
      append(type, data, opts) { appended.push({ type, data, opts }); this.seq += 1; return appended[appended.length - 1]; },
    },
    followups: [], injects: [],
    followup(m) { this.followups.push(m); },
    inject(m) { this.injects.push(m); },
  };
  const registeredCommands = new Map();
  const mod = await import(new URL('../index.js', import.meta.url).pathname);
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };
  mod.apply({
    logger: { warn: () => {}, info() {} },
    reflect: { provide: () => {}, get: () => undefined },
    effect: (fn) => fn(),
    on: () => {},
    inject: (names, cb) => cb({
      effect: (fn) => fn(),
      commands: { register(definition) { registeredCommands.set(definition.name, definition); return () => {}; } },
    }),
    sessionProjections: { register: () => () => {}, stateOf: (s, k) => (k === 'agentPreset' ? 'review' : null) },
    subagents: {
      start: async () => ({
        id: 'rev-1',
        result: Promise.resolve({ output: [{ type: 'text', text: '结论: on-track\n一句话: 没问题\n## 具体对话\n- 你：「继续」\n## 对话概述\n在收尾。\n## 分析\n- 无明显问题。\n## 建议\n- [给Agent] 继续。' }] }),
        dispose: async () => {},
      }),
    },
    agents: { list: () => [agent], get: () => agent, withoutInitiator: (op) => op() },
  }, { watchCodex: false, watchIntervalMs: 5000 });

  const definition = registeredCommands.get('review-mode');
  definition.handler({ agent, rawInput: 'dir self', commandId: 'cmd-1', attachments: [], signal: new AbortController().signal });
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('面板操作往会话里写的只有 `user/message` + `source.kind=review-mode`（客户端把它画成 context，看不见）',
    appended.length > 0
    && appended.every((event) => event.type === 'user/message' && event.data?.source?.kind === 'review-mode'),
    JSON.stringify(appended.map((e) => [e.type, e.data?.source?.kind])));
  check('**没有** `source.kind=user` 的消息 / 零 inject / 零 followup —— 对话区一个字都没多',
    appended.every((event) => !(event.type === 'user/message' && event.data?.source?.kind === 'user'))
    && agent.injects.length === 0 && agent.followups.length === 0,
    `injects=${agent.injects.length} followups=${agent.followups.length}`);
  check('投出来的面事件带 surfaceOp=append，且**不是** developer/message（那类必须落在开着的 step 里）',
    appended.every((event) => event.opts?.surfaceOp === 'append' && event.type !== 'developer/message'),
    JSON.stringify(appended.map((e) => e.type)));
  for (const id of timers) clearInterval(id);
  globalThis.setInterval = realSetInterval;
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
