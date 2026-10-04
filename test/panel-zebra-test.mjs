/**
 * 左栏评价清单的**斑马纹**（2026-10 用户要求）。
 *
 * 用户原话：「你每一条你可以每一条就换个颜色或者什么这样子交替的，
 * 不然的话我不知道你每一条哪里结束」。
 *
 * 前一轮（bug 47/48）已经把清单做成**一条评价一行 + 等高 22px + 单行截断**，
 * 所以「哪一行到哪结束」只剩背景这一条线索。这里钉四件事：
 *   1. 相邻两行的背景**必须不同**，隔行相同（真正交替，不是「都刷了一层」）；
 *   2. 颜色**只能用主题 token**（`var(--dsw-…)`）或不着色（`transparent`）——
 *      写死 `#eee` / `rgb()` 在浅色/深色其中一边必然错；
 *   3. 选中的那一行仍然是「选中色」，斑马纹不许把选中态吃掉；
 *   4. 等高 / 单行截断不被这次改动破坏（沿用上一轮的判据）。
 *
 * 反向变异：把两行设成同一个背景，交替判据必须为假；把颜色换成 `#eeeeee`，
 * token 判据必须为假 —— 两条都写在文件里，证明断言不是恒真的。
 */

import { readFileSync } from 'node:fs';
import { ANALYSIS_SECTIONS } from '../rubric.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 判据（纯函数：正用它断言，反向变异也用它）──────────────
/** 相邻行背景两两不同 = 真的交替。 */
const alternates = (backgrounds) => backgrounds.length >= 2
  && backgrounds.every((bg, i) => i === 0 || bg !== backgrounds[i - 1]);
/** 一个背景值是不是「只用主题 token 或不着色」。 */
const tokenBased = (bg) => bg === 'transparent'
  || /^var\(--dsw-[a-z0-9-]+\)$/.test(String(bg ?? ''));
/** 有没有写死的颜色字面量（`#rrggbb` / `rgb()` / `hsl()` / 具名色）。 */
const hasHardCodedColour = (bg) => /#|rgba?\(|hsla?\(|\b(?:red|blue|green|gray|grey|black|white|yellow|orange|purple)\b/i.test(String(bg ?? ''));

// ── 有状态的极小 React ─────────────────────────────────────
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
await import('../client.js');
if (registered === null) { console.log('FAIL  模块没注册'); process.exit(1); }
let panel = null;
registered.apply({
  remote: { commands: { execute: (_sessionId, command) => Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: command.includes(' dir ') ? JSON.stringify({ recent: [{ id: 'z1', kind: 'dsh', title: '合成对话' }], groups: [] }) : JSON.stringify({ selected: { id: 'z1', kind: 'dsh', title: '合成对话' }, evidence: { title: '合成对话', youSaid: ['第1轮：让大家看懂'], otherSaid: ['第1轮：压到约160行'] } }) } } }) } },
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

const CARD = (n, verdict) => ({
  kind: 'review', targetKey: 'dsh:z1', at: Date.UTC(2026, 9, 3, 14, 32 - n, 0), turn: n, lane: 'me', verdict,
  sections: ANALYSIS_SECTIONS,
  headline: `斑马哨兵${n}_最要紧那一句`,
  dialog: [`对话哨兵${n}`], summary: `概述哨兵${n}`,
  analysis: [`分析哨兵${n}｜依据：用户原话：「压到约160行」｜洞察：行数不代表易懂｜建议：找人试读`], advice: [`建议哨兵${n}`],
  text: `斑马哨兵${n}_最要紧那一句`,
});
/* 四条：左栏默认选中**最新一条**（跟随时是最后一行），所以留三条未选中的
 * 才能看出「隔行相同」——两条未选中的话「交替」和「都不同」分不开。 */
const FEED = [CARD(0, 'on-track'), CARD(1, 'drifting'), CARD(2, 'off-track'), CARD(3, 'on-track')];

let tree = null;
const render = (projection) => {
  stateSlots.length = 0;
  const props = { sessionId: 's1', useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: projection } } } }) };
  rerender = () => { cursor = 0; tree = panel(props); };
  rerender();
  return tree;
};
const rowNodes = () => collect(tree, (n) => n.props?.['data-review-row'] !== undefined);
const rowBg = (node) => node?.props?.style?.background;

render({ feed: FEED });
collect(tree, (n) => n.props?.['data-review-direction'] === 'dsh')[0].props.onClick();
await new Promise(resolve => setTimeout(resolve, 0));
collect(tree, (n) => n.props?.['data-review-target'] === 'z1')[0].props.onClick();
await new Promise(resolve => setTimeout(resolve, 0));
const rows = rowNodes();
check('AI 的原话即使被模型误写成用户原话，界面仍按原始材料标成 AI',
  JSON.stringify(tree).includes('依据：对面 AI第1轮「压到约160行」'));
check('4 条评价 = 4 行（沿用上一轮：一条一行）', rows.length === 4, `→ ${rows.length} 行`);
check('每行仍然等高 22px（斑马纹不许破坏上一轮的版式）',
  rows.every((row) => row.props.style.height === '22px' && row.props.style.whiteSpace === 'nowrap'),
  JSON.stringify(rows.map((row) => [row.props.style.height, row.props.style.whiteSpace])));
check('每行仍然单行截断（overflow:hidden + textOverflow:ellipsis）',
  rows.every((row) => row.props.style.overflow === 'hidden' && row.props.style.textOverflow === 'ellipsis'));

// 默认「跟随最新」= 最后一行是选中态（选中色走另一条判据），所以斑马纹看**未选中**的三行。
const backgrounds = rows.map(rowBg);
const zebraBgs = backgrounds.slice(0, 3); // 0/1/2 都未选中
check('相邻两行的背景**不同**（用户要的就是这个边界）', alternates(zebraBgs), JSON.stringify(backgrounds));
check('隔行背景**相同**（0 = 2，真交替而不是渐变）', zebraBgs[0] === zebraBgs[2] && zebraBgs[0] !== zebraBgs[1],
  JSON.stringify(backgrounds));
check('背景只用主题 token 或不着色（不是写死的颜色）',
  backgrounds.every(tokenBased), JSON.stringify(backgrounds));
check('背景里没有硬编码颜色字面量（浅色/深色才不会有一边错）',
  backgrounds.every((bg) => !hasHardCodedColour(bg)), JSON.stringify(backgrounds));
check('整份 client.js 的斑马纹定义里也没有硬编码颜色',
  !hasHardCodedColour((readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .match(/ROW_ZEBRA[\s\S]{0,400}/) ?? [''])[0]),
  String((readFileSync(new URL('../client.js', import.meta.url), 'utf8').match(/ROW_ZEBRA[\s\S]{0,300}/) ?? ['(没找到 ROW_ZEBRA)'])[0]).slice(0, 200));

// 每行标出自己的奇偶（测试与将来的样式都据此；也让「交替」在 DOM 上可读）
const zebra = rows.map((row) => row.props['data-review-row-zebra']);
check('每行带 data-review-row-zebra，且逐行交替 even/odd/even/odd',
  JSON.stringify(zebra) === JSON.stringify(['even', 'odd', 'even', 'odd']), JSON.stringify(zebra));
check('DOM 上的奇偶与背景一致（未选中的行里，even 的背景 = 其它 even 的背景）',
  zebra.every((tag, i) => (tag === 'even'
    ? backgrounds[i] === backgrounds[0]
    : (backgrounds[i] === backgrounds[1] || i === 3))),
  JSON.stringify({ zebra, backgrounds }));
check('默认选中的那一行不跟斑马纹同色（选中态没被吃掉）',
  backgrounds[3] === 'var(--dsw-alias-interactive-bg-hover-solid)'
  && backgrounds[3] !== backgrounds[1], String(backgrounds[3]));

// ── 选中一行：选中色优先，斑马纹不许把选中态吃掉 ────────────
{
  const secondRow = rowNodes()[1];
  secondRow.props.onClick();
  rerender();
  const after = rowNodes().map((row) => ({ bg: rowBg(row), selected: row.props['data-review-row-selected'] }));
  check('点一行后：被选中的那一行换成**选中色**（与它自己的斑马纹不同）',
    after[1].selected === '1' && after[1].bg !== backgrounds[1],
    JSON.stringify(after));
  check('选中不让**其它**行失去斑马纹（0/2 仍然相同且不同于 1 原来的斑马纹）',
    after[0].bg === backgrounds[0] && after[2].bg === backgrounds[2] && after[0].bg !== backgrounds[1],
    JSON.stringify(after));
  check('选中色也是主题 token（不是写死颜色）',
    tokenBased(after[1].bg) && !hasHardCodedColour(after[1].bg), String(after[1].bg));
}

// ── 反向变异：判据本身不是恒真的 ───────────────────────────
check('反向变异：两行同色时交替判据必须为假',
  alternates(['transparent', 'transparent']) === false);
check('反向变异：写死颜色必须被判成非 token',
  tokenBased('#eeeeee') === false && hasHardCodedColour('#eeeeee') === true);
check('反向变异：写死颜色即使「交替」也不合格（两条判据都得过）',
  alternates(['#ffffff', '#eeeeee']) === true
  && ['#ffffff', '#eeeeee'].every(tokenBased) === false);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
