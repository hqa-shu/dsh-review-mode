import assert from 'node:assert/strict';

let cursor = 0;
const slots = [];
let rerender = () => {};
let probeIndex = null;
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  useState(initial) {
    const index = cursor++;
    if (initial?.status === 'first' && initial?.at === 0) probeIndex = index;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; rerender(); }];
  },
  useRef(value) { return { current: value }; },
  useEffect() {},
};

let registered;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory(spec => spec === 'react' ? React : {}); } },
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {}, removeEventListener() {},
};
await import('../client.js');
let panel;
const calls = [];
const reply = value => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify(value) } } });
const EVIDENCE = { title: '合成对话', youSaid: [
  '第一条：先说清任务',
  '第二条：这是一段很长的原话，里面有多次停顿和解释。'.repeat(8),
  '第三条：最后补充验收条件',
], otherSaid: ['合成回答'] };
registered.apply({
  remote: { commands: { execute(_sessionId, command) {
    calls.push(command);
    if (command.includes(' dir ')) return Promise.resolve(reply({ recent: [{ kind: 'dsh', id: 'synthetic', title: '合成对话' }], groups: [] }));
    if (command.includes(' advise-turn ')) return Promise.resolve(reply({ status: 'ready', number: 2,
      answer: '观察：背景未核清。建议：请 AI 对照原目标答复。',error: '',
      contextSummary: '参考本条原话、1 条同轮 AI 回复、1 条更早背景、1 条后续记录；其余未逐条核查' }));
    if (command.includes(' rewrite-turn ') || command.includes(' rewrite-insight '))
      return Promise.resolve(reply({status:'ready',text:'请对照原目标和已经完成的工作，说明下一步。',error:''}));
    if (command.includes(' source ')) return Promise.resolve(reply({ source: { role: 'ai', text: '完整原文：这是 AI 真正说的话。', truncated: false }, neighbor: [] }));
    if (command.includes(' focus ')) {
      const lane = command.match(/ focus (me|conversation|agent)(?:\s|$)/)?.[1];
      return Promise.resolve(reply({ selected: { kind: 'dsh', id: 'synthetic', title: '合成对话', lane }, evidence: EVIDENCE }));
    }
    return Promise.resolve(reply({ selected: { kind: 'dsh', id: 'synthetic', title: '合成对话', lane: 'me' }, evidence: EVIDENCE }));
  } } },
  slots: { inject(_name, fn) { fn(); }, register(meta, component) { if (meta.name === 'shell.overlay') panel = component; } },
});

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  for (const child of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) collect(child, predicate, out);
  return out;
};
const first = predicate => collect(tree, predicate)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let feed = [{ kind: 'review', targetKey: 'dsh:synthetic', lane: 'me', at: 1, turn: 1, verdict: 'on-track', headline: '只属于审我', analysis: ['合成洞察'] }];
let tree;
rerender = () => {
  cursor = 0;
  tree = panel({ sessionId: 's1', useSessions: selector => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: { feed } } } } }) });
};
rerender();
first(node => node.props?.['data-review-direction'] === 'dsh').props.onClick();
await tick();
first(node => node.props?.['data-review-target'] === 'synthetic').props.onClick();
await tick();
assert.equal(first(node => node.props?.['data-review-current-focus'] !== undefined)?.props['data-review-current-focus'], 'me');
assert(JSON.stringify(tree).includes('只属于审我'));
console.log('PASS 选中目标后明确显示当前审我及其评价');

const saidItems = () => collect(tree, node => node.props?.['data-review-said-item'] !== undefined);
assert.deepEqual(saidItems().map(node => node.props['data-review-said-item']), ['3', '2', '1']);
assert(saidItems().every(node => node.props.style.flex === 'none'), '展开后的原话卡片不能在滚动列表中被压缩截断');
const saidList = first(node => node.props?.['data-review-said-list'] === '1');
assert.equal(saidList.props.style.overflowY, 'auto');
assert.match(saidList.props.style.maxHeight, /vh/);
assert.equal(first(node => node.props?.['data-review-body'] === '1')?.props.style.overflowY, 'auto');
assert.equal(first(node => node.props?.['data-review-said-full'] === '2')?.props.children, EVIDENCE.youSaid[1]);
assert(first(node => node.props?.['data-review-said-summary'] === '2')?.props.children[1].props.children.length < EVIDENCE.youSaid[1].length);
first(node => node.props?.['data-review-filter'] === 'said').props.onChange({ target: { value: '第三条' } });
assert.deepEqual(saidItems().map(node => node.props['data-review-said-item']), ['3']);
first(node => node.props?.['data-review-filter'] === 'said').props.onChange({ target: { value: '' } });
console.log('PASS 原话分成编号卡片，长文可展开，筛选后仍保留原编号');

first(node => node.props?.['data-review-said-item'] === '2').props.onToggle({ currentTarget: { open: true } });
await tick();
assert(calls.some(command => command.includes(' advise-turn 2')));
assert(JSON.stringify(first(node => node.props?.['data-review-turn-advice'] === '2')).includes('参考本条原话'));
assert.equal(collect(first(node => node.props?.['data-review-turn-advice'] === '2'),
  node => node.props?.['data-review-art'] === 'advice').length, 1,
  '单条建议生成后也显示小精灵');
assert(first(node => node.props?.['data-review-turn-advice'] === '2').props.style['--review-accent']);
assert.equal(collect(first(node => node.props?.['data-review-turn-advice'] === '3'),
  node => node.props?.['data-review-art'] !== undefined).length, 0,
  '没有请求的单条建议不提前展示结果精灵');
first(node => node.props?.['data-review-rewrite-start'] === 'turn-2').props.onClick();
await tick();
assert(calls.some(command => command.includes(' rewrite-turn 2')));
assert(JSON.stringify(first(node => node.props?.['data-review-rewrite-text'] === 'turn-2')).includes('请对照原目标'));
console.log('PASS 打开一条原话才请求该条建议，不预先批量生成');

first(node => node.props?.['data-review-focus'] === 'conversation').props.onClick();
await tick();
assert(calls.some(command => command.includes(' focus conversation')));
assert.equal(first(node => node.props?.['data-review-current-focus'] !== undefined)?.props['data-review-current-focus'], 'conversation');
assert.equal(first(node => node.props?.['data-review-focus-selected'] !== undefined)?.props['data-review-focus-selected'], 'conversation');
assert(!JSON.stringify(tree).includes('只属于审我'));
console.log('PASS 点审对话后发出审核命令并显示选中状态');

first(node => node.props?.['data-review-focus'] === 'me').props.onClick();
await tick();
assert(calls.some(command => command.includes(' focus me')));
assert.equal(first(node => node.props?.['data-review-current-focus'] !== undefined)?.props['data-review-current-focus'], 'me');
assert.equal(first(node => node.props?.['data-review-focus-selected'] !== undefined)?.props['data-review-focus-selected'], 'me');
assert(JSON.stringify(tree).includes('只属于审我'));
console.log('PASS 点审我后发出审核命令并恢复对应评价');

first(node => node.props?.['data-review-focus'] === 'agent').props.onClick();
await tick();
assert(calls.some(command => command.includes(' focus agent')));
assert.equal(first(node => node.props?.['data-review-current-focus'] !== undefined)?.props['data-review-current-focus'], 'agent');
assert.equal(first(node => node.props?.['data-review-focus-selected'] !== undefined)?.props['data-review-focus-selected'], 'agent');
assert(!JSON.stringify(tree).includes('只属于审我'));
assert(first(node => node.props?.['data-review-start'] !== undefined));
console.log('PASS 点审AI后选中状态可见，审我的旧评价不会冒充审AI结果');

first(node => node.props?.['data-review-start'] !== undefined).props.onClick();
await tick();
assert(calls.some(command => command.includes(' refresh')));
console.log('PASS 当前侧重点无评价时有明确的开始审核入口');

feed = [...feed, { kind: 'review', targetKey: 'dsh:synthetic', lane: 'agent', at: 2, turn: 2, verdict: 'drifting', headline: '只属于审AI', analysis: ['合成洞察'] }];
rerender();
assert(JSON.stringify(tree).includes('只属于审AI'));
assert(!JSON.stringify(tree).includes('只属于审我'));
console.log('PASS 审AI评价生成后只显示该侧重点的结果');

feed = [...feed, { kind: 'review', targetKey: 'dsh:synthetic', lane: 'agent', at: 3, turn: 3,
  verdict: 'drifting', headline: '已核对的来源', evidenceChecked: true,
  coverage: '本次参考 2 段原话', droppedEvidence: 1,
  analysis: ['来源核对｜依据：AI在第1轮回答：「压到 160 行」｜洞察：数字来自 AI｜建议：按真实来源标注'],
  advice: ['按真实来源标注'], evidenceSources: [[{ id: 'A1', sourceKey: 'dsh:synthetic:4',
    role: 'ai', turn: 1, text: '原文节选：压到 160 行', cited: true, truncated: true }]] }];
rerender();
assert(JSON.stringify(tree).includes('本次参考 2 段原话'));
assert(JSON.stringify(tree).includes('1 条依据不足未展示'));
assert(first(node => node.props?.['data-review-buddy'] === '1'));
assert(JSON.stringify(tree).includes('先看依据，再决定是否采纳'));
assert(first(node => node.props?.['data-review-scope'] === '1'));
assert(first(node => node.props?.['data-review-insight-part'] === '依据'));
assert(first(node => node.props?.['data-review-insight-part'] === '判断'));
assert(!JSON.stringify(tree).includes('点击一条展开依据和做法'));
assert(!JSON.stringify(tree).includes('点上面的侧重点可手动审核'));
assert(first(node => node.props?.['data-review-source-list'] === '1'));
first(node => node.props?.['data-review-rewrite-start'] === 'insight-1').props.onClick();
await tick();
assert(calls.some(command => command.includes(' rewrite-insight ')));
assert(first(node => node.props?.['data-review-rewrite-text'] === 'insight-1'));
first(node => node.props?.['data-review-source-open'] === 'dsh:synthetic:4').props.onClick();
await tick();
assert(calls.some(command => command.includes(' source dsh%3Asynthetic%3A4')));
assert(JSON.stringify(tree).includes('完整原文：这是 AI 真正说的话。'));
console.log('PASS 已核对评价显示覆盖范围与原文入口，点击后按需读取完整原文');

const now = Date.now();
slots[probeIndex] = { status: 'ok', at: now, why: '', facts: {
  pong: true, tick: { enabled: true, lastAt: now, intervalMs: 5000 },
  autoReview: { checkedAt: now, observedMessages: 1, triggerCount: 0, lastTriggeredAt: null, lastDelta: 0 },
} };
rerender();
const autoStatus = () => first(node => node.props?.['data-review-auto-status'] === '1')?.props?.children;
assert.match(autoStatus(), /自动复审 · 尚未触发/);
slots[probeIndex] = { ...slots[probeIndex], facts: { ...slots[probeIndex].facts,
  autoReview: { checkedAt: now, observedMessages: 2, triggerCount: 1, lastTriggeredAt: now, lastDelta: 1 },
} };
rerender();
assert.match(autoStatus(), /自动复审 · 已触发 1 次/);
assert(JSON.stringify(tree).includes('新增 1 条用户消息'));
console.log('PASS 页面分别显示自动复审尚未触发与真实触发次数');

feed = [...feed, { ...feed.at(-1), at: 4, turn: 4,
  analysis: ['第一项｜依据：原话一｜洞察：判断一｜建议：做法一',
    '第二项｜依据：原话二｜洞察：判断二｜建议：做法二',
    '没有建议的项｜依据：原话三｜洞察：保持观察'],
  advice: [], evidenceSources: [] }];
rerender();
const insightCards = collect(tree, node => node.props?.['data-review-insight'] !== undefined);
assert.equal(insightCards.length, 3);
assert(insightCards.every(card => collect(card, node => node.props?.['data-review-art'] === 'advice').length === 1),
  '每条详情都要有精灵，包括第二条和没有建议文字的详情');
assert(saidItems().every(card => ['data-review-said-full', 'data-review-said-summary'].every(marker =>
  collect(card, node => node.props?.[marker] !== undefined).every(body =>
    collect(body, node => node.props?.['data-review-art'] !== undefined).length === 0))),
  '精灵只进入单条点评，不进入原话正文与摘要');
console.log('PASS 每条审核详情含一只精灵，单条点评共享装饰且原话正文保持不变');
