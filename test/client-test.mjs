/**
 * 面板的冒烟测试（普通 Node，不用重启）。
 *
 * 用一个**有状态**的极小 React 把组件渲染成树，于是能真的走一遍：
 *   状态 1 点「审 Codex」→ 状态 2 出目录 → 点一条 → 状态 3 出问/答。
 * 另外覆盖两件必须成立的事：
 *   - 远程调用**永不 settle** 时必须超时并显示一句话，**不能**停在「读目录…」；
 *   - 面板上有一行诊断，写清浏览器看到的 `ctx.remote` / `reviewRemote` / typeof。
 * 这是"点击传回宿主"在客户端这一半的证明（宿主那一半由 remote-test 覆盖）。
 */

// ── 有状态的极小 React ────────────────────────────────────
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

// ── 假的宿主入口（形状照 remote.commands.execute 的结果信封）──
// 面板**只**走这条通道：`ctx.remote.commands.execute(sessionId, line, [])`。
const calls = [];
const RECENT = [
  { id: 'a1', kind: 'codex', project: '5005复习', title: '细节问答', label: '5005复习 / 细节问答', age: '3 分钟前' },
  { id: 'a2', kind: 'codex', project: '5005复习', title: '试卷', label: '5005复习 / 试卷', age: '昨天' },
];
const DIRECTORY = {
  kind: 'codex',
  total: 3,
  recent: RECENT,
  groups: [
    { project: '5005复习', count: 2, conversations: [{ id: 'a1', kind: 'codex', title: '细节问答', age: '3 分钟前' }, { id: 'a2', kind: 'codex', title: '试卷', age: '昨天' }] },
    { project: '5008复习', count: 1, conversations: [{ id: 'b1', kind: 'codex', title: '期中考试原卷', age: '2 天前' }] },
  ],
  selected: null,
};
const EVIDENCE = { title: '5005复习 / 细节问答', cwd: '/tmp/review-fixture/Desktop/5005', youSaid: ['你查查课件，课件当中有讲这几个算法吗？'], background: [], stats: '你说 1 条' };
const commandReply = (text) => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text } } });
const fakeRemote = {
  commands: {
    execute(sessionId, line) {
      calls.push(['execute', sessionId, line]);
      const verb = String(line).trim().split(/\s+/)[1];
      if (verb === 'dir') return Promise.resolve(commandReply(JSON.stringify(DIRECTORY)));
      if (verb === 'pick') return Promise.resolve(commandReply(JSON.stringify({ ok: true, evidence: EVIDENCE })));
      if (verb === 'ask') return Promise.resolve(commandReply('按「① 主题漂移」这一行：5005复习=你从整理滑到转格式'));
      return Promise.resolve({ ok: true, value: undefined });
    },
  },
};

let registered = null;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? FakeReact : {})); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {}, removeEventListener() {},
  // 把硬超时缩短到 60ms，这样「远程永不返回」的用例不用等满 4 秒。
  __reviewRemoteTimeoutMs: 60,
};

let panel = null;
const slotNames = [];
await import('../client.js');
if (registered === null) { console.log('FAIL  模块没注册'); process.exit(1); }
registered.apply({
  remote: fakeRemote,
  slots: {
    inject: (name, fn) => fn(),
    register: (meta, component) => {
      slotNames.push(meta.name);
      if (meta.id === 'review-mode-panel') { panel = component; globalThis.__dockMeta = meta; }
      if (meta.key === 'review-mode') globalThis.__meta = meta;
    },
  },
});

let bad = 0;
const check = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`);
  if (!pass) bad += 1;
};
check('面板注册在 shell.overlay（frame 级右侧常驻区）',
  slotNames.includes('shell.overlay') && globalThis.__dockMeta?.id === 'review-mode-panel',
  slotNames.join(', '));
check('面板**不再**注册在 conversation.input.dock（那正是用户抱怨的「跳进输入框」的地方）',
  !slotNames.includes('conversation.input.dock') && !slotNames.includes('conversation.composer'),
  slotNames.join(', '));
check('同时注册了面板命令在对话流里的一行小字（key = review-mode）',
  globalThis.__meta?.name === 'conversation.chat.commandview' && globalThis.__meta?.key === 'review-mode',
  JSON.stringify(globalThis.__meta));
// 这里曾经断言「必须 inject remote + remote.reviewRemote」。**那个断言是错的，而且它害得
// 整个应用打不开**：cordis 的 inject 是**硬依赖**（见 cordis `Inject.resolve()`，
// 每个名字都变成 required），服务没到插件就一直 pending，web boot 把
// "1 entry did not activate" 当启动失败。
//
// 现在的断言反过来 —— 把这条铁律钉死：
//   inject 里只许放**已证实必然存在**的服务；remote 一律在调用点 try/catch 里现摸。
check('inject 声明了 slots（唯一确定必需的服务）', Array.isArray(registered.inject) && registered.inject.includes('slots'));
check('inject 里绝不含 remote（硬依赖会把整个应用挂在启动上）', !registered.inject.some((name) => name === 'remote' || name.startsWith('remote.')));
check('inject 只有已证实必然存在的服务', registered.inject.every((name) => name === 'slots'));

const propsFor = (preset, projection) => ({
  sessionId: 's1',
  useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: preset, reviewMode: projection } } } }),
});

let props = propsFor('standard', { feed: [] });
let tree = null;
rerender = () => { cursor = 0; tree = panel(props); };
rerender();
check('非审核模式不渲染', tree === null);

// ── 状态 1 ────────────────────────────────────────────────
props = propsFor('review', { feed: [] });
rerender();
const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const byDirection = (t, value) => collect(t, (n) => n.props?.['data-review-direction'] === value)[0];
const byTarget = (t, id) => collect(t, (n) => n.props?.['data-review-target'] === id)[0];
const hasText = (t, text) => JSON.stringify(t).includes(text);

const directions = collect(tree, (n) => n.props?.['data-review-direction'] !== undefined);
check('状态 1 有三个方向按钮', directions.length === 3);
check('方向是 self/dsh/codex', JSON.stringify(directions.map((d) => d.props['data-review-direction'])) === JSON.stringify(['self', 'dsh', 'codex']));

// ── 版式：面板是**右侧自己的一列**，不是输入框里的一张卡 ─────────
// 用户原话：「把审核的这个面板放在最上面或者最右边，对话框放在最下面或者最左边」
// 「我点了之后，审核面板会跳，对话框那边也会跳，它有相冲突」。
const panelRoot = () => collect(tree, (n) => n.props?.['data-review-mode'] === 'panel')[0];
check('面板根节点是**右侧常驻列**（position:fixed + right 锚定 + 自带 pointer-events）',
  panelRoot()?.props?.style?.position === 'fixed'
  && panelRoot()?.props?.style?.right !== undefined
  && panelRoot()?.props?.style?.pointerEvents === 'auto'
  && panelRoot()?.props?.['data-review-region'] === 'right',
  JSON.stringify(panelRoot()?.props?.style ?? null).slice(0, 180));

// ── 会话从哪来：root 级 overlay 不给 `sessionId`，组件必须自己认 ──
// `shell.overlay` 是 root 作用域，standard props 里**没有** `sessionId`
// （catalogue: shell.overlay 的 standardProps 只有 useSessions / useSessionStatus …）。
// 自己认的判据是 shipped 源码认「当前会话」用的那一句：`retainedBy.mainView > 0`
// （`dsh-client-ui-cordis/lib/client.js:741`、`dsh-client-ui-layout/lib/client.js:60`）。
props = { useSessions: (selector) => selector({ byId: { s1: { retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } } } }) };
rerender();
check('overlay 不给 sessionId 时，面板自己从会话 store 里认出**正在显示**的审核会话',
  collect(tree, (n) => n.props?.['data-review-direction'] !== undefined).length === 3,
  JSON.stringify(tree).slice(0, 120));
props = { useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } } } }) };
rerender();
check('认不出正在显示哪条会话时，面板**完全不出现**（宁可不显示，也不在别的会话里显示）', tree === null);
props = { useSessions: (selector) => selector({ byId: { z9: { retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard', reviewMode: { feed: [] } } } } }) };
rerender();
check('store 里没有审核会话时，右侧这一列不出现（非审核模式零渲染）', tree === null);
// 多条审核会话同时存在时，优先「正在主栏显示」的那条
// （shipped `dsh-client-ui-session` 判当前会话用的就是 `retainedBy.mainView > 0`）。
calls.length = 0;
props = { useSessions: (selector) => selector({ byId: {
  bg: { projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } },
  on: { retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } },
} }) };
rerender();
byDirection(tree, 'codex').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check('store 里有多条审核会话时，认**正在主栏显示**的那条（retainedBy.mainView > 0）',
  calls.some(([, sid]) => sid === 'on') && !calls.some(([, sid]) => sid === 'bg'),
  JSON.stringify(calls));
calls.length = 0;
// 刚才那次点击把面板推进了状态 2 —— 点「返回」回到状态 1，后面的流程照旧。
collect(tree, (n) => typeof n.props?.children === 'string' && n.props.children.startsWith('← 返回'))[0]?.props?.onClick();
props = propsFor('review', { feed: [] });
rerender();

// ── 点「审 Codex」→ 状态 2 ────────────────────────────────
const commandLines = () => calls.map(([, , line]) => line);
byDirection(tree, 'codex').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check('点方向 → 调 ctx.remote.commands.execute("/review-mode dir codex")',
  commandLines().includes('/review-mode dir codex'), commandLines().join(' | '));
check('点方向**不再**碰 reviewRemote',
  !calls.some(([, , line]) => String(line).includes('reviewRemote')));
check('状态 2 有「最近」段', hasText(tree, '最近'));
check('状态 2 出现项目名「5005复习」', hasText(tree, '5005复习'));
check('状态 2 出现对话标题「细节问答」', hasText(tree, '细节问答'));
check('状态 2 出现「返回」', hasText(tree, '返回'));

// ── 点一条对话 → 状态 3 ───────────────────────────────────
const target = byTarget(tree, 'a1');
check('目录条目是可点按钮', target !== undefined && typeof target.props.onClick === 'function');
target.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check('点对话 → 调 commands.execute("/review-mode pick codex a1")',
  commandLines().includes('/review-mode pick codex a1'), commandLines().join(' | '));
check('点对话**不再**依赖 select（选中的记录改由宿主 handler 用 setTarget 做）',
  !commandLines().some((line) => line.includes('select')));

// 让右栏有结论：把卡片喂进投影再渲染（必须走 rerender 重置 hook 游标）
// 形状是 2026-10 换上的**四段自适应分析**（不再是固定 3×3 表格）。
const SECTIONS = [
  { key: 'dialog', title: '具体对话' },
  { key: 'summary', title: '对话概述' },
  { key: 'analysis', title: '分析' },
  { key: 'advice', title: '建议' },
];
props = propsFor('review', {
  feed: [{
    verdict: 'drifting', sections: SECTIONS,
    headline: '从「课件讲没讲」滑到「文件在哪」',
    dialog: ['你：「课件当中有讲这几个算法吗？」'],
    summary: '你在核对课件覆盖，对面在找文件。',
    analysis: ['第二个问题跟原问题无关，是话题漂移。'],
    advice: ['[给用户] 下一条就一句：先确认覆盖。'],
    text: '从「课件讲没讲」滑到「文件在哪」', cost: 4000,
  }],
});
rerender();
check('状态 3 左栏是「问 · 你当时说的话」', hasText(tree, '你当时说的话'));
check('状态 3 左栏有你那句原话', hasText(tree, '你查查课件'));
check('状态 3 右栏是「答 · 审核结论」', hasText(tree, '审核结论'));
check('状态 3 右栏带四个分析锚点（具体对话 / 对话概述 / 分析 / 建议）',
  hasText(tree, '具体对话') && hasText(tree, '对话概述') && hasText(tree, '分析') && hasText(tree, '建议'));
check('状态 3 右栏画的是**实际内容**，不是空壳', hasText(tree, '找文件') && hasText(tree, '先确认覆盖'));
check('状态 3 右栏带结论标签「有漂移」', hasText(tree, '有漂移'));
check('**没有**任何固定表格节点的残留（旧 3×3 已删）',
  collect(tree, (n) => n.props?.['data-review-table'] !== undefined).length === 0
  && !hasText(tree, '主题漂移'));

// 2026-10 用户把结果区改成了 master–detail：
//   「分成一条一条，然后每条就显示前面的一个部分，不然的话这样子你有的长有的短」，
//   「然后每条是不是右边又应该有对应的相关的评价分析呢？」
// 所以这里只留两条总览断言；逐条细节（等高、前导部分、点一下换右边）在
// `test/panel-rows-test.mjs` 里，避免同一个行为两条测试各守一半。
props = propsFor('review', {
  feed: [
    { verdict: 'on-track', sections: SECTIONS, headline: '最早那轮没有漂移', analysis: ['没问题'], advice: ['继续'] },
    { verdict: 'off-track', sections: SECTIONS, headline: '第二轮跑偏了', analysis: ['卡了两轮'], advice: ['回退'] },
    { verdict: 'drifting', sections: SECTIONS, headline: '最新这条要展开', analysis: ['在细节上'], advice: ['收窄'] },
  ],
});
rerender();
const reviewRows = () => collect(tree, (n) => n.props?.['data-review-row'] !== undefined);
check('一条评价一行（3 条评价 = 3 行）', reviewRows().length === 3, `→ ${reviewRows().length} 行`);
check('每一行只有前导部分（带自己的领先行，不带自己的分析/建议）',
  reviewRows()[1] !== undefined
  && JSON.stringify(reviewRows()[1]).includes('第二轮跑偏了')
  && !JSON.stringify(reviewRows()[1]).includes('卡了两轮'),
  JSON.stringify(reviewRows()[1] ?? null).slice(0, 100));
check('最新一条默认在右栏展开（领先行 + 四段）',
  hasText(tree, '最新这条要展开') && hasText(tree, '具体对话') && hasText(tree, '收窄'));

// ── 诊断行：浏览器究竟看到了什么 ───────────────────────────
// 四个探针都走 `ctx.get`（没有它才退回属性访问），**四个都不进 inject**。
const diagNode = () => collect(tree, (n) => typeof n.props?.['data-review-diag'] === 'string')[0];
const diagText = () => diagNode()?.props['data-review-diag'] ?? '';
check('面板上有一行诊断', diagNode() !== undefined, diagText());
check('诊断写清 ctx.remote=有 / commands=有 / reviewRemote=无 / typeof=undefined',
  /ctx\.remote=有/.test(diagText()) && /commands=有/.test(diagText())
  && /reviewRemote=无/.test(diagText()) && /typeof=undefined/.test(diagText()),
  diagText());

const savedCommands = fakeRemote.commands;
fakeRemote.commands = undefined;
rerender();
check('命令通道缺失时诊断写「commands=无」',
  /ctx\.remote=有/.test(diagText()) && /commands=无/.test(diagText()),
  diagText());
fakeRemote.commands = savedCommands;
rerender();

// ── 远程永不 settle → 必须超时出话，不能停在「读目录…」 ─────
// 先退回状态 1。
const clickBackOnce = () => {
  const back = collect(tree, (n) => typeof n.props?.children === 'string' && n.props.children.startsWith('← 返回'))[0];
  if (back !== undefined) back.props.onClick();
};
clickBackOnce();   // 状态 3 → 2
clickBackOnce();   // 状态 2 → 1
check('退回状态 1 能再看到三个方向按钮',
  collect(tree, (n) => n.props?.['data-review-direction'] !== undefined).length === 3);

fakeRemote.commands.execute = () => new Promise(() => {});   // 永不 settle、也不 reject
byDirection(tree, 'dsh').props.onClick();
check('点了方向后先是「读目录…」', hasText(tree, '读目录…'));
await new Promise((resolve) => setTimeout(resolve, 150));
check('超时后显示一句话，而不是一直转', hasText(tree, '超时'), hasText(tree, '超时') ? '有超时提示' : JSON.stringify(tree).slice(0, 200));
check('超时后**不再**显示「读目录…」', !hasText(tree, '读目录…'));
check('超时提示指向可点选项那条路', hasText(tree, '可点选项'));

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
