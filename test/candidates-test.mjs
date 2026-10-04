/**
 * FLOW.md 第 4 步的证明：**候选数据本身长什么样、三条审核线怎么分**。
 *
 * 入口在 2026-10 唯一化（只留面板那三个方块），所以这里测的**不再是**「主 Agent 怎么把
 * 候选做成可点选项」——那套循环已被删除。留下的是 `list_conversations` /
 * `conversationEvidence` 给出的**数据形状**（用户用文字点名时还要用它们）：
 *   (a) label 是「项目 / 标题 · 你说 N 条 · 对面 M 条」，不是「你最后说的那句」；
 *   (b) 「你说了 0 条」的对话在「审我」这条线上跳过并报出条数，但**不全局隐藏** ——
 *       「审对话」这条线里它照样是候选（用户 2026-10 修正：三条线要分开审）；
 *   (c) `list_conversations` 的默认 limit 要给出**全量**，不再只给 8 条；
 *   (d) persona 里不再有「一次最多给 4 个」这种**我们自己编的**上限，也不再要求
 *       主 Agent 做候选点选循环 / 输出那张固定表格（见文件末尾的 (d) 段）。
 *
 * 用真实的 ~/.codex 数据跑 `reviewer.js` 的真代码，不重启、不联网。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  apply,
  currentTarget,
} from '../reviewer.js';
import {
  ANALYSIS_SECTIONS,
  emptyAnalysis,
  leadingLine,
  parseAnalysis,
  renderAnalysisFormat,
} from '../rubric.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  if (!pass) failed += 1;
};

// 跑一遍预设行的 apply，把两个工具收下来（和 target-test 一样）。
const tools = new Map();
apply({
  effect: (fn) => fn(),
  logger: { warn() {} },
  tools: { restrict: () => () => {}, register: (def) => tools.set(def.name, def) },
});
const list = tools.get('list_conversations');
const review = tools.get('review_conversation');
check('两个工具都注册上了', list !== undefined && review !== undefined);

// ── (c) 默认 limit = 全量 ────────────────────────────────────
const def = list.execute({ kind: 'codex' });                    // 默认 lane=me
const all = def.conversations;
check('(c) 默认不再只给 8 条', all.length > 8, `→ ${all.length} 条`);
check('(c) 默认给的就是「全量减去这条线用不上的」',
  all.length + def.excluded === def.total, `→ ${all.length} + ${def.excluded} = ${def.total}`);
check('(c) 显式 limit 仍然生效（不多给）', list.execute({ kind: 'codex', limit: 3 }).conversations.length <= 3);

// ── (b) 「审我」这条线跳过 0 条对话，并报数 ───────────────────
const conv = list.execute({ kind: 'codex', lane: 'conversation' });
check('(b) 默认（lane=me）列表里没有「你说 0 条」的对话',
  all.every((c) => c.userMessages > 0));
check('(b) 报出了跳过的条数', def.excluded > 0, `→ 跳过 ${def.excluded} 条`);
check('(b) 跳过条数 = 全量里 0 条的条数',
  def.excluded === conv.conversations.filter((c) => c.userMessages === 0).length,
  `→ ${def.excluded} vs ${conv.conversations.filter((c) => c.userMessages === 0).length}`);
check('(b) 跳过说明说清了为什么，并指出还有另一条线',
  /0\s*句/.test(String(def.excludedNote ?? '')) && /跳过/.test(String(def.excludedNote ?? ''))
  && /审对话/.test(String(def.excludedNote ?? '')),
  `→ ${def.excludedNote}`);
check('(b) 「审对话」这条线里 0 句对话**没有被隐藏**',
  conv.conversations.some((c) => c.userMessages === 0) && conv.excluded === 0,
  `→ ${conv.conversations.filter((c) => c.userMessages === 0).length} 条 0 句的仍在候选里`);
check('(b) lane=conversation 的 max 条数不打折',
  conv.matching === conv.total, `→ ${conv.matching} / ${conv.total}`);
check('(b) 有用户消息的排在 0 条的前面', (() => {
  const rows = conv.conversations;
  const firstEmpty = rows.findIndex((c) => c.userMessages === 0);
  if (firstEmpty === -1) return true;
  return rows.slice(0, firstEmpty).every((c) => c.userMessages > 0);
})());

// ── (a) label = 项目 / 标题 · 你说 N 条 · 对面 M 条 ───────────
const sample = all.find((c) => c.userMessages > 0);
const label = String(sample?.label ?? '');
const title = String(sample?.title ?? '');
check('(a) label 形如「项目 / 标题 · 你说 N 条 · 对面 M 条」',
  /^.+ · 你说 \d+ 条 · 对面 \d+ 条$/.test(label), `→ ${label}`);
check('(a) label 以 title（项目 / 标题）打头', label.startsWith(title.slice(0, 48)), `→ ${label} / ${title}`);
check('(a) label 的两个条数就是返回的字段',
  label.endsWith(` · 你说 ${sample?.userMessages} 条 · 对面 ${sample?.otherMessages} 条`),
  `→ ${label}`);
check('(a) label 不是「你最后说的那句」',
  String(sample?.lastSaid ?? '') === '' || !label.includes(String(sample?.lastSaid).slice(0, 16)),
  `→ label=${label}`);
check('(a) 最后那句原话作为单独字段给出（供 description 用）',
  typeof sample?.lastSaid === 'string' && sample.lastSaid.length > 0, `→ ${sample?.lastSaid}`);
check('(a) 两个条数都是真数字（对面 > 0，因为 AI 说过话）',
  Number.isInteger(sample?.userMessages) && Number.isInteger(sample?.otherMessages)
  && sample.otherMessages > 0, `→ 你说 ${sample?.userMessages} · 对面 ${sample?.otherMessages}`);

// render 是模型真正读到的东西 —— label 与跳过说明必须在里面。
const rendered = list.output.render({}, def)[0].text;
check('(a) render 里直接给出 label 字段（模型照抄即可）', /label\s*[:：]/.test(rendered));
check('(a) render 里给出「你最后说」原话', rendered.includes(String(sample?.lastSaid).slice(0, 10)));
check('(b) render 里带上了跳过说明',
  String(def.excludedNote ?? '').length > 0 && rendered.includes(String(def.excludedNote ?? '\u0000')));

// ── 三条线：0 句对话在 me 被跳过，在 conversation / agent 仍是候选 ──
// 挑一条「你 0 句、但对面说了话」的 —— 这正是「只在审我这条线上没什么可审」的那种。
const zeroSample = conv.conversations.find((c) => c.userMessages === 0 && c.otherMessages > 0)
  ?? conv.conversations.find((c) => c.userMessages === 0);
check('(线) 确实找到一条「你说了 0 条」的真实对话', zeroSample !== undefined,
  zeroSample === undefined ? '' : `→ ${zeroSample.title}`);
const agentLane = list.execute({ kind: 'codex', lane: 'agent' });
check('(线) agent 这条线也存在，且 0 句对话没被隐藏',
  agentLane.lane === 'agent' && agentLane.conversations.some((c) => c.userMessages === 0),
  `→ ${agentLane.conversations.filter((c) => c.userMessages === 0).length} 条 0 句的在候选里`);
if (zeroSample !== undefined) {
  const ev = review.execute({ kind: 'codex', id: zeroSample.id, lane: 'conversation' });
  check('(线) 0 句对话在「审对话」里能取到证据，且对面有话',
    ev.lane === 'conversation' && Array.isArray(ev.otherSaid) && ev.otherSaid.length > 0,
    `→ 对面 ${ev.otherSaid?.length} 条`);
  check('(线) 0 句对话的「审我」主体为空', Array.isArray(ev.youSaid) && ev.youSaid.length === 0);
  // **render 是模型真正读到的东西。** 改前它把整份证据 + 「输出格式」+ 空表格倒给
  // 主 Agent，等于请它自己填表再写进回复 —— 用户看到的就是「表长在对话里、面板空着」。
  // 现在复审是宿主的事，render 只能是一句回执。下面这条断言守的就是这一点。
  const evText = review.output.render({}, ev)[0].text;
  check('(线) render 不再把证据原文倒给主 Agent（不再出现证据小标题）',
    !evText.includes('整条对话 · 对面 AI 说过的话') && !evText.includes('你（用户）说过的话（审核主体）'),
    evText.slice(0, 80));
  check('(线) render 里没有任何表格（对话区不许出现表）',
    !evText.includes('|') && !/① 主题漂移/.test(evText), evText.slice(0, 80));
  const agentEv = review.execute({ kind: 'codex', id: zeroSample.id, lane: 'agent' });
  const agentText = review.output.render({}, agentEv)[0].text;
  check('(线) 三条线给主 Agent 的都是同一形状的回执（只换「哪条线」）',
    agentText.includes('这条线：审 Agent') && evText.includes('这条线：审对话')
    && !agentText.includes('|') && !/对面 AI 说过的话（审核主体）/.test(agentText),
    agentText.split('\n')[0]);
  const meEv = review.execute({ kind: 'codex', id: zeroSample.id, lane: 'me' });
  check('(线) 同一条对话走「审我」时主体（用户的话）是空的',
    meEv.lane === 'me' && meEv.youSaid.length === 0);
}
// 三条线记进共享状态的是不同的 lane（index.js 的监控器靠它选提示词）。
const mePick = list.execute({ kind: 'codex', lane: 'me' }).conversations[0];
review.execute({ kind: 'codex', id: mePick.id, lane: 'agent' });
check('(线) review_conversation 把 lane 记进 currentTarget',
  currentTarget()?.lane === 'agent');

// ── (分析) 结论形状来自 `rubric.js` 的四个锚点，**条数不固定** ──
// 这一整块替换了旧的「每次都生成同一张 3×3 表格」断言：用户 2026-10 明确
// 「我感觉有点呆吧」「分析没有必要一定按照三个选项」，所以那张表连同
// `REVIEW_TABLE_ROWS` / `REVIEW_TABLE_COLUMNS` / `parseReviewTable` / `renderReviewTable`
// 一起删掉了。现在守的是**新**要求：四个锚点固定、条数自由、领先行永远有值。
check('(分析) 段落常量正好是「具体对话 / 对话概述 / 分析 / 建议」四个锚点',
  ANALYSIS_SECTIONS.map((s) => s.title).join('|') === '具体对话|对话概述|分析|建议',
  `→ ${ANALYSIS_SECTIONS.map((s) => s.title).join(' / ')}`);
check('(分析) 每个锚点都有 key 和 hint（提示词与解析器共用同一份）',
  ANALYSIS_SECTIONS.every((s) => typeof s.key === 'string' && s.key.length > 0
    && typeof s.hint === 'string' && s.hint.length > 0));
const evalA = parseAnalysis([
  '结论: drifting',
  '一句话: A 从课件滑到路径',
  '## 具体对话',
  '- 你：「课件当中有讲这几个算法吗？」',
  '## 对话概述',
  '你在核对课件覆盖。',
  '## 分析',
  '- 第二个问题跟原问题无关。',
  '- 页码口径一直没定。',
  '## 建议',
  '- [给用户] 先定页码口径。',
].join('\n'));
const evalB = parseAnalysis('结论: on-track\n完全不是标准格式的一段自由文本，模型这次没按小标题写。');
const shape = (record) => ANALYSIS_SECTIONS.map((s) => `${s.key}:${s.key === 'summary'
  ? (typeof record[s.key] === 'string' ? '1' : '0')
  : (Array.isArray(record[s.key]) ? '1' : '0')}`).join('|');
check('(分析) 两次完全不同的评估，**段落形状**逐字一致（缺段留空，不消失）',
  shape(evalA) === shape(evalB) && shape(evalA) === shape(emptyAnalysis()),
  `${shape(evalA)}`);
check('(分析) 条数**不固定**：A 的分析有 2 条、建议有 1 条（不是每格一条）',
  evalA.analysis.length === 2 && evalA.advice.length === 1, `→ 分析 ${evalA.analysis.length} 条 / 建议 ${evalA.advice.length} 条`);
check('(分析) 完全不合格式的自由文本也不会丢：整段落进「分析」，领先行取第一句',
  evalB.analysis.length === 1 && leadingLine(evalB).length > 0, `→ ${leadingLine(evalB)}`);
check('(分析) 领先行优先取 `一句话:`，没有才退回第一条分析',
  leadingLine(evalA) === 'A 从课件滑到路径' && leadingLine(evalB).includes('自由文本'));
check('(分析) 提示词格式块里有四个锚点、结论行与领先行，且**没有** 3×3 表格',
  (() => {
    const lines = renderAnalysisFormat();
    const text = lines.join('\n');
    return ANALYSIS_SECTIONS.every((s) => text.includes(`## ${s.title}`))
      && text.includes('结论: on-track | drifting | off-track | unknown')
      && text.includes('一句话')
      && !/^\|/m.test(text);
  })());

// ── (d) persona：入口唯一化之后，候选点选循环与「主 Agent 出表」都不再是它的活 ──
//
// 旧断言（本次删掉）要求 persona 写「一次给 8 个」「下一批」「看完整目录」「label 直接用」。
// **那些现在都是错的**：用户 2026-10 批准「只留面板那三个方块」，
// 于是「一轮轮把候选做成可点选项」这个和面板重复的入口被整个删掉，
// 主 Agent 也不再输出那张固定表格（复审由宿主的子 Agent 做、只落在面板）。
const doc = yaml.load(fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8'));
const suffix = String(doc[0].insert[0].config.plugins.find((p) => p.id === 'persona')?.config?.suffix ?? '');
check('(d) persona 不再有「最多 N 个」这种人为上限',
  !/最多\s*[0-9一二三四五六七八九十]+\s*(个|条)?\s*选项/.test(suffix) && !/一次最多/.test(suffix));
/** 判据：persona 里不再有「让主 Agent 分批给候选选项」的那套循环。 */
const noCandidateLoop = (text) => !/下一批/.test(text) && !/完整目录/.test(text)
  && !/一次给\s*8\s*个/.test(text) && !/把候选做成可点的选项/.test(text);
check('(d) persona 不再要求主 Agent 做候选点选循环（入口唯一化）',
  noCandidateLoop(suffix));
check('(d) 反向变异：把旧的候选循环拼回去，noCandidateLoop 必须变红',
  noCandidateLoop(suffix) === true
  && noCandidateLoop(`${suffix}\n一次给 8 个；还有剩就给「下一批」和「看完整目录」。`) === false);
check('(d) persona 三条线都点名，并要求 lane',
  suffix.includes('审我') && suffix.includes('审对话') && suffix.includes('审 Agent') && suffix.includes('lane'));
check('(d) persona 说的是**四段自适应分析**、条数不固定，且只落在面板',
  suffix.includes('具体对话') && suffix.includes('对话概述') && suffix.includes('分析')
  && suffix.includes('建议') && /条数不固定/.test(suffix)
  && /只落在(下面|右边)的审核面板/.test(suffix) && !suffix.includes('输出格式'));
check('(d) persona 里**没有**「固定表格 / 每次都一模一样」这类旧要求',
  !/固定表格/.test(suffix) && !/每次都(一模一样|不变)/.test(suffix) && !/\|\s*① 主题漂移\s*\|/.test(suffix));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
