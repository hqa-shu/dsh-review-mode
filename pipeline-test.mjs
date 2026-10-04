// 用假宿主环境跑通整条复审链。之所以能在普通 Node 下直接跑，是因为插件零第三方依赖。
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(here, 'index.js'));

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const REVIEW = `本会话结论: drifting
一句话: 范围一直在滚大，同一个问题已经连续三轮出现。
未结问题:
- [持续] 用户说「把界面也改一下」至今没有验收
- [新] 用 sed 修改测试断言去迁就实现
已解决:
- 之前没有读回验证
给用户的话:
- 你的「弄好了」没有验收标准。
给 Agent 的话:
- 补上界面验收路径。
做对的地方:
- 用 stateVersion 当探针证伪了热加载假设。
噪声/风险:
- 改测试去迁就实现。
约束核对:
- 用户要求不要动 cordis.patch.yml：遵守。
Codex 观察:
- 【A】指令含糊。
下一步检查点: 先确认界面在哪。`;

function makeHost(opts = {}) {
  const cap = { handlers: new Map(), projection: null, prompt: '', injected: null, logs: [] };
  const ctx = {
    logger: { warn: (...a) => cap.logs.push(a.map(String).join(' ')), info: () => {} },
    // 宿主上下文必须带 reflect 字段：cordis 的 Service 构造函数会读 `ctx.reflect.provide`，
    // 没有它 ReviewRemote 一构造就抛「Cannot read properties of undefined (reading 'provide')」。
    reflect: { provide: () => {}, get: () => undefined },
    effect: (fn) => fn(),
    on: (n, f) => cap.handlers.set(n, f),
    sessionProjections: {
      register: (def) => { cap.projection = def; return () => {}; },
      stateOf: (s, key) => (key === 'agentPreset' ? 'review' : key === 'reviewMode' ? (opts.progress ?? {}) : undefined),
    },
    subagents: {
      start: async (name, req) => {
        cap.prompt = req.prompt.map((b) => b.text).join('\n');
        return { id: 'c', localAgent: undefined, result: Promise.resolve({ output: [{ type: 'text', text: opts.reviewText ?? REVIEW }] }), dispose: async () => {} };
      },
    },
    agents: { get: (id) => (id === opts.agent?.id ? opts.agent : undefined), withoutInitiator: (op) => op() },
  };
  mod.apply(ctx, opts.config ?? {});
  return cap;
}

function makeEvents({ calls = 4, earlyError = false } = {}) {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把投影版本号改一下，别动 cordis.patch.yml' }] } },
    { type: 'tool/call', seq: 3, data: { turn: 1, callId: 'b0', name: 'bash', arguments: '{"command":"sed -i \\"\\" s/2/3/ index.js"}' } },
  ];
  let seq = 4;
  if (earlyError) {
    events.push({ type: 'tool/result', seq: seq++, data: { turn: 1, message: { toolCallId: 'b0', isError: true }, error: { name: 'BashError', code: 'EXIT_1', reason: 'boom' } } });
  }
  for (let i = 0; i < calls; i += 1) {
    events.push({ type: 'tool/call', seq: seq++, data: { turn: 1, callId: `c${i}`, name: 'read', arguments: `{"file_path":"f${i}.js"}` } });
  }
  events.push({ type: 'tool/call', seq: seq++, data: { turn: 1, callId: 'w1', name: 'write', arguments: '{"file_path":"a.js"}' } });
  events.push({ type: 'assistant/message', seq: seq++, data: { turn: 1, message: { content: [{ type: 'text', text: '改好了。' }] } } });
  return events;
}

const mkAgent = (events) => ({
  id: 's1', injected: null,
  session: { header: { id: 's1', cwd: '/w' }, seq: events[events.length - 1].seq + 1,
    snapshotEvents: (a, b) => events.filter((e) => e.seq >= a && e.seq < b) },
  inject(m) { this.injected = m; },
});

/* ── 1. 投影与记忆形式 ─────────────────────────────────── */
const events = makeEvents({ earlyError: true });
const agent = mkAgent(events);
const host = makeHost({ agent, progress: { turn: 1, toolCalls: 6, totalToolCalls: 6, turnStartSeq: 1, reviews: 0, trajectory: [], issues: [], resolved: [], last: null } });
ok('投影 stateVersion = 7', host.projection?.stateVersion === 7);
ok('初始记忆为空且形状正确', host.projection.init({}, 0).issues.length === 0 && Array.isArray(host.projection.init({}, 0).trajectory));

let st = host.projection.init({}, 0);
for (const e of events) st = host.projection.apply(st, e);
ok('turn/start 记录 turnStartSeq（用于按轮扫描）', st.turnStartSeq === 1, `${st.turnStartSeq}`);

const fold = (state, review) => host.projection.apply(state, { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [{ id: `m${review.turn}`, source: { kind: 'review-mode', review } }] } });
const mkReview = (turn, verdict, issues = [], resolved = []) => ({
  verdict, summary: 's', forUser: [], forAgent: [], good: [], noise: [], constraints: [], codexObs: [],
  openIssues: issues, resolvedIssues: resolved, nextCheck: '', turn, at: turn, digestChars: 0, dropped: [], raw: '',
});

// 游程压缩：连续 3 轮同结论应为 1 段
let m = fold(st, mkReview(1, 'on-track'));
m = fold(m, mkReview(2, 'drifting', [{ text: '界面零验收', carried: false, side: 'self' }]));
m = fold(m, mkReview(3, 'drifting', [{ text: '界面零验收', carried: true, side: 'self' }]));
m = fold(m, mkReview(4, 'drifting', [{ text: '界面零验收', carried: true, side: 'self' }]));
ok('轨迹游程压缩（4 轮 → 2 段）', m.trajectory.length === 2, JSON.stringify(m.trajectory));
ok('连续同结论合并成一段（2-4 轮）', m.trajectory[1].from === 2 && m.trajectory[1].to === 4, JSON.stringify(m.trajectory[1]));
ok('同一问题被继承：sinceTurn 保持 2、计数变 3', m.issues[0].sinceTurn === 2 && m.issues[0].rounds === 3, JSON.stringify(m.issues[0]));

// 反棘轮：不再报出的问题被移除
const m2 = fold(m, mkReview(5, 'drifting', [{ text: '另一个新问题', carried: false, side: 'self' }]));
ok('反棘轮：不再报出的问题被移除', m2.issues.length === 1 && m2.issues[0].text === '另一个新问题', JSON.stringify(m2.issues));

// 已解决有界
let m3 = m2;
for (let i = 6; i <= 9; i += 1) m3 = fold(m3, mkReview(i, 'drifting', [{ text: '另一个新问题', carried: true, side: 'self' }], [`修好的第${i}件`]));
ok('已解决只留最近 2 条', m3.resolved.length === 2, JSON.stringify(m3.resolved.map((r) => r.text)));
ok('轨迹有界（≤8 段）', m3.trajectory.length <= 8);

/* ── 2. 记忆段大小与会话长度无关（保留设计的核心指标）────── */
// 一个 60 轮的假想记忆：轨迹已压缩成 4 段，问题只有 1 条但已持续 58 轮。
const longState = {
  trajectory: [
    { from: 1, to: 20, verdict: 'on-track' }, { from: 21, to: 35, verdict: 'drifting' },
    { from: 36, to: 50, verdict: 'drifting' }, { from: 51, to: 60, verdict: 'off-track' },
  ],
  issues: [{ text: '用户说「把界面也改一下」至今没有验收', side: 'self', sinceTurn: 2, rounds: 58 }],
  resolved: [{ text: '之前没有读回验证', atTurn: 7 }],
};
async function memorySection(state) {
  const h = makeHost({
    agent: mkAgent(events),
    progress: { turn: state.turn, toolCalls: 5, totalToolCalls: 9999, turnStartSeq: 1, reviews: state.turn, trajectory: state.trajectory, issues: state.issues, resolved: state.resolved, last: null },
  });
  await h.handlers.get('agent/turn-stopping')({ agent: mkAgent(events), turn: state.turn, signal: new AbortController().signal });
  await new Promise((r) => setTimeout(r, 300));
  const m = h.prompt.match(/## 你的记忆[^\n]*\n([\s\S]*?)\n\n/);
  return m === null ? -1 : m[1].length;
}
const shortMem = await memorySection({ turn: 4, trajectory: m.trajectory, issues: m.issues, resolved: [] });
const longMem = await memorySection({ turn: 60, trajectory: longState.trajectory, issues: longState.issues, resolved: longState.resolved });
ok('记忆段大小与会话长度无关（4 轮 vs 60 轮）', longMem - shortMem < 150 && longMem < 700, `4轮=${shortMem} 字, 60轮=${longMem} 字`);

/* ── 2.5 计数前缀污染（多轮真实测试抓到的 bug）──────────── */
// 复审员会把记忆里的【第N轮起，已M轮】抄进自己的输出，导致继承与反棘轮失效。
const polluted = fold(m, mkReview(6, 'drifting', [
  { text: '【第4轮起，已2轮】界面零验收', carried: true, side: 'self' },
  { text: '[第2轮起，已1轮] 宣称超过证据', carried: true, side: 'self' },
]));
const byText = (t) => polluted.issues.find((i) => i.text.includes(t));
ok('剥掉被抄进来的计数前缀后仍能继承（sinceTurn 保持 2）', byText('界面零验收')?.sinceTurn === 2,
  JSON.stringify(polluted.issues.map((i) => [i.text, i.sinceTurn, i.rounds])));
ok('继承时计数继续增长而不是重置', byText('界面零验收')?.rounds === 4, `rounds=${byText('界面零验收')?.rounds}`);
ok('输出里不再残留被抄进来的前缀', !byText('界面零验收')?.text.startsWith('【'), byText('界面零验收')?.text);

/* ── 3. 提示词：分段上限、轮内扫描、shell 写入 ──────────── */
const host2 = makeHost({ agent, progress: { turn: 1, toolCalls: 6, totalToolCalls: 6, turnStartSeq: 1, reviews: 0, trajectory: [], issues: [], resolved: [], last: null } });
await host2.handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal });
await new Promise((r) => setTimeout(r, 400));
const p = host2.prompt;
ok('提示词已生成', p.length > 500, `${p.length} 字符`);
ok('使用新的记忆段标题', p.includes('## 你的记忆：轨迹 + 之前提过但没解决的问题'));
ok('首次复审说明了记忆为空', p.includes('这是本会话第一次复审'));
ok('含反串台规则', p.includes('【不要串台】'));
ok('输出格式要求带标签的问题清单', p.includes('未结问题:') && p.includes('[持续]'));
const sections = p.split('\n').filter((l) => l.startsWith('## '));
ok('所有段落都在（分段上限阻止互相驱逐）', !p.includes('没有提供这些段落：'), `段落数 ${sections.length}`);

// 轮内扫描：错误在轮次开头（seq 4），窗口足够大
ok('抓到本轮的失败（轮内扫描修复了静默丢失）', p.includes('bash 失败（EXIT_1）'), p.includes('没有记录到工具失败') ? '← 仍报无失败' : '');

// shell 写入：sed -i 不该被说成「没有改写任何文件」
ok('识别出经 shell 写入的命令', p.includes('含写入/改名动作'), '');
ok('没有谎报「没有改写任何文件」', !p.includes('这一轮没有改写任何文件'));

// 段落大小都在上限内
const FIXED_SECTIONS = ['## 复审清单', '## 输出格式'];  // 固定说明，不受证据段上限约束
const over = [];
for (const part of p.split(/\n(?=## )/)) {
  const t = part.split('\n')[0];
  if (!t.startsWith('## ') || FIXED_SECTIONS.some((f) => t.startsWith(f))) continue;
  if (part.length > 950) over.push(`${t.slice(3, 30)}=${part.length}`);
}
ok('没有任何证据段失控膨胀（每段都有上限）', over.length === 0, over.join(', '));

/* ── 4. 结论解析与两份建议 ─────────────────────────────── */
const review = agent.injected?.source?.review;
ok('解析出本会话结论 = drifting', review?.verdict === 'drifting');
ok('解析出未结问题（持续 + 新）', review?.openIssues?.length === 2 && review.openIssues[0].carried === true, JSON.stringify(review?.openIssues));
ok('解析出已解决', review?.resolvedIssues?.[0] === '之前没有读回验证');
const notice = agent.injected?.content?.[0]?.text ?? '';
ok('Agent 通知含未结问题清单', notice.includes('还没解决的问题') && notice.includes('界面也改一下'));
ok('Agent 通知不含给用户的话', !notice.includes('没有验收标准'));

/* ── 4.5 受众路由规则（投错自动改投）───────────────────── */
const MISROUTED = `结论: drifting
一句话: 测试
未结问题:
- [新] 范围在扩大
给用户的话:
- [指令] 你的要求没有验收标准
- [改动] 把 config/settings.json 改回去
- 这条没有类别标签
给 Agent 的话:
- [验收] 你该去看 CI 的原始输出
- [证据] 补上测试的原始输出`;

async function parseVerdict(text) {
  const a = mkAgent(events);
  const h = makeHost({ agent: a, progress: { turn: 1, toolCalls: 6, turnStartSeq: 1 }, reviewText: text });
  await h.handlers.get('agent/turn-stopping')({ agent: a, turn: 1, signal: new AbortController().signal });
  await new Promise((r) => setTimeout(r, 400));
  return a.injected?.source?.review;
}
const review2 = await parseVerdict(MISROUTED);
ok('[改动] 出现在给用户段 → 自动改投到给 Agent', review2.forAgent.some((t) => t.includes('config/settings.json')));
ok('[验收] 出现在给 Agent 段 → 自动改投到给用户', review2.forUser.some((t) => t.includes('CI 的原始输出')));
ok('合法类别留在原地', review2.forUser.some((t) => t.includes('[指令]')) && review2.forAgent.some((t) => t.includes('[证据]')));
ok('改投被计数', review2.rerouted === 2, `rerouted=${review2.rerouted}`);
ok('没有类别的条目被计数但不改投', review2.untagged === 1 && review2.forUser.some((t) => t.includes('没有类别标签')), `untagged=${review2.untagged}`);
ok('类别标签保留在文本里（界面能看到）', review2.forUser.filter((t) => !t.includes('没有类别标签')).every((t) => /^\[/.test(t)));

/* ── 5. 防套娃 ─────────────────────────────────────────── */
const child = mkAgent(events);
child.session.header = { id: 'c', origin: 'subagent', parentSession: 's1' };
host2.handlers.get('agent/turn-stopping')({ agent: child, turn: 1, signal: new AbortController().signal });
await new Promise((r) => setTimeout(r, 150));
ok('子 Agent 会话不会被复审（防套娃）', child.injected === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
