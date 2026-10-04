/**
 * **面板不覆盖问答框；并且只在真的需要时才重画**（2026-10 用户现场）：
 *
 *   「我如果对他审核的一部分不太清楚，我要通过原本的这个问答框问的时候，他就是直接卡顿住」
 *   「包括如果界面直接覆盖在问答框上，如果问答输入的话，很多都会被挡。这排版不知道可不可以变。」
 *   「应该怎么定义这个问答框和这个旁边界面的关系」
 *
 * 两件事、两个可测的判据：
 *
 * **① 占位，不是覆盖。** 面板的容器在 `shell.overlay`（`position:fixed`，贴右），但
 * 它会把 shell 的 frame 右边**留出一列**：往 frame 上写 `--review-reserved-w` 并加
 * `data-review-reserved`，配一条 `padding-right: … !important` 的规则。
 * frame 是 CSS grid（`dsh-client-ui-layout/lib/client.js:320` 的
 * `gridTemplateColumns: '<sidebar>px minmax(<rb>px,1fr) minmax(0px,<rbmax>px)'`），
 * `padding-right` 落在**内容盒**上，于是中间那条 `1fr`（对话列 + composer + 发送键）
 * 被真的挤窄 —— 不是被浮层盖住。这条测试用一个假 DOM 跑**真的 effect**，
 * 断言变量确实写到了 frame 上、收起时清成 0。
 *
 * **② 1Hz 的本地时钟不再永久重画整个面板。** 旧实现只要在审核模式就永久 1Hz
 * `setState`，整棵面板（左栏清单 + 右栏分析 + 两个输入框）每秒重建一次，
 * 与正在打字的 composer 抢同一帧。现在按**真的需要**门控：收起不跑、
 * 心跳不是 `ok` 不跑（那三态文案里没有时间）。这条测试用真的 effect 跑起来，
 * 数 `setInterval(…, 1000)` 到底起了几次。
 *
 * 只有浏览器能确认的：真实的帧率、真实 overlay 的层叠与点击命中。这里能证明的是
 * 「我们把预留写进了 shell 的 frame」与「无谓的重画被关掉了」。
 */

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

/* ── 带真 effect 的极小 React ─────────────────────────────── */
function makeReact(fakeNode) {
  const stateSlots = [];
  const effectSlots = [];
  const refSlots = [];
  let cursor = 0;
  let effectCursor = 0;
  let refCursor = 0;
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
    // 真 DOM 的 ref 指向挂载后的节点；这里直接给那个假节点（顺序：dragging / reserveRef / bodyRef）。
    useRef(initial) {
      const index = refCursor;
      refCursor += 1;
      if (!(index in refSlots)) refSlots[index] = { current: initial === null ? fakeNode : initial };
      return refSlots[index];
    },
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
  return {
    React,
    reset() { cursor = 0; effectCursor = 0; refCursor = 0; },
    onChange(fn) { onChange = fn; },
  };
}

/* ── 假 DOM：面板节点 → shell.overlay → frame ──────────────── */
const frameWrites = [];
const frame = {
  attrs: new Map(),
  vars: new Map(),
  style: {
    setProperty(name, value) { frameWrites.push([name, value]); frame.vars.set(name, value); },
    removeProperty(name) { frame.vars.delete(name); },
  },
  setAttribute(name, value) { frame.attrs.set(name, String(value)); },
  removeAttribute(name) { frame.attrs.delete(name); },
};
const overlay = { parentElement: frame };
const fakeNode = { closest: (selector) => (selector === '[data-shell-overlay]' ? overlay : null) };

const intervals = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { intervals.push(ms); return realSetInterval(fn, ms); };
globalThis.clearInterval = (id) => realClearInterval(id);

const reply = (text) => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text } } });
const fakeRemote = {
  commands: {
    execute(_sessionId, line) {
      const verb = String(line).trim().split(/\s+/)[1];
      if (verb === 'ping') return Promise.resolve(reply(JSON.stringify({ pong: true, tick: { lastAt: Date.now(), intervalMs: 5000 } })));
      return Promise.resolve({ ok: true, value: undefined });
    },
  },
};

let registered = null;
const react = makeReact(fakeNode);
const listeners = [];
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? react.React : {})); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener(name, fn) { listeners.push(name); },
  removeEventListener() {},
  innerWidth: 1280,
  innerHeight: 900,
};

let panel = null;
await import('../client.js');
if (registered === null) { console.log('FAIL  模块没注册'); process.exit(1); }
registered.apply({
  remote: fakeRemote,
  slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.id === 'review-mode-panel') panel = component; } },
});

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const rootNode = (tree) => collect(tree, (n) => n.props?.['data-review-mode'] === 'panel')[0];
const toggleNode = (tree) => collect(tree, (n) => n.props?.['aria-expanded'] !== undefined)[0];

const props = {
  sessionId: 's1',
  useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } } } }),
};
let tree = null;
/** 每次「重画」都要重置 hook 游标（真 React 也是从头按顺序走一遍）。 */
const renderPanel = () => { react.reset(); tree = panel(props); return tree; };
react.onChange(() => { renderPanel(); });

/* ── ① 预留：面板**声明**它要占多宽，并把这一列真的写进 shell 的 frame ── */
renderPanel();
const root = rootNode(tree);
check('面板根节点声明了预留宽度（data-review-reserve）',
  root !== undefined && /^\d+$/.test(String(root.props['data-review-reserve'])),
  JSON.stringify(root?.props?.['data-review-reserve']));
check('预留宽度 = min(面板宽度, 45% 视口) —— 窄窗口下不许把对话列吃光',
  Number(root.props['data-review-reserve']) === Math.min(380, Math.round(1280 * 0.45)),
  String(root.props['data-review-reserve']));
check('真的 effect 把 `--review-reserved-w` 写到了 frame 上（不是只写在面板自己身上）',
  frame.vars.get('--review-reserved-w') === `${root.props['data-review-reserve']}px`,
  JSON.stringify([...frame.vars.entries()]));
check('frame 被标上 `data-review-reserved`（CSS 规则靠它生效）',
  frame.attrs.get('data-review-reserved') === '1');
check('frame 上的预留宽度也留了一份数字（排查用）',
  frame.attrs.get('data-review-reserved-w') === String(root.props['data-review-reserve']));
check('面板注入了那条预留规则：`padding-right:var(--review-reserved-w)` + `!important`',
  collect(tree, (n) => n.props?.['data-review-reserve-css'] !== undefined)
    .some((n) => /padding-right:var\(--review-reserved-w,0px\) !important/.test(String(n.props.children)))
  && collect(tree, (n) => n.props?.['data-review-reserve-css'] !== undefined)
    .some((n) => /box-sizing:border-box/.test(String(n.props.children))));
check('窗口 resize 时重算预留（监听器注册了 resize）', listeners.includes('resize'));

/* ── ② 收起 → 预留清成 0（不占位也不覆盖）────────────────── */
toggleNode(tree).props.onClick();
renderPanel();
check('收起后预留宽度 = 0', Number(rootNode(tree).props['data-review-reserve']) === 0,
  String(rootNode(tree)?.props?.['data-review-reserve']));
check('收起后 frame 上的变量被清成 0px（不是留着旧值把对话列白挤窄）',
  frame.vars.get('--review-reserved-w') === '0px', JSON.stringify([...frame.vars.entries()]));
toggleNode(tree).props.onClick();   // 再展开，后面继续用

/* ── ③ 1Hz 本地时钟：只在「展开 + 已连接」时才起 ───────────── */
await new Promise((r) => setTimeout(r, 0));   // 让 ping 的 promise 落定
renderPanel();
const clockTicksRunning = () => intervals.filter((ms) => ms === 1000).length;
const before = clockTicksRunning();
check('展开且心跳成功时，本地时钟在跑（1 秒一次，只重算新鲜度）', before > 0, `1Hz 定时器=${before}`);
const afterFirst = clockTicksRunning();
// 收起：时钟必须停（收起态没有「N 秒前」要重算）
toggleNode(tree).props.onClick();
renderPanel();
check('收起后**不再**起新的 1Hz 定时器（旧实现是永久 1Hz 重画整个面板）',
  clockTicksRunning() === afterFirst, `before=${afterFirst} after=${clockTicksRunning()}`);
toggleNode(tree).props.onClick();
renderPanel();

/* ── ④ 源码纪律（反向变异：把门控去掉必须变红）────────────── */
{
  const source = (await import('node:fs')).readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const gated = (code) => /if \(!open\) return undefined;/.test(code) && /if \(probe\.status !== 'ok'\) return undefined;/.test(code);
  check('本地时钟的 effect 里有 `!open` 与 `probe.status !== \'ok\'` 两道门',
    gated(source));
  check('反向变异：把两道门删掉，同一条判据会变红',
    gated(source) === true
    && gated(source.replace("if (!open) return undefined;", '').replace("if (probe.status !== 'ok') return undefined;", '')) === false);
  check('面板**没有**把 composer / 发送键当成自己的节点（那是上面那块对话区的）',
    !/data-review-composer|data-review-send/.test(source));
}

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
