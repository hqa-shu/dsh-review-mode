/**
 * **面板只在「你正在看的那个审核会话」里出现**（bug 44），而且
 * **面板的落点 = 宿主投递的落点，同一个会话 id**（bug 45，就是「面板一直空着」）。
 *
 * 用户 2026-10 的原话：
 *   1.「为什么我没有选那个模式，它右边也会跳出来？这应该只有选那个模式之后才会这样吧？」
 *   2.「现在你还是在审核面板那边还是什么都没有。」
 *
 * 改前的真因（`client.js` 的 `storeSessionId` 选择器）：`shell.overlay` 是 root 作用域、
 * 没有 `sessionId`，于是组件在会话 store 里「找一条 `agentPreset === 'review'` 的」，
 * 而且**找不到正在主栏显示的那条就退回任意一条**（它自己的注释写着「宁可多显示一处，
 * 也绝不让面板消失」）。那条优先级是反的：
 *   - 别的模式下（视野里是 standard，store 里另有一条 review）→ 面板照样跳出来；
 *   - 面板认的那条 ≠ 你正在看的那条 → 面板读的 `reviewMode` 投影不是复审结果落进去的那份
 *     → 面板一直空着。
 *
 * 现在的判据（shipped 源码的同一形状：`dsh-client-ui-cordis/lib/client.js:741`、
 * `dsh-client-ui-layout/lib/client.js:60`、`dsh-client-ui-session/lib/client.js:283`
 * 都用 `(session.retainedBy.mainView ?? 0) > 0` 认「当前会话」）：
 *   - 正在主栏显示的会话 `agentPreset === 'review'` → 面板出现；
 *   - 正在显示的不是 review → **完全不存在**（一个字都不出现）；
 *   - 认不出正在显示哪条 → **完全不存在**（宁可不显示，也不在别的会话里显示）。
 *
 * 后半段是端到端对账：面板发出的命令带的是哪个 sessionId，宿主的
 * `invocation.agent` 就必须是同一条；折出来的 `feed` 也必须落在同一条投影里。
 */

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 有状态的极小 React（和 client-test 同款）───────────────
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
    return [stateSlots[index], (next) => {
      stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next;
      rerender();
    }];
  },
  useRef(value) { return { current: value }; },
  useEffect() {},
};

const calls = [];
const reply = (text) => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text } } });
const DIRECTORY = { kind: 'self', total: 0, recent: [], groups: [], selected: null };
const fakeRemote = {
  commands: {
    execute(sessionId, line) {
      calls.push([sessionId, line]);
      return Promise.resolve(reply(JSON.stringify(DIRECTORY)));
    },
  },
};

let registered = null;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? FakeReact : {})); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {}, removeEventListener() {},
};

let panel = null;
await import('../client.js');
if (registered === null) { console.log('FAIL  模块没注册'); process.exit(1); }
registered.apply({
  remote: fakeRemote,
  slots: {
    inject: (name, fn) => fn(),
    register: (meta, component) => { if (meta.id === 'review-mode-panel') panel = component; },
  },
});

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const directions = (tree) => collect(tree, (n) => n.props?.['data-review-direction'] !== undefined);
const renderRoot = (byId) => {
  let tree = null;
  stateSlots.length = 0;   // 每个用例都是独立的一次挂载（后面的点击会让它自己重画）
  rerender = () => { cursor = 0; tree = panel({ useSessions: (selector) => selector({ byId }) }); };
  rerender();
  return tree;
};
const renderScoped = (sessionId, byId) => {
  let tree = null;
  stateSlots.length = 0;
  rerender = () => { cursor = 0; tree = panel({ sessionId, useSessions: (selector) => selector({ byId }) }); };
  rerender();
  return tree;
};

const REVIEW = { projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } };
const REVIEW_IN_VIEW = { r1: { ...REVIEW, retainedBy: { mainView: 1 } } };

// ── 1. 审核会话在视野里 → 面板出现 ─────────────────────────
check('审核会话正在主栏显示 → 面板出现（三个方向）',
  directions(renderRoot(REVIEW_IN_VIEW)).length === 3,
  JSON.stringify(directions(renderRoot(REVIEW_IN_VIEW)).map((n) => n.props['data-review-direction'])));

// ── 2. 非审核会话在视野里 → 面板一个字都不出现 ──────────────
// store 里**另有一条**审核会话（改前就是它把面板拉出来的）。
const NON_REVIEW_IN_VIEW = {
  s1: { retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard', reviewMode: { feed: [] } } },
  r1: { projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } },
};
check('非审核会话正在显示（store 里另有一条审核会话）→ 面板完全不存在',
  renderRoot(NON_REVIEW_IN_VIEW) === null,
  JSON.stringify(renderRoot(NON_REVIEW_IN_VIEW) === null));

// ── 3. 认不出在看的会话 → 面板完全不存在 ────────────────────
check('认不出正在显示哪条会话（没有任何 retainedBy.mainView）→ 面板完全不存在',
  renderRoot({ r1: REVIEW }) === null,
  JSON.stringify(renderRoot({ r1: REVIEW }) === null));

// ── 4. 会话作用域插槽给了 sessionId → 照旧按它渲染（行为不变）──
check('会话作用域插槽给了 sessionId → 照样按那条会话的预设渲染',
  directions(renderScoped('s1', { s1: REVIEW })).length === 3);
check('会话作用域插槽给的会话不是审核模式 → 照样不渲染',
  renderScoped('s1', { s1: { projectionValues: { agentPreset: 'standard' } } }) === null);

// ── 5. 多条审核会话：认正在显示的那条 ───────────────────────
{
  const tree = renderRoot({
    bg: { projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } },
    on: { ...REVIEW, retainedBy: { mainView: 1 } },
  });
  calls.length = 0;
  collect(tree, (n) => n.props?.['data-review-direction'] === 'codex')[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('多条审核会话时，命令发到**正在主栏显示**的那条（on）',
    calls.length === 1 && calls[0][0] === 'on',
    JSON.stringify(calls));
}

// ── 6. 端到端对账：面板落点 = 宿主投递落点（bug 45 的真因）────
{
  calls.length = 0;
  const tree = renderRoot(REVIEW_IN_VIEW);   // r1 在视野里
  collect(tree, (n) => n.props?.['data-review-direction'] === 'self')[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const panelSessionId = calls[0]?.[0];
  check('面板把命令发到**正在看的那条会话**（r1）', panelSessionId === 'r1', JSON.stringify(calls));

  // ── 宿主侧：真的注册一次命令，用**面板报上来的那个 sessionId** 对应的 agent 执行 ──
  const appended = new Map([['r1', []], ['bg', []]]);
  const mkHostAgent = (id) => ({
    id,
    session: {
      header: { id, cwd: '/w' },
      seq: 3,
      snapshotEvents: () => [
        { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `哨兵_${id}_把界面也改一下` }] } },
        { type: 'tool/call', seq: 2, data: { name: 'read' } },
      ],
      append(type, data, opts) {
        const row = { type, seq: this.seq, data, opts };
        appended.get(id).push(row);
        this.seq += 1;
        return row;
      },
    },
    followups: [],
    injects: [],
    followup(m) { this.followups.push(m); },
    inject(m) { this.injects.push(m); },
  });
  const hostAgents = { r1: mkHostAgent('r1'), bg: mkHostAgent('bg') };

  const hostCommands = new Map();
  let projection = null;
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };
  const mod = await import(new URL('../index.js', import.meta.url).pathname);
  mod.apply({
    logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
    reflect: { provide: () => {}, get: () => undefined },
    effect: (fn) => fn(),
    on: () => {},
    inject: (names, cb) => cb({
      effect: (fn) => fn(),
      commands: { register(definition) { hostCommands.set(definition.name, definition); return () => {}; } },
    }),
    sessionProjections: {
      register: (def) => { projection = def; return () => {}; },
      stateOf: (s, k) => (k === 'agentPreset' ? 'review' : null),
    },
    subagents: {
      start: async () => ({
        id: 'rev-1',
        result: Promise.resolve({ output: [{ type: 'text', text: '结论: drifting\n① 主题漂移: 面板哨兵\n② 局部纠结: 无\n③ 选择理性: 合理\n建议: 收窄' }] }),
        dispose: async () => {},
      }),
    },
    agents: { list: () => [hostAgents.bg, hostAgents.r1], get: (id) => hostAgents[id], withoutInitiator: (op) => op() },
  }, { watchCodex: false, watchIntervalMs: 5000 });
  const pickReviewParent = mod.pickReviewParent;

  const definition = hostCommands.get('review-mode');
  check('宿主注册了 review-mode 命令（对账的前提）', definition !== undefined);
  const targetAgent = hostAgents[panelSessionId];
  const result = definition.handler({ agent: targetAgent, rawInput: 'dir self', commandId: 'cmd-1', attachments: [], signal: new AbortController().signal });
  check('宿主用**面板报上来的 sessionId** 对应的 agent 执行（dir self 返回 success）',
    result?.kind === 'success', String(result?.kind));
  check('对账：宿主投递的目标就是面板会话（同一个 id）',
    appended.get('r1').length > 0 && appended.get('bg').length === 0,
    `r1=${appended.get('r1').length} bg=${appended.get('bg').length}`);

  await new Promise((resolve) => setTimeout(resolve, 30));
  const foldInto = (id) => {
    let state = projection.init(hostAgents[id].session.header, 0);
    for (const event of appended.get(id)) state = projection.apply(state, { type: event.type, seq: event.seq, data: event.data });
    return state;
  };
  const r1State = foldInto('r1');
  const bgState = foldInto('bg');
  check('面板会话的投影长出 feed（面板有内容，不是空的）',
    r1State.feed.length === 1, `r1 feed=${r1State.feed.length}`);
  check('另一条审核会话的 feed 仍然是 0（复审没有被写到别处）',
    bgState.feed.length === 0, `bg feed=${bgState.feed.length}`);
  check('零 inject / 零 followup —— 上面那条对话区一个字都没多',
    hostAgents.r1.injects.length === 0 && hostAgents.r1.followups.length === 0
    && hostAgents.bg.injects.length === 0 && hostAgents.bg.followups.length === 0,
    `injects=${hostAgents.r1.injects.length} followups=${hostAgents.r1.followups.length}`);

  // ── 监控器（宿主 tick）的落点也要跟面板一致 ──────────────
  // 面板只画「正在显示」的那条；监控器原来固定取 agents.list()[0]（这里是 bg），
  // 两条审核会话同时开着时它会把结论写进看不见的那条 —— 面板又空着（bug 45 的最后一处）。
  const pingResult = definition.handler({ agent: hostAgents.r1, rawInput: 'ping', commandId: 'cmd-2', attachments: [], signal: new AbortController().signal });
  const snapshot = JSON.parse(pingResult.text);
  const listed = [hostAgents.bg, hostAgents.r1];   // 故意把**别的**会话放在第一条
  check('面板命令就地记下「在跟哪条会话打交道」（ping 快照里报出来）',
    snapshot.panelSessionId === 'r1', String(snapshot.panelSessionId));
  check('监控器的复审落点优先选**面板那条**会话（不是列表第一条）',
    pickReviewParent(listed, snapshot.panelSessionId) === hostAgents.r1);
  check('反向变异：没记过 / 会话已关时，退回老行为（列表第一条）',
    pickReviewParent(listed, null) === hostAgents.bg
    && pickReviewParent(listed, 'closed-session') === hostAgents.bg);
  check('反向变异：不偏好时，落点确实不是面板那条（否则上一条恒真）',
    pickReviewParent(listed, null) !== hostAgents.r1);

  for (const id of timers) clearInterval(id);
  globalThis.setInterval = realSetInterval;
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
