import assert from 'node:assert/strict';
import { buildReviewPacket, buildTurnContext, verifyReviewRecord } from '../evidence-packet.js';
import { conversationSource, evidenceFromEvents } from '../reviewer.js';

const timeline = [
  { role: 'user', turn: 1, sourceKey: 'selected:u1', text: '先不要推送。请把说明写得更好读。' },
  { role: 'ai', turn: 1, sourceKey: 'selected:a1', text: '我会压到 160 行。' },
  ...Array.from({ length: 30 }, (_, i) => ({ role: 'user', turn: i + 2, sourceKey: `selected:u${i + 2}`, text: `无关练习 ${i}` })),
  { role: 'user', turn: 32, sourceKey: 'selected:u32', text: '请继续检查\n这一轮是否完成。' },
  { role: 'ai', turn: 32, sourceKey: 'selected:a32', text: '我已经检查了最新一轮。' },
  { role: 'tool', turn: 32, sourceKey: 'selected:t32', status: '已返回', text: '测试返回：通过' },
];
const packet = buildReviewPacket(timeline, 'agent', { latestTurnComplete: true });
assert(packet.sources.some((source) => source.text.includes('先不要推送')));
assert(packet.sources.some((source) => source.text.includes('请继续检查\n这一轮')));
assert(packet.sources.some((source) => source.role === 'ai' && source.text.includes('已经检查')));
assert(packet.sources.length <= 16 && packet.sources.reduce((n, source) => n + source.text.length, 0) <= 9500);
assert.match(packet.coverage, /其余内容未逐条复核/);
console.log('PASS 长会话保留最初限制、最近往返和覆盖说明，原文换行未被伪造');

const turnContext=buildTurnContext([
  {role:'user',turn:1,sourceKey:'c:u1',text:'做一份案例 PPT，保留已有设计'},
  {role:'ai',turn:1,sourceKey:'c:a1',text:'我会沿用已有设计'},
  {role:'user',turn:2,sourceKey:'c:u2',text:'R&D 全称是什么？'},
  {role:'ai',turn:2,sourceKey:'c:a2',text:'Research and Development'},
  {role:'user',turn:3,sourceKey:'c:u3',text:'请统一全篇 R&D 术语'},
  {role:'ai',turn:3,sourceKey:'c:a3',text:'收到，但尚未给出修改后的文件'},
], 'c:u2');
assert(turnContext.promptText.includes('做一份案例 PPT'));
assert(turnContext.promptText.includes('Research and Development'));
assert(turnContext.promptText.includes('请统一全篇 R&D 术语'));
assert.match(turnContext.promptText,/发生在本条之后，不得倒算成当时已知条件/);
assert.equal(turnContext.paired.length,1);
assert.equal(turnContext.before.length,1);
assert.equal(turnContext.after.length,1);
assert.equal(buildTurnContext([{role:'user',sourceKey:'other',text:'另一条会话'}],'c:u2'),null);
console.log('PASS 逐条建议参考目标前后的有限上下文并标明时间边界，不串入其他会话');

const ai = packet.sources.find((source) => source.text.includes('压到 160 行'));
const review = {
  verdict: 'drifting', headline: '模型误归因', summary: '检查表达',
  analysis: [`模型误归因｜依据：用户说 [${ai.id}]「压到 160 行」｜洞察：数字来自 AI｜建议：按原来源标注`],
  advice: ['按原来源标注'], dialog: ['模型自写引文'],
};
const verified = verifyReviewRecord(review, packet);
assert.equal(verified.evidenceChecked, true);
assert.match(verified.analysis[0], /AI在第1轮回答：「压到 160 行」/);
assert(!verified.analysis[0].includes('[A'));
assert(verified.evidenceSources[0].some((source) => source.sourceKey === 'selected:a1'));
assert.deepEqual(verified.openIssues, []);
console.log('PASS 标记指向 AI 时按真实来源改写依据，不相信模型写的说话人');

const repeated = buildReviewPacket([
  { role: 'user', turn: 1, text: '收到' },
  { role: 'ai', turn: 1, text: '收到' },
], 'conversation', { latestTurnComplete: true });
const ambiguous = verifyReviewRecord({ ...review, analysis: ['重复｜依据：「收到」｜洞察：不能猜说话人｜建议：查来源'] }, repeated);
assert.equal(ambiguous.analysis.length, 0);
assert.equal(ambiguous.verdict, 'unknown');
console.log('PASS 两方重复同一句且无来源标记时不猜说话人');

const forged = verifyReviewRecord({ ...review, analysis: ['伪引文｜依据：[A99]「压到 160 行」｜洞察：无来源｜建议：核对'] }, packet);
assert.equal(forged.analysis.length, 0);
assert.equal(forged.droppedEvidence, 1);
console.log('PASS 不在本次所选会话证据包里的标记不会进入评价');

const tool = packet.sources.find((source) => source.role === 'tool');
const action = verifyReviewRecord({ ...review, analysis: [`工具结果｜依据：[${tool.id}] 工具已返回｜洞察：有返回记录｜建议：检查产物`] }, packet);
assert.match(action.analysis[0], /工具在第32轮返回（已返回）/);
const commandOnly = buildReviewPacket([{ role: 'tool', turn: 1, text: '执行命令：测试' }], 'agent');
assert.equal(verifyReviewRecord({ ...review, analysis: ['命令｜依据：[T1] 已执行｜洞察：成功｜建议：继续'] }, commandOnly).analysis.length, 0);
console.log('PASS 工具结果可引用，只有命令而没有结果状态不能证明执行成功');

const overclaim = verifyReviewRecord({ ...review, analysis: [`AI一直没有回应｜依据：[${ai.id}]「压到 160 行」｜洞察：持续犯错｜建议：重试`] }, packet);
assert.equal(overclaim.analysis.length, 0);
const truncated = buildReviewPacket([{ role: 'user', turn: 1, text: `请检查${'细节'.repeat(700)}` }], 'me');
assert.equal(truncated.selected, truncated.total);
assert.equal(truncated.sources[0].truncated, true);
assert.equal(verifyReviewRecord({ ...review, analysis: ['从未检查｜依据：[U1]「请检查」｜洞察：一直没有检查｜建议：重新检查'] }, truncated).analysis.length, 0);
console.log('PASS 未覆盖全部记录时不输出绝对否定或持续犯错的结论');

const pending = buildReviewPacket([{ role: 'user', turn: 2, text: '请检查' }], 'agent', { latestTurnComplete: false });
const ended = buildReviewPacket([{ role: 'user', turn: 2, text: '请检查' }], 'agent', { latestTurnComplete: true });
assert.equal(pending.pendingReply, true);
assert.equal(ended.pendingReply, false);
assert.equal(ended.missingReply, true);
console.log('PASS 进行中与已结束但未答复是不同状态');

const events = [
  { type: 'turn/start', seq: 1, data: { turn: 4 } },
  { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请保留\n原样' }] } },
  { type: 'assistant/message', seq: 3, data: { content: [{ type: 'text', text: '我会保留原样' }] } },
  { type: 'turn/end', seq: 4, data: { turn: 4, reason: { kind: 'completed' } } },
];
const ownEvidence = evidenceFromEvents(events, 'conversation');
assert(!JSON.stringify(ownEvidence).includes('sourceTimeline'));
const opened = conversationSource('self', 'selected', 'self:2', events);
assert.equal(opened.source.text, '请保留\n原样');
assert.equal(opened.neighbor[0].text, '我会保留原样');
assert.throws(() => conversationSource('self', 'selected', 'self:other-session', events));
console.log('PASS 完整原文按当前会话来源定位，同轮回复可见，内部全文不会进入面板初始 JSON');
