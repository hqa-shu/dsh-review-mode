/**
 * 「有新评价」信号的设计证明（2026-10 用户要求）。
 *
 * 用户的原话：「如果发现更新，他是不是有变一下提示一下，或者说一下最新的是啥，
 * 想想看怎么设计」。
 *
 * 真问题：面板常常**被收起、或者被滚到看不见的地方**，而用户在看上面的对话。
 * 新评价悄悄落进 `reviewMode` 投影时，屏幕上没有任何变化 —— 这是一次真的错过。
 *
 * 设计（已实现）：
 *   - **「看过」是客户端本地的**：`localStorage` 里按会话存「已读条数」
 *     （`review-seen:<sessionId>`）。零模型、零宿主往返、零对话污染。
 *   - **信号说的是最新那一条是什么**，不是光一个数字：`<结论> · <① 主题漂移那句>`，
 *     多于一条时前面带 `N 条新结果`。用户要看的就是「最新的是啥」。
 *   - **收起时也在**：它渲染在 `body` 之外（和活性条一样常驻），所以面板收起也看得见。
 *   - **看过就消失**：点它 / 展开面板 / 把结果区滚回顶部，三种「我真的看到了」都会
 *     把已读条数写回 `localStorage`。
 *   - **和活性灯分开**：`data-review-update` 是独立节点，不参与、也不改
 *     `data-review-liveness` 的判据（灯仍然只回答「连没连上、跑不跑得起来」）。
 *
 * ⚠️ 这个文件刻意**不允许空断言**：任何关于信号的检查都先要求「信号真的在」
 * （`node !== undefined`），否则「信号不在 → 断言通过」就会变成一条永远为真的假测试
 * （本仓的审计抓到过两条这种）。
 *
 * 它用带真实 effect 的极小 React（`useState` / `useRef` 有状态），
 * 并给 `window.localStorage` 一个真的内存实现，从而能证明「刷新页面后已读还在」。
 */

import { readFileSync } from 'node:fs';
import { ANALYSIS_SECTIONS } from '../rubric.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 极小 React（带状态；effect 只在依赖变化时跑）────────────
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

/** 一条评价卡片（形状照 `normalizeVerdictRecord` 折出来的）。 */
const card = (turn, verdict, headline) => ({
  kind: 'review',
  lane: 'me',
  turn,
  verdict,
  sections: ANALYSIS_SECTIONS,
  headline,
  dialog: [`你说：${turn}`],
  summary: `概述${turn}`,
  analysis: [`分析${turn}`],
  advice: [`建议${turn}`],
  text: headline,
});

/** 真的内存 localStorage（同一个 store 可以喂给两个实例，模拟刷新页面）。 */
function makeStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(String(key)); },
  };
}

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const textOf = (node) => String(JSON.stringify(node));
const updateNode = (tree) => collect(tree, (n) => n.props?.['data-review-update'] !== undefined)[0];
const updateCount = (tree) => {
  const node = updateNode(tree);
  return node === undefined ? null : String(node.props['data-review-update']);
};
const updateText = (tree) => {
  const node = updateNode(tree);
  return node === undefined ? null : textOf(node);
};
const livenessNode = (tree) => collect(tree, (n) => n.props?.['data-review-liveness'] !== undefined)[0];
const bodyNode = (tree) => collect(tree, (n) => n.props?.['data-review-body'] !== undefined)[0];
const toggleNode = (tree) => collect(tree, (n) => n.props?.['aria-expanded'] !== undefined)[0];
/** 点一下信号。返回是否真的点到了（节点不在 → false，断言自己红）。 */
const clickUpdate = (tree) => {
  const node = updateNode(tree);
  if (node === undefined || typeof node.props?.onClick !== 'function') return false;
  node.props.onClick();
  return true;
};

let importId = 0;

/**
 * 起一个面板实例。
 * @param {object} options - `{feed, storage, execute, preset, probeMs}`。
 * @returns {Promise<object>} `{tree, render, calls, storage, setFeed}`。
 */
async function boot(options) {
  const react = makeReact();
  let registered = null;
  const calls = [];
  const execute = options.execute ?? ((sessionId, line, attachments) => {
    calls.push([sessionId, line, attachments]);
    return Promise.resolve({
      ok: true,
      value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify({ ok: true, pong: true, tick: {}, scan: {} }) } },
    });
  });
  const storage = options.storage ?? makeStorage();
  globalThis.window = {
    __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? react.React : {})); } },
    localStorage: storage,
    addEventListener() {}, removeEventListener() {},
    __reviewRemoteTimeoutMs: 60,
    __reviewLocalTickMs: 1000,
    __reviewProbeIntervalMs: options.probeMs ?? 100000,
    __reviewStaleMs: 500000,
  };
  const url = new URL(`../client.js?update=${importId++}`, import.meta.url).href;
  await import(url);
  if (registered === null) throw new Error('client.js 没有注册');
  let panel = null;
  registered.apply({
    remote: { commands: { execute } },
    slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.name === 'shell.overlay') panel = component; } },
  });
  let feed = options.feed ?? [];
  let tree = null;
  const props = {
    sessionId: 's1',
    useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: options.preset ?? 'review', reviewMode: { feed } } } } }),
  };
  const render = () => { react.reset(); tree = panel(props); };
  react.onChange(render);
  render();
  return {
    get tree() { return tree; },
    render,
    calls,
    storage,
    setFeed(next) { feed = next; render(); },
  };
}

// ── 场景 1：新结果到达 → 信号出现，且**说的是最新那一条是什么** ──
{
  const storage = makeStorage();
  const newestDrift = '面板哨兵_最新一条的漂移：从「课件」滑到「路径」';
  const feed = [
    card(1, 'on-track', '第一条漂移'),
    card(2, 'off-track', '第二条漂移'),
    card(3, 'drifting', newestDrift),
  ];
  const panel = await boot({ feed, storage });
  const node = updateNode(panel.tree);
  check('新评价到达后出现「有新结果」信号（data-review-update）', node !== undefined,
    node === undefined ? '（没有信号节点）' : String(node.props['data-review-update']));
  check('信号说清**有几条**是新的', node !== undefined && updateCount(panel.tree) === '3',
    String(updateCount(panel.tree)));
  check('信号说的是**最新那一条是什么**（不是光一个数字）',
    node !== undefined && updateText(panel.tree).includes(newestDrift), String(updateText(panel.tree)).slice(0, 170));
  check('信号带上最新的结论标签（有漂移）',
    node !== undefined && updateText(panel.tree).includes('有漂移'), String(updateText(panel.tree)).slice(0, 140));
  check('信号里没有被顶掉的旧条目内容',
    node !== undefined && !updateText(panel.tree).includes('第一条漂移') && !updateText(panel.tree).includes('第二条漂移'));
  check('信号与活性灯是**两个节点**（灯仍然只回答连没连上）',
    node !== undefined && livenessNode(panel.tree) !== undefined && livenessNode(panel.tree) !== node);
  check('信号不冒用活性灯的字眼（已连接 / 未连接 / 跑不起来）',
    node !== undefined && !/已连接|未连接|跑不起来/.test(updateText(panel.tree)));

  // 看过 → 消失。
  const before = panel.calls.length;
  const clicked = clickUpdate(panel.tree);
  check('点一下 = 看过了 → 信号自己消失（且确实点到了信号）',
    clicked && updateNode(panel.tree) === undefined,
    `clicked=${clicked} after=${String(updateCount(panel.tree))}`);
  const visibleResult = collect(panel.tree, (n) => n.props?.['data-review-detail'] !== undefined)[0];
  check('点「查看」后留在最新评价详情，而不是跳回选对话页',
    collect(panel.tree, (n) => n.props?.['data-review-view'] === 'results').length === 1
      && visibleResult?.props?.['data-review-detail'] === '2',
    `detail=${String(visibleResult?.props?.['data-review-detail'])}`);
  check('见过的条数被写进 localStorage（刷新后还算见过）',
    storage.getItem('review-seen:s1') === '3', String(storage.getItem('review-seen:s1')));

  // 又来了新的一条 → 只报这 1 条，且 gist 换成新的那条。
  panel.setFeed([...feed, card(4, 'on-track', '第四条漂移_新的')]);
  const again = updateNode(panel.tree);
  check('再来一条新的 → 信号只报这 1 条',
    again !== undefined && updateCount(panel.tree) === '1', String(updateCount(panel.tree)));
  check('这次说的是**新的那条**是什么（不是旧的）',
    again !== undefined && updateText(panel.tree).includes('第四条漂移_新的')
    && !updateText(panel.tree).includes(newestDrift), String(updateText(panel.tree)).slice(0, 150));
  check('(d) 整个过程零额外宿主请求（信号是纯本地推导）',
    panel.calls.length === before, `execute=${panel.calls.length}（点击前 ${before}）`);
}

// ── 场景 2：收起面板时也看得见（信号在 body 之外）─────────────
{
  const panel = await boot({ feed: [card(1, 'drifting', '收起哨兵_漂移')] });
  check('展开时本来就有信号', updateNode(panel.tree) !== undefined);
  check('展开时有 body（结果区在里面，带 data-review-body）', bodyNode(panel.tree) !== undefined);
  toggleNode(panel.tree).props.onClick();
  const bodyGone = bodyNode(panel.tree) === undefined;
  check('收起后 body 不再渲染（面板确实收起了）', bodyGone);
  const node = updateNode(panel.tree);
  check('★ 收起时「有新结果」信号仍然在（用户不用展开才知道）', node !== undefined,
    node === undefined ? '（信号跟着 body 一起没了）' : String(node.props['data-review-update']));
  check('收起时信号照样说出最新那条是什么',
    node !== undefined && updateText(panel.tree).includes('收起哨兵_漂移'), String(updateText(panel.tree)).slice(0, 130));
  check('收起时活性灯也仍然在（两者互不替代）', livenessNode(panel.tree) !== undefined);
}

// ── 场景 3：「看过」的另外两种方式也会清掉信号 ────────────────
{
  // (a) 展开面板 = 结果区顶部就在眼前
  const panel = await boot({ feed: [card(1, 'drifting', '展开哨兵')] });
  toggleNode(panel.tree).props.onClick(); // 收起
  const whileCollapsed = updateNode(panel.tree) !== undefined;
  check('收起时信号在（这是下面那条断言的前提，防止空断言）', whileCollapsed);
  toggleNode(panel.tree).props.onClick(); // 展开
  check('(a) 展开面板 → 信号消失（结果区顶部就在眼前）',
    whileCollapsed && updateNode(panel.tree) === undefined);

  // (b) 把结果区滚回顶部
  const panel2 = await boot({ feed: [card(1, 'drifting', '滚动哨兵')] });
  const body2 = bodyNode(panel2.tree);
  check('结果区有滚动钩子（onScroll）', typeof body2?.props?.onScroll === 'function');
  const beforeScroll = updateNode(panel2.tree) !== undefined;
  if (typeof body2?.props?.onScroll === 'function') body2.props.onScroll({ target: { scrollTop: 0 } });
  check('(b) 结果区滚到顶部 → 信号消失',
    beforeScroll && updateNode(panel2.tree) === undefined,
    `before=${beforeScroll} after=${String(updateCount(panel2.tree))}`);
}

// ── 场景 4：刷新页面后「已读」还在（localStorage 是唯一依据）────
{
  const storage = makeStorage();
  const first = await boot({ feed: [card(1, 'drifting', '第一次')], storage });
  const marked = clickUpdate(first.tree);
  check('第一次：点掉信号（写下已读）', marked && storage.getItem('review-seen:s1') === '1');
  // 同一个 storage 再起一个实例（换一份 client.js 模块）＝ 刷新页面。
  const second = await boot({ feed: [card(1, 'drifting', '第一次')], storage });
  check('刷新后同一条不会又被当成新的（同一份 feed、换一份模块也零信号）',
    marked && updateNode(second.tree) === undefined, String(updateCount(second.tree)));
  // 非空断言的前提：**空 storage** 下同一份 feed 必须报 1 —— 否则上面那条只是因为功能没实现才「通过」。
  const fresh = await boot({ feed: [card(1, 'drifting', '第一次')] });
  check('（前提）空 storage 下同一条会被当成新的 1 条',
    updateCount(fresh.tree) === '1', String(updateCount(fresh.tree)));
  const third = await boot({ feed: [card(1, 'drifting', '第一次'), card(2, 'off-track', '刷新期间来的')], storage });
  const node = updateNode(third.tree);
  check('刷新期间到的新结果照样提示，且只提示它',
    node !== undefined && updateCount(third.tree) === '1' && updateText(third.tree).includes('刷新期间来的'),
    String(updateText(third.tree)).slice(0, 130));
}

// ── 场景 5：没有评价时没有信号（不是常亮噪声）────────────────
{
  const panel = await boot({ feed: [] });
  check('一条评价都没有时，不画信号（不是常亮的装饰）', updateNode(panel.tree) === undefined);
  const mixed = await boot({ feed: [{ kind: 'qa', question: '问', text: '答' }] });
  check('只有问答条目时也不画「新评价」信号', updateNode(mixed.tree) === undefined);
}

// ── 场景 6：(d) 零模型 —— 客户端源码里没有模型/子 Agent 通道 ──
{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  check('(d) 信号相关源码里没有 subagents / spawn（不会有一次模型调用）',
    !/subagents/.test(source) && !/\bspawn\b/.test(source));
  // 只数**代码**里的宿主调用点（注释里提到旧通道不算）。
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const executeCalls = (codeOnly.match(/\.execute\(/g) ?? []).length;
  check('(d) 客户端只有那一条宿主通道：commands.execute',
    executeCalls === 1, `execute 调用点=${executeCalls}`);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
