/**
 * 第 8 步的证明：**Codex 监控器自己会触发**。
 *
 * FLOW.md 第 8 步的「怎么验」点名要这三个结果：
 *   `监控器自己触发了: 是` · `提示词含三个问题: true` · `parent 是审核会话: true`
 *
 * 但这份脚本以前**永远 exit 0、且一行 PASS/FAIL 都不打印** —— 把监控器的
 * `agents.list` 换成空数组（监控器物理上不可能触发）它照样 exit 0（实测）。
 * 也就是说那三个「是/true」只是打印，不是检查：断言形同虚设。
 * 现在它们是真断言，任一条不成立就 exit 1。
 *
 * 它用**真实的 ~/.codex 数据**和真实的定时器跑，所以会等最多 15 秒。
 *
 * **环境相关性（诚实说明 + 已消除）**：监控器默认盯「最新那条对话」；如果本机最新的
 * 那条 Codex 对话**你说过 0 句**，按「审我」线的门槛（`lane === 'me' && asks.length === 0`
 * → return）它就不会触发 —— 这是数据事实，不是代码坏了。这份脚本以前就靠运气：
 * 本机最新那条恰好 0 句时它会红（实测 2026-10：最新那条 `askCount=0`）。
 * 现在**先显式钉一条「你说过话」的真实对话**再跑，断言一条不减，但不再看运气。
 */

import { listCodex, readCodex, setTarget } from '../reviewer.js';

const mod = await import(new URL('../index.js', import.meta.url).pathname);
// 复审员现在写的是**四段自适应分析**（上一版的固定 3×3 表格已被用户推翻）。
const REVIEW = `结论: drifting
一句话: 你在 Codex 那边的注意力从「课件讲没讲」滑到了「文件在哪」。
## 具体对话
- 你：「课件当中有讲这几个算法吗」→ 对面：「路径全环」
## 对话概述
你在核对课件覆盖，后面转成了找文件路径。
## 分析
- 第二次转换跟原问题无关，是话题漂移。
- 「路径」转了两轮，第二句没带来新信息。
- 要求重核是对的；但没人把问题拉回原问题。
## 建议
- [给用户] 下一条就一句：按新位置重新核对。
- [给Agent] 逐份列出文件名和页码。`;

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

const agents = [];
const agent = {
  id: 'review-1',
  session: { header: { id: 'review-1', cwd: '/w' }, seq: 10, snapshotEvents: () => [] },
  inject(m) { this.injected = m; },
};
agents.push(agent);

// 先钉一条**你说过话**的真实对话：监控器的「审我」线只在用户说过话时才审。
{
  const all = listCodex(200).sort((a, b) => Number(b.mtime ?? 0) - Number(a.mtime ?? 0));
  const newest = all[0];
  const newestRead = newest === undefined ? null : readCodex(newest);
  if (newestRead !== null && newestRead.askCount === 0) {
    console.log(`NOTE 本机最新那条 Codex 对话「你说 0 句」（askCount=0）→ 默认盯它按 me 线的门槛不会触发。`
      + `这是环境相关的事实；本次显式钉一条你说过话的对话，断言一条不减。`);
  }
  const target = all.find((entry) => (readCodex(entry)?.askCount ?? 0) > 0);
  if (target !== undefined) {
    const read = readCodex(target);
    setTarget({ kind: 'codex', id: target.id, title: read?.title ?? target.id, lane: 'me' });
    console.log(`  钉住的目标：${String(read?.title ?? '').slice(0, 40)}（你说 ${read?.askCount} 句）`);
  }
}

let started = null;
const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };

mod.apply({
  logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: () => {},
  sessionProjections: { register: () => () => {}, stateOf: (s, k) => (k === 'agentPreset' ? 'review' : undefined) },
  subagents: { start: async (name, req) => { started = req; return { id: 'c', result: Promise.resolve({ output: [{ type: 'text', text: REVIEW }] }), dispose: async () => {} }; } },
  agents: { list: () => agents, get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 6000, codexWindowHours: 720 });

console.log('等待监控器第一次触发（最多 15 秒）…');
for (let i = 0; i < 30 && agent.injected === undefined; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
}
for (const id of timers) clearInterval(id);

const fired = agent.injected !== undefined;
check('监控器自己触发了', fired, fired ? '是' : '否（15 秒内没触发）');
check('监控器派出了复审子 Agent（提示词拿到了）', started !== null);
if (started !== null) {
  const prompt = String(started.prompt?.[0]?.text ?? '');
  console.log('  它用的提示词首行:', prompt.split('\n')[0]);
  check('提示词里含四个分析锚点（具体对话 / 对话概述 / 分析 / 建议）',
    /具体对话[\s\S]*对话概述[\s\S]*分析[\s\S]*建议/.test(prompt));
  check('提示词里**没有**旧的固定表格要求（三个问题 + 3×3）',
    !/三个问题（固定/.test(prompt) && !/^\|/m.test(prompt));
  check('parent 是审核会话', started.parent === agent);
}
if (agent.injected !== undefined) {
  const r = agent.injected.source.review;
  check('卡片四段都解析出来了 + 领先行有值',
    typeof r?.verdict === 'string' && typeof r?.headline === 'string' && r.headline.length > 0
    && Array.isArray(r?.dialog) && typeof r?.summary === 'string'
    && Array.isArray(r?.analysis) && r.analysis.length === 3 && Array.isArray(r?.advice) && r.advice.length === 2);
  console.log('\n落进面板的卡片：');
  console.log('  结论  ', r.verdict);
  console.log('  一句话', String(r.headline).slice(0, 56));
  console.log('  概述  ', String(r.summary).slice(0, 56));
  console.log('  分析  ', String(r.analysis?.[0]).slice(0, 56));
  console.log('  建议  ', String(r.advice?.[0]).slice(0, 56));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
