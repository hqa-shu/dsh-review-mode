/**
 * A 的证明：**一个线程 id = 一条对话**。
 *
 * 真实现场：Codex 把同一条对话拆成多个 `rollout-*.jsonl`（文件名第一段 uuid 相同，
 * 下划线后面是续写 id）。实测 `~/.codex` 里 thread `01a0decf-…` 有 7 个文件、
 * `01a0e19e-…` 5 个、`01a0ec83-…` 4 个、`01a0ecce-…` 3 个；67 个 rollout 文件。
 * 旧实现一个文件一行，于是用户在面板上看到同一条对话的三份（16:38 / 16:40 / 16:44），
 * 直接问「同样一个你会问两条呢？……我不懂」。
 *
 * 所以这里用**受控夹具**证明四件事：
 *   1. 同一线程的多个文件 → 候选目录里**恰好一行**；
 *   2. 条数是这些文件**相加**的真实条数，不是其中一个文件、也不是被截到 20；
 *   3. 时间戳与 id 取**最新那个文件**；
 *   4. `review_conversation` / 证据查得到的仍是这一条（id 与线程 id 都能找到），
 *      证据里的「你说 N 条」同样是相加后的数。
 *
 * 夹具靠 `HOME` 重定向（`os.homedir()` 在 POSIX 上读 `$HOME`），
 * 所以必须在 import `reviewer.js` **之前**设好 —— 缓存路径在模块加载时算出来。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  if (!pass) failed += 1;
};

/* ── 造一个假的 home：两个线程，一个拆 3 份、一个 1 份 ─────────── */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'review-merge-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const THREAD_A = '01a0decf-9f11-7a2b-8c3d-4e5f60718293';
const THREAD_B = '0bbbbbbb-1111-2222-3333-444455556666';

const SESSIONS = path.join(HOME, '.codex', 'sessions', '2026', '01', '01');
fs.mkdirSync(SESSIONS, { recursive: true });

/**
 * 写一个 rollout 文件。
 * @param {string} name - 文件名。
 * @param {number} userCount - 里面的用户消息条数。
 * @param {number} otherCount - 里面的对面 AI 消息条数。
 * @param {number} mtime - 修改时间（决定新旧的唯一依据）。
 */
function writeRollout(name, userCount, otherCount, mtime) {
  const lines = [JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/proj', id: name } })];
  for (let i = 0; i < userCount; i += 1) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `问题 ${name} #${i}` }] },
    }));
  }
  for (let i = 0; i < otherCount; i += 1) {
    lines.push(JSON.stringify({
      type: 'event_msg',
      payload: { item: { type: 'AgentMessage', content: [{ type: 'output_text', text: `回答 ${name} #${i}` }] } },
    }));
  }
  const file = path.join(SESSIONS, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

const now = Date.now();
// 同一线程的三份：2+3+4 = 9 条用户话，1+1+2 = 4 条对面话。最新的是第三份。
writeRollout(`rollout-2026-01-01T00-00-00-${THREAD_A}.jsonl`, 2, 1, now - 3 * 60_000);
writeRollout(`rollout-2026-01-01T00-10-00-${THREAD_A}_019c0000-0000-0000-0000-000000000001.jsonl`, 3, 1, now - 2 * 60_000);
const newestA = writeRollout(`rollout-2026-01-01T00-20-00-${THREAD_A}_019c0000-0000-0000-0000-000000000002.jsonl`, 4, 2, now - 60_000);
fs.appendFileSync(newestA, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
  content: [{ type: 'input_text', text: '<send_user_message_question_reply>结构化回执，不是用户说的话</send_user_message_question_reply>' }] } })}\n`);
fs.utimesSync(newestA, (now - 60_000) / 1000, (now - 60_000) / 1000);
// 另一个线程：一份，1 条用户话。
writeRollout(`rollout-2026-01-01T00-05-00-${THREAD_B}.jsonl`, 1, 0, now - 5 * 60_000);

// 索引：把两个线程都标上「项目 / 标题」，好验证 label 形状。
fs.writeFileSync(path.join(HOME, '.codex', 'session_index.jsonl'), [
  JSON.stringify({ id: THREAD_A, thread_name: '细节问答', updated_at: new Date(now).toISOString() }),
  JSON.stringify({ id: THREAD_B, thread_name: '试卷', updated_at: new Date(now).toISOString() }),
].join('\n'));
fs.writeFileSync(path.join(HOME, '.codex', '.codex-global-state.json'), JSON.stringify({
  'local-projects': { p1: { name: '5005复习' } },
  'thread-project-assignments': { [THREAD_A]: { projectId: 'p1' }, [THREAD_B]: { projectId: 'p1' } },
}));

/* ── 现在才 import 被测模块 ─────────────────────────────────── */

const {
  candidateLabel,
  conversationEvidence,
  listCodex,
  readCodex,
} = await import('../reviewer.js');

const entries = listCodex(100);
check('两个线程 → 恰好两行候选（不是四个文件四行）',
  entries.length === 2, `entries=${entries.length} files=${entries.flatMap((e) => e.files ?? []).length}`);
check('三份文件被并成同一行的 files 列表',
  entries.some((e) => e.threadId === THREAD_A && Array.isArray(e.files) && e.files.length === 3),
  JSON.stringify(entries.map((e) => [e.threadId, (e.files ?? []).length])));

const mergedA = entries.find((e) => e.threadId === THREAD_A);
check('id 取最新那个文件', mergedA?.id === path.basename(newestA).replace('rollout-', '').replace('.jsonl', ''), String(mergedA?.id));
check('时间戳取最新那个文件',
  Math.round(mergedA?.mtime ?? 0) === Math.round(fs.statSync(newestA).mtimeMs),
  `${Math.round(mergedA?.mtime ?? 0)} vs ${Math.round(fs.statSync(newestA).mtimeMs)}`);

const readA = readCodex(mergedA);
check('你说 N 条 = 三份文件相加（2+3+4=9）', readA.askCount === 9, `askCount=${readA.askCount}`);
check('结构化问答回执不算成用户原话', !readA.asks.some((item) => item.text.includes('send_user_message_question_reply')));
check('对面 M 条 = 三份文件相加（1+1+2=4）', readA.otherCount === 4, `otherCount=${readA.otherCount}`);
check('label 形状不变：项目 / 标题 · 你说 N 条 · 对面 M 条',
  candidateLabel(readA.title, readA.askCount, readA.otherCount) === '5005复习 / 细节问答 · 你说 9 条 · 对面 4 条',
  candidateLabel(readA.title, readA.askCount, readA.otherCount));

// 证据：用**最新文件的 id** 找得到。
const byNewestId = conversationEvidence('codex', mergedA.id, 'me');
check('review_conversation 用最新文件 id 找得到这条对话',
  byNewestId.title === '5005复习 / 细节问答', byNewestId.title);
check('证据里的条数也是相加后的 9 条',
  byNewestId.stats.includes('你说 9 条'), byNewestId.stats.split(' · ')[0]);
// 证据：用**线程 id** 也找得到（旧记录/旧 target 不会失灵）。
const byThread = conversationEvidence('codex', THREAD_A, 'me');
check('用线程 id 也找得到同一条对话（旧点选不失效）', byThread.title === byNewestId.title, byThread.title);

// 只读一个文件时（合成 entry，比如监控器 tick 的老调用形状）仍然能工作。
const single = readCodex({ id: mergedA.id, file: mergedA.file, threadId: THREAD_A, mtime: mergedA.mtime });
check('只给一个文件时仍按一份读（不抛、不炸）', single.askCount === 4, `askCount=${single.askCount}`);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
