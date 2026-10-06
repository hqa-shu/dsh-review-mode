/**
 * 宿主注入的指令**不算用户说的话**。
 *
 * 现场证据（2026-10-05 截图）：面板「你当时说的话」里，第 19 条是
 * `# AGENTS.md instructions <INSTRUCTIONS> # 项目开发规则 …` —— 那是宿主塞进会话的
 * 项目规则，用户一个字都没打。它一旦混进证据，就会把「这个任务最早的指令是什么」
 * 整个带偏，还可能让复审员去评价用户「指令冗长」。
 *
 * 这个脚本钉死两件事：注入块要被滤掉；用户自己写的长文、带尖括号的话**不许**被误伤。
 */
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'review-injected-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { isInjectedInstruction, evidenceFromEvents } = await import('../reviewer.js');

let pass = 0;
let fail = 0;
const check = (label, condition, extra = '') => {
  if (condition) { pass += 1; console.log(`PASS  ${label}${extra ? `  ${extra}` : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? `  ${extra}` : ''}`); }
};

/* ── 该滤掉的 ─────────────────────────────────────────────── */
const INJECTED = [
  '# AGENTS.md instructions <INSTRUCTIONS> # 项目开发规则 - 修改前先读',
  '<system-reminder>\nThe user opened a file.\n</system-reminder>',
  '<environment_context>cwd=/tmp</environment_context>',
  '<user_instructions>always answer in Chinese</user_instructions>',
  '<command-name>/model</command-name>',
];
for (const text of INJECTED) {
  check(`注入块被认出来：${text.slice(0, 24)}…`, isInjectedInstruction(text) === true);
}

/* ── 不许误伤的 ───────────────────────────────────────────── */
const REAL = [
  '帮我把登录接口的单元测试补完',
  '这段报错是 TypeError: Cannot read properties of undefined，你看看',
  '我贴一段很长的需求：第一，要支持导出；第二，要支持筛选；第三，要能分享。'.repeat(8),
  '用 <div> 包一层再试试',
  '',
];
for (const text of REAL) {
  check(`用户真话不被误伤：${text.slice(0, 20) || '(空串)'}`, isInjectedInstruction(text) === false);
}

/* ── 走一遍真的取证路径：注入块不进原话、也不进证据包 ────────── */
const events = [
  { type: 'session', seq: 1, data: { header: { id: 's1', cwd: '/w' } } },
  { type: 'turn/start', seq: 2, data: { turn: 1 } },
  { type: 'user/message', seq: 3, data: { source: { kind: 'user' },
    content: [{ type: 'text', text: '# AGENTS.md instructions <INSTRUCTIONS> 项目规则：先读文档' }] } },
  { type: 'user/message', seq: 4, data: { source: { kind: 'user' },
    content: [{ type: 'text', text: '把登录接口的单元测试补完' }] } },
  { type: 'assistant/message', seq: 5, data: { content: [{ type: 'text', text: '好的，我先看覆盖率。' }] } },
  { type: 'turn/end', seq: 6, data: { turn: 1 } },
];
const evidence = evidenceFromEvents(events, 'me');
check('原话列表里没有注入块', evidence.youSaid.every((text) => !text.includes('AGENTS.md')),
  JSON.stringify(evidence.youSaid));
check('原话列表留下了用户真的说的那句', evidence.youSaid.some((text) => text.includes('单元测试')));
check('证据包里也没有注入块',
  evidence.reviewPacket.sources.every((source) => !source.text.includes('AGENTS.md')),
  evidence.reviewPacket.sources.map((s) => `${s.id}:${s.text.slice(0, 18)}`).join(' | '));
// 这条最要紧：`buildReviewPacket` 给「最早那条用户消息」很高的权重，用来锚定任务目标。
check('最早那条用户证据是真指令，不是项目规则',
  evidence.reviewPacket.sources.find((source) => source.role === 'user')?.text.includes('单元测试') === true);

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
assert.equal(fail, 0);
