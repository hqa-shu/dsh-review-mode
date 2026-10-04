/**
 * 审核模式（审的是**你**，不是 Agent）。
 *
 * 这个入口挂在「审核模式」预设里，做三件事：
 *   1. 收掉所有干活工具 —— 于是它不可能跑去审工作区里的文件（实测踩过这个坑：
 *      让它审一条对话，它去读了桌面的复习笔记）。
 *   2. 给两个专用工具：`list_conversations`（列出能审的对话）与
 *      `review_conversation`（把那条对话的证据取回来）。
 *   3. 证据按「用户是主体、AI 是背景」组织，因为要审的是用户自己有没有跑偏。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** 稳定身份。 */
export const name = 'review-mode-reviewer';

/** 只依赖工具注册表。 */
export const inject = ['tools'];

/** 干活用的工具，在审核模式里全部收掉。 */
const WORK_TOOLS = [
  'write', 'edit', 'notebook_edit', 'multi_edit', 'apply_patch',
  'bash', 'pwsh', 'shell', 'run_code',
  'subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent',
  'workflow', 'ralph', 'present', 'job_kill', 'update_goal', 'terminal_open',
];

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/* ── 用户选中的目标（宿主内共享）────────────────────────────── */

/**
 * 三个方向。放在这个**零依赖**模块里当单一事实来源，`remote.js` 从这里取值。
 */
export const TARGET_KINDS = ['self', 'dsh', 'codex'];

/**
 * 三条**审核线**（用户 2026-10 明确要求：三路都要这样审）：
 *
 * - `me` —— **审我**：主体是「你（用户）说的话」。你说 0 条的对话在这条线上没什么可审的。
 * - `conversation` —— **审对话**：主体是「整条对话（你和 AI 的往返）」。你说 0 条照样能审。
 * - `agent` —— **审 Agent**：主体是「对面 AI 的回答」。你说 0 条照样能审 —— AI 说了话。
 *
 * ⚠️ `lane` 现在的意思变了：它只决定**这次分析的切入点**，不再决定「固定表格的哪一列」。
 * 上一版那张每次不变的 3×3 表格（`REVIEW_TABLE_ROWS` / `REVIEW_TABLE_COLUMNS`）
 * 已被用户推翻（原话：「我感觉有点呆吧」），整块删掉了 —— 判据与提示词现在在
 * `./rubric.js` 一个文件里，形状是「四段锚点 + 条数不固定」。
 */
export const LANES = ['me', 'conversation', 'agent'];

/** lane → 中文名（提示词和界面共用）。 */
export const LANE_LABELS = { me: '审我', conversation: '审对话', agent: '审 Agent' };

// 判据/提示词/解析器都在 `rubric.js`（**唯一改动处**）。这里只是把它转出去，
// 让「预设行只加载 reviewer.js」这条约束不变（`cordis.patch.yml` 的 reviewer 行
// 只 import 这一个文件）。
export {
  ANALYSIS,
  ANALYSIS_RUBRIC,
  ANALYSIS_SECTIONS,
  HEADLINE_LABEL,
  VERDICTS,
  VERDICT_LINE,
  emptyAnalysis,
  fillAnalysis,
  leadingLine,
  normalizeVerdict as normalizeAnalysisVerdict,
  parseAnalysis,
  renderAnalysisFormat,
  renderAnalysisText,
  routeAdvice,
} from './rubric.js';

/**
 * 「以我发问为节点」的边沿判定。
 *
 * 用户的原话：「我那边一旦有了新的这个对话，然后的话呢，以我发问为节点吧，然后你就同步，
 * 然后自动生成一个新的评价」。所以：
 *   - 用户消息数**增加** → 正好触发一次新评价；
 *   - 数没变 → 零次（**不许按定时器重复审**）；
 *   - 第一次看到（prev 未知）：只要他已经说过话（count>0）就审一次，否则什么都不做。
 * @param {number|null|undefined} prev - 上次看到的用户消息数。
 * @param {number} count - 本次看到的用户消息数。
 * @returns {{fire: boolean, count: number}} 是否触发、以及要记下的新计数。
 */
export function nextReviewEdge(prev, count) {
  const current = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (prev === null || prev === undefined || !Number.isFinite(prev)) {
    return { fire: current > 0, count: current };
  }
  return { fire: current > Math.trunc(prev), count: current };
}

/**
 * 用户此刻选中的对话。
 *
 * 谁写：`review_conversation` 工具（原生可点选项那条路），以及面板的远程 `select`。
 * 谁读：`index.js` 的 Codex 监控器 —— 它每次 tick 读 `currentTarget()`，优先审这一条。
 *
 * 为什么放在这里而不是 `remote.js`：预设行加载的是 `reviewer.js`，如果它 import
 * `remote.js`，就会把 `@deepseek-ai/dsh-typert-protocol` 拉进预设行 —— 一旦那个
 * 裸导入解析失败，**整个预设会从模式选择器里消失**（实测踩过）。所以共享状态落在
 * 零依赖的这一侧，`remote.js` 反过来 import 它。
 */
let selected = null;
const ownedTargets = new Map();

/**
 * 读当前选中的目标。
 * @returns {object|null} `{kind, id, title, project, lane, at}` 或 null。
 */
export function currentTarget(ownerId) {
  return ownerId === undefined ? selected : ownedTargets.get(String(ownerId)) ?? null;
}

/**
 * 记下用户选中的对话。传 null 清空；id 为空则保持原样（不把好状态擦掉）。
 * @param {object|null} target - `{kind, id, title?, project?, lane?}`。
 * @returns {object|null} 记录后的目标。
 */
export function setTarget(target) {
  if (target === null) { selected = null; return null; }
  if (typeof target !== 'object') return selected;
  const id = typeof target.id === 'string' ? target.id : '';
  if (id.length === 0) return selected;
  const kind = TARGET_KINDS.includes(target.kind) ? target.kind : 'codex';
  selected = {
    kind,
    id,
    // 没写 lane 就按「审我」——那是这个模式一直以来的默认线。
    lane: LANES.includes(target.lane) ? target.lane : 'me',
    title: typeof target.title === 'string' && target.title.length > 0 ? target.title : id,
    project: typeof target.project === 'string' ? target.project : '',
    at: Date.now(),
    ownerId: typeof target.ownerId==='string' ? target.ownerId : '',
    paused: target.paused===true,
  };
  if(selected.ownerId)ownedTargets.set(selected.ownerId,selected);
  return selected;
}

/* ══════════════════════════════════════════════════════════════════════
 * A 路的派单钩子 —— 宿主管线（`index.js` 的 `runDirectedReview`）在这里被接上
 *
 * **这是修「A 路落点」的关键一处。** 用户现场（2026-10）：
 *   主 Agent 在对话里写评价散文（甚至写「表已落到审核面板」），而面板停在空状态。
 * 真因：`review_conversation` 以前只把证据 render 给主 Agent，让它**自己**填表、自己
 * 写进回复 —— 那条路不经过 `runDirectedReview`，投影一无所知，面板永远不长。
 *
 * 现在工具执行时**同步**把这次复审交给宿主（`index.js` 在 apply 时用
 * `setReviewDispatch()` 注册），结果照旧折进 `reviewMode` 投影、只由面板渲染。
 * 工具回报的是一句**如实**的受理状态（见 `dispatchStatus()`）：
 *   - `started`     —— 已交给宿主复审员，正在生成；面板会长出来；
 *   - `unavailable` —— 宿主管线没接上，**这次没有生成任何评价**，面板上不会有东西；
 *   - `failed`      —— 点火就失败，同样没有生成任何评价。
 * 所以工具结果里**不可能**凭空出现「表已落到面板」这种成功断言。
 *
 * 为什么状态放在这个零依赖模块：预设行（`@local/dsh-review-mode/reviewer`）与
 * `index.js` 加载的是**同一份** `reviewer.js`，`setTarget()` / `currentTarget()`
 * 已经证明这条共享路可用（`test/target-test.mjs`）。
 * ══════════════════════════════════════════════════════════════════════ */

/** 宿主注册的派单函数；未注册时为 null。 */
let reviewDispatch = null;

/**
 * 让宿主注册 A 路的派单入口。传 null / 非函数即摘除（测试用它做反向变异）。
 * @param {function|null} fn - 接收 `{kind,id,lane,title,evidence,agent}`，回 `{status,note}`。
 * @returns {void}
 */
export function setReviewDispatch(fn) {
  reviewDispatch = typeof fn === 'function' ? fn : null;
}

/**
 * 读当前注册的派单入口 —— `index.js` 不需要它，测试用它做「摘掉 → 必须变红」的对照。
 * @returns {function|null} 派单函数或 null。
 */
export function getReviewDispatch() {
  return reviewDispatch;
}

/** 受理状态的三个取值（工具结果、面板与测试共用同一组词）。 */
export const REVIEW_STATUS = { STARTED: 'started', UNAVAILABLE: 'unavailable', FAILED: 'failed' };

/** 受理成功时工具给主 Agent 的那句话 —— 只承诺「正在生成」，绝不承诺「已落到面板」。 */
const STARTED_NOTE = '复审已受理：宿主复审员正在后台生成，结果**只会出现在下面的审核面板**。'
  + '这一轮回复最多一句话（例如「已交给复审员，结果在下面的审核面板」），不要复述证据、不要贴表格。';
/** 宿主管线没接上 —— 必须明说「没有生成、面板上不会有东西」。 */
const UNAVAILABLE_NOTE = '宿主复审管线没有接上，这次**没有生成任何评价**，审核面板上也不会有东西。'
  + '请如实告诉用户这次没审成，不要说结果已经在面板里。';

/**
 * 把一次复审交给宿主。**同步**返回一句如实的受理状态。
 * @param {object} request - `{kind,id,lane,evidence,agent}`。
 * @returns {{status: string, note: string}} 受理状态与给模型看的一句话。
 */
function dispatchReview(request) {
  if (typeof reviewDispatch !== 'function') {
    return { status: REVIEW_STATUS.UNAVAILABLE, note: UNAVAILABLE_NOTE };
  }
  try {
    const outcome = reviewDispatch(request);
    if (outcome === null || typeof outcome !== 'object') {
      return { status: REVIEW_STATUS.STARTED, note: STARTED_NOTE };
    }
    const status = Object.values(REVIEW_STATUS).includes(outcome.status)
      ? outcome.status : REVIEW_STATUS.STARTED;
    return { status, note: oneLine(String(outcome.note ?? STARTED_NOTE)) };
  } catch (error) {
    const why = oneLine(String(error?.message ?? error)).slice(0, 120);
    return {
      status: REVIEW_STATUS.FAILED,
      note: `复审没能启动（${why || '未知错误'}）：这次**没有生成任何评价**，面板上也不会有东西。请如实告诉用户。`,
    };
  }
}

/**
 * 逐帧解压拼接的 zstd 日志（DSH 会话日志是这种格式）。
 * @param {string} file - 文件路径。
 * @returns {string} 解压后的文本。
 */
function decompressLog(file) {
  const raw = fs.readFileSync(file);
  const offsets = [];
  let idx = raw.indexOf(MAGIC, 0);
  while (idx !== -1) { offsets.push(idx); idx = raw.indexOf(MAGIC, idx + 4); }
  const parts = [];
  let i = 0;
  while (i < offsets.length) {
    let advanced = false;
    for (let j = i + 1; j <= offsets.length && !advanced; j += 1) {
      const end = j < offsets.length ? offsets[j] : raw.length;
      try { parts.push(zlib.zstdDecompressSync(raw.subarray(offsets[i], end))); i = j; advanced = true; } catch { /* 假 magic */ }
    }
    if (!advanced) i += 1;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 一行化。 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 截断。 */
function clip(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** 取内容块里的文本（兼容小写 text / Codex 的 Text / input_text）。 */
function contentText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b !== null && typeof b === 'object' && typeof b.text === 'string'
      && String(b.type).toLowerCase().endsWith('text'))
    .map((b) => b.text).join('\n').trim();
}

/* ── DSH 会话 ─────────────────────────────────────────────── */

/**
 * 找一个 DSH 会话的日志文件。
 * @param {string} id - 会话 id。
 * @returns {string|null} 日志路径。
 */
function dshLogFile(id) {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    const target = path.join(root, dir, `session-${id}`);
    if (!fs.existsSync(target)) continue;
    const file = fs.readdirSync(target).find((n) => n.startsWith('session.v') && n.endsWith('.jsonl.zstd'));
    if (file !== undefined) return path.join(target, file);
  }
  return null;
}

/**
 * 列出 DSH 会话。
 * @param {number} keep - 最多几条。
 * @returns {object[]} 会话条目。
 */
function listDshSessions(keep) {
  // 根路径来自一次探查并写进缓存文件；这里只按记录的位置去读。
  const root = discoverRoots().dshSessions.path;
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const dir of dirs) {
    const sub = path.join(root, dir);
    let entries;
    try { entries = fs.readdirSync(sub); } catch { continue; }
    for (const entry of entries) {
      if (!entry.startsWith('session-')) continue;
      const target = path.join(sub, entry);
      const file = (() => { try { return fs.readdirSync(target).find((n) => n.startsWith('session.v') && n.endsWith('.jsonl.zstd')); } catch { return undefined; } })();
      if (file === undefined) continue;
      const full = path.join(target, file);
      out.push({ kind: 'dsh', id: entry.replace('session-', ''), file: full, mtime: fs.statSync(full).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, keep);
}

/**
 * 读一个 DSH 会话，抽标题与用户说过的话。
 *
 * 和 `readCodex` 同一个纪律：**条数用显式计数，不用可能被截断的数组长度**。
 * DSH 这条路目前不截断 `asks`/`said`，所以两个数相等；但把它写成 `askCount`
 * 是为了「以后谁在这里加截断，曲线就不会跟着骗人」——
 * Codex 那条路就正是被 `asks.slice(-20)` + `asks.length` 坑过一次（见 bug 17）。
 * @param {object} entry - 列表条目。
 * @returns {object} 摘要。
 */
function readDsh(entry) {
  const events = decompressLog(entry.file)
    .split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const title = events.find((e) => e.type === 'session/title')?.data?.title ?? '(无标题)';
  const asks = [];
  const said = [];
  let turn = 0;
  let calls = 0;
  const cwd = events.find((e) => e.type === 'session')?.data?.header?.cwd
    ?? events.find((e) => e.type === 'session')?.data?.cwd ?? '';
  for (const e of events) {
    if (e.type === 'turn/start') turn = e.data.turn;
    if (e.type === 'tool/call') calls += 1;
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
      const text = oneLine(contentText(e.data.content));
      if (text.length > 0) asks.push({ turn, text });
    }
    // 「对面 AI 说了几条」——「审对话」那条线的主体。工具调用不算「话」。
    if (e.type === 'assistant/message') {
      const text = oneLine(contentText(e.data.message?.content ?? e.data.content));
      if (text.length > 0) said.push({ turn, text });
    }
  }
  // 计数用显式字段，别用可能被截断的 `asks.length`（Codex 那边踩过，见 bug 17）。
  return { title, asks, said, askCount: asks.length, otherCount: said.length, calls, turns: turn, cwd };
}

/* ── Codex：用 Codex 自己的名字 ─────────────────────────────── */

/* ── 探查缓存：把「东西在哪里」一次写死 ─────────────────────── */

/** 缓存目录。用户明确要求把探查结果记到固定位置，不用每次重新找。 */
export const CACHE_DIR = path.join(os.homedir(), '.dsh', 'review-mode');

/** 单一 JSON 缓存文件：roots（字面绝对路径 + mtime）与两个 Codex 索引的解析结果。 */
export const CACHE_FILE = path.join(CACHE_DIR, 'probe-cache.json');

/** 缓存格式版本；字段变了就 +1，旧文件自动作废。 */
const CACHE_VERSION = 1;

/** 进程内缓存（内存命中连缓存文件都不读）。`resetProbeCache()` 只给测试用。 */
let probeMemory = null;

/**
 * 与 `index.js` 的 `trace()` 写同一个文件、同一形状 —— 缓存命中/未命中都留一行，
 * 现场看不见的时候这是唯一能查的东西。
 * @param {object} line - 要记录的一行。
 */
function trace(line) {
  try {
    fs.appendFileSync('/tmp/dsh-review-watch.jsonl', `${JSON.stringify({
      at: new Date().toISOString(),
      electron: typeof process.versions.electron === 'string',
      ...line,
    })}\n`);
  } catch { /* 写不了就算了 */ }
}

/**
 * stat 一个路径；不存在也是一种**发现结果**，所以失败也返回形状完整的记录。
 * @param {string} file - 绝对路径。
 * @returns {object} `{path, exists, mtimeMs, size}`。
 */
function statSafe(file) {
  try {
    const info = fs.statSync(file);
    return { path: file, exists: true, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return { path: file, exists: false, mtimeMs: 0, size: 0 };
  }
}

/**
 * 发现所有要用的根 —— 全是**字面绝对路径**，会被写进缓存文件。
 * 于是「究竟在哪里找到的」永久留在盘上，而不是靠每次重新猜。
 * @returns {object} 根名 → `{path, exists, mtimeMs, size}`。
 */
export function discoverRoots() {
  const home = os.homedir();
  return {
    codexSessions: statSafe(path.join(home, '.codex', 'sessions')),
    codexArchived: statSafe(path.join(home, '.codex', 'archived_sessions')),
    codexIndexFile: statSafe(path.join(home, '.codex', 'session_index.jsonl')),
    codexGlobalState: statSafe(path.join(home, '.codex', '.codex-global-state.json')),
    dshSessions: statSafe(path.join(home, '.dsh', 'sessions')),
  };
}

/**
 * 把根列表压成一行签名，同时写进缓存。人一眼能看出缓存是按什么记账的。
 * @param {object} roots - {@link discoverRoots} 的结果。
 * @returns {string} 签名。
 */
export function rootsSignature(roots) {
  return Object.entries(roots)
    .map(([key, info]) => `${key}=${info.path}|${info.exists ? 1 : 0}|${Math.round(info.mtimeMs)}|${info.size}`)
    .join('\n');
}

/**
 * **按 root 失效**：任一根的路径 / 是否存在 / mtime / 大小变了，就判定缓存作废。
 * 一个目录动了不会连累另一边的索引。
 * @param {object|null} cached - 缓存文件内容（或内存缓存对象）。
 * @param {object} roots - 本次实测的根。
 * @returns {boolean} 是否仍然可用。
 */
function cacheValid(cached, roots) {
  if (cached === null || typeof cached !== 'object') return false;
  if (cached.version !== CACHE_VERSION) return false;
  const stored = cached.roots;
  if (stored === null || typeof stored !== 'object') return false;
  for (const [key, info] of Object.entries(roots)) {
    const old = stored[key];
    if (old === undefined || typeof old !== 'object') return false;
    if (old.path !== info.path) return false;
    if (Boolean(old.exists) !== info.exists) return false;
    if (Math.round(Number(old.mtimeMs) || 0) !== Math.round(info.mtimeMs)) return false;
    if ((Number(old.size) || 0) !== info.size) return false;
  }
  return true;
}

/** 读缓存文件；没有或坏了都返回 null（退回慢路径，绝不抛）。 */
function readCacheFile() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

/**
 * 原子写：先写临时文件再 rename。崩溃最坏留下一个 .tmp，
 * 永远不会出现半截 cache.json（那会让之后每次列目录都解析失败）。
 * @param {object} payload - 要写的对象。
 * @returns {boolean} 是否写成功。
 */
function writeCacheFile(payload) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, CACHE_FILE);
    return true;
  } catch {
    return false;
  }
}

/** 清掉进程内缓存（测试用；真跑不需要）。 */
export function resetProbeCache() {
  probeMemory = null;
}

/**
 * 两个源一起读并解析 —— 只有缓存未命中才会走到这里。
 *
 * Codex 把「项目名 / 对话标题」存在：
 *   ~/.codex/session_index.jsonl        { id, thread_name, updated_at }
 *   ~/.codex/.codex-global-state.json   local-projects[项目id].name
 *                                       thread-project-assignments[线程id].projectId
 * @returns {{titleOf: Map<string,string>, projectOf: Map<string,string>}} 两个索引。
 */
function readCodexIndexUncached() {
  const titleOf = new Map();
  const projectOf = new Map();
  const home = os.homedir();
  // 对话标题
  try {
    for (const line of fs.readFileSync(path.join(home, '.codex', 'session_index.jsonl'), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record?.id === 'string' && typeof record.thread_name === 'string') {
          titleOf.set(record.id, oneLine(record.thread_name));
        }
      } catch { /* 单行坏了就跳过 */ }
    }
  } catch { /* 没有这个文件就只靠项目名 */ }
  // 项目名（线程 → 项目 → 名字）
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.codex', '.codex-global-state.json'), 'utf8'));
    const projects = state['local-projects'] ?? {};
    const assignments = state['thread-project-assignments'] ?? {};
    for (const [threadId, assignment] of Object.entries(assignments)) {
      const projectId = typeof assignment === 'string' ? assignment : assignment?.projectId;
      const name = projects[projectId]?.name;
      if (typeof name === 'string' && name.length > 0) projectOf.set(threadId, name);
    }
  } catch { /* 同上 */ }
  return { titleOf, projectOf };
}

/**
 * 读 Codex 的两个索引（对话标题 + 项目名），**带探查缓存**。
 *
 * 用户的原话：「设置一次探查，然后…就把目录的这个数据…至少把连接给写死了…
 * 记录就能记录到究竟在哪里可以找到，就省下很多时间」。
 *
 * 所以：第一次（未命中）读两个源文件，把 roots（字面绝对路径 + mtime）与解析结果
 * 一起写进 {@link CACHE_FILE}；之后每次都命中缓存，只 stat 几个根做失效检查。
 * 每个 root 单独记账 —— 改了哪一个，就只让哪一个失效。
 * @returns {{titleOf: Map<string,string>, projectOf: Map<string,string>}} 两个索引。
 */
export function readCodexIndex() {
  const startedAt = Date.now();
  const roots = discoverRoots();
  const where = Object.fromEntries(
    Object.entries(roots).map(([key, info]) => [key, info.exists ? info.path : `${info.path}（不存在）`]),
  );

  // ① 进程内命中：连缓存文件都不读。
  if (cacheValid(probeMemory, roots)) {
    trace({ cache: 'hit', what: 'codexIndex', from: 'memory', ms: Date.now() - startedAt, file: CACHE_FILE });
    return probeMemory.index;
  }

  // ② 缓存文件命中：只读一个小 JSON。
  const cached = readCacheFile();
  if (cacheValid(cached, roots)
    && cached.codexIndex !== null && typeof cached.codexIndex === 'object') {
    const index = {
      titleOf: new Map(Object.entries(cached.codexIndex.titleOf ?? {})),
      projectOf: new Map(Object.entries(cached.codexIndex.projectOf ?? {})),
    };
    probeMemory = { version: CACHE_VERSION, roots, index };
    trace({
      cache: 'hit', what: 'codexIndex', from: 'file', ms: Date.now() - startedAt, file: CACHE_FILE,
      savedAt: cached.at ?? null, titles: index.titleOf.size, projects: index.projectOf.size,
    });
    return index;
  }

  // ③ 未命中：真读一次，然后把结果写死到盘上。
  const index = readCodexIndexUncached();
  const payload = {
    version: CACHE_VERSION,
    at: new Date().toISOString(),
    signature: rootsSignature(roots),
    roots,
    where,
    found: {
      sessionIndex: roots.codexIndexFile.path,
      globalState: roots.codexGlobalState.path,
      codexSessions: roots.codexSessions.path,
      codexArchived: roots.codexArchived.path,
      dshSessions: roots.dshSessions.path,
    },
    codexIndex: {
      titleOf: Object.fromEntries(index.titleOf),
      projectOf: Object.fromEntries(index.projectOf),
    },
  };
  probeMemory = { version: CACHE_VERSION, roots, index };
  const written = writeCacheFile(payload);
  trace({
    cache: 'miss', what: 'codexIndex', ms: Date.now() - startedAt, file: CACHE_FILE, written,
    titles: index.titleOf.size, projects: index.projectOf.size, roots: where,
  });
  return index;
}

/** 从 rollout 文件名里抠出线程 id：第一段 uuid 才是线程，下划线后面的是续写 id。 */
function codexThreadId(fileName) {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(fileName);
  return match === null ? '' : match[1];
}

/* ── Codex ────────────────────────────────────────────────── */

/**
 * 列出 Codex 的 rollout —— **一个线程 id = 一条对话**。
 *
 * Codex 会把同一条对话拆成多个 `rollout-*.jsonl`（文件名第一段 uuid 相同，
 * 下划线后面是续写 id）。实测 `~/.codex`：thread `01a0decf-…` 有 7 个文件、
 * `01a0e19e-…` 5 个、`01a0ec83-…` 4 个、`01a0ecce-…` 3 个；67 个 rollout 文件。
 * 按文件列，用户会在目录里看到同一条对话的三份，直接问「同样一个你会问两条呢？……我不懂」。
 *
 * 所以这里先按线程分组，再还原成**一行一条对话**：
 *   - `files` 是这条对话的全部 rollout（旧的在前），读正文时按这个顺序相加；
 *   - `id` / `file` / `mtime` 取**最新那个文件** —— 交给 `review_conversation` /
 *     证据 / 监控器的就是它；
 *   - `keep` 限的是**对话条数**，不是文件数。
 * @param {number} keep - 最多几条对话。
 * @returns {object[]} 条目（每个线程一条）。
 */
function listCodex(keep) {
  const byThread = new Map();
  // 根路径来自探查缓存记录的位置（字面绝对路径），不再每次自己拼。
  const roots = discoverRoots();
  const walk = (root) => {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const id = entry.name.replace('rollout-', '').replace('.jsonl', '');
        const threadId = codexThreadId(entry.name);
        // 文件名里没有 uuid 就退回文件 id —— 至少不会把两条不相干的并起来。
        const groupKey = threadId.length > 0 ? threadId : id;
        const record = { kind: 'codex', id, threadId, file: full, mtime: fs.statSync(full).mtimeMs };
        const bucket = byThread.get(groupKey);
        if (bucket === undefined) byThread.set(groupKey, [record]);
        else bucket.push(record);
      } catch { /* 跳过 */ }
    }
  };
  walk(roots.codexSessions.path);
  walk(roots.codexArchived.path);

  const merged = [];
  for (const files of byThread.values()) {
    files.sort((a, b) => a.mtime - b.mtime);      // 旧 → 新，读正文时按这个顺序拼
    const newest = files[files.length - 1];
    merged.push({ kind: 'codex', id: newest.id, threadId: newest.threadId, file: newest.file, mtime: newest.mtime, files });
  }
  return merged.sort((a, b) => b.mtime - a.mtime).slice(0, keep);
}

/**
 * 一条 Codex 条目背后的**全部 rollout 文件**（旧 → 新）。
 *
 * 兼容两种形状：合并后的条目（带 `files`）与合成的单文件条目
 * （`index.js` 监控器 tick 里的老形状：`{id, file, threadId}`）。
 * @param {object} entry - 列表条目。
 * @returns {object[]} `{id, file, mtime}` 数组，至少一项。
 */
function codexFiles(entry) {
  if (Array.isArray(entry?.files) && entry.files.length > 0) return entry.files;
  return [{ id: entry?.id ?? '', file: entry.file, mtime: entry.mtime ?? 0 }];
}

/** Codex 注入的噪声前缀。 */
const CODEX_NOISE = ['<environment_context', '<external_codex_apps', '<user_instructions',
  '>>> RETAINED', '>>> TRANSCRIPT', 'Host notice:', 'Retained source order:',
  'The following is the Codex agent history'];

/**
 * 读一条 Codex 对话：用户说了什么（主体）+ Codex 干了什么（背景）。
 *
 * **必须读这条对话的全部 rollout 文件再相加** —— 一条对话被 Codex 拆成几份时，
 * 只读最新那份会把「你说 9 条」报成「你说 4 条」，用户看到的就是错的规模。
 * @param {object} entry - 列表条目（合并后的，或单文件的合成条目）。
 * @returns {object} 摘要。
 */
function readCodex(entry) {
  const files = codexFiles(entry);
  const asks = [];
  const did = [];
  const said = [];
  let cwd = '';
  for (const file of files) {                       // 旧 → 新
    let raw;
    try { raw = fs.readFileSync(file.file); } catch { continue; }
    const head = raw.subarray(0, Math.min(raw.length, 524288)).toString('utf8').split('\n')[0];
    if (cwd.length === 0) {
      const cwdMatch = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
      cwd = cwdMatch?.[1] ?? '';
    }
    const tail = raw.subarray(Math.max(0, raw.length - 524288)).toString('utf8');
    const lines = tail.slice(tail.indexOf('\n') + 1).split('\n').filter((l) => l.trim());
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const p = rec?.payload;
      if (rec?.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
        const text = oneLine(contentText(p.content));
        if (text.length > 0 && !CODEX_NOISE.some((n) => text.startsWith(n)) && !/^\[\d+\]\s+(user|assistant):/.test(text)) {
          asks.push({ turn: 0, text: clip(text, 300) });
        }
      } else if (rec?.type === 'event_msg') {
        const item = p?.item;
        if (item?.type === 'CommandExecution') {
          const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
          if (cmd.trim().length > 0) did.push(`命令 ${clip(oneLine(cmd), 110)}`);
        } else if (item?.type === 'AgentMessage') {
          const text = oneLine(contentText(item.content));
          if (text.length > 0) {
            did.push(`它说 ${clip(text, 160)}`);
            // 「对面 AI 说了几条」——「审对话」那条线的主体，和 did（动作背景）分开存。
            said.push({ turn: 0, text: clip(text, 300) });
          }
        } else if (item?.type === 'McpToolCall' && (item.status === 'failed' || item.result?.isError === true)) {
          did.push(`工具失败 ${item.server ?? '?'}/${item.tool ?? '?'}`);
        }
      }
    }
  }
  const index = entry._index ?? readCodexIndex();
  const threadId = entry.threadId ?? codexThreadId(entry.file ?? '');
  const project = index.projectOf.get(threadId) ?? '';
  const heading = index.titleOf.get(threadId) ?? '';
  const fallback = path.basename(cwd) || String(entry.id ?? '').slice(0, 12);
  return {
    // 和 Codex 侧边栏一致：「项目名 / 对话标题」。两个都没有才退回文件夹名。
    title: project.length > 0 && heading.length > 0 ? `${project} / ${heading}`
      : (project || heading || fallback),
    cwd,
    asks: asks.slice(-20),
    // 证据里的原话只留最近 20 条（digest 预算），但**条数必须是真的** ——
    // 拿 asks.length 当条数会把它悄悄截成 20（实测有一条 23 条的会被报成 20）。
    askCount: asks.length,
    said: said.slice(-20),
    otherCount: said.length,
    did: did.slice(-14),
    turns: 0,
  };
}

/**
 * 候选的 label：**「项目 / 标题 · 你说 N 条 · 对面 M 条」**。
 *
 * 用户的原话：「目录应该是比如说你直接跳出来什么 5005试卷、5005细节问答，然后试卷他后面
 * 可能标一个多少条记录」。两个条数都要给，因为用户后来把这条线分成了两条：
 * 「审我」看你说的话，「审对话」看对面 AI 的回答 —— 只说一个数，用户没法判断哪条能用。
 * 「你最后说的那句」不放这里，它是好上下文但当 label 会让人认不出来
 * （用户原话：「你为什么跳出来的这么奇怪啊」）。
 * @param {string} title - 「项目 / 标题」。
 * @param {number} userCount - 这条对话里用户说了几条。
 * @param {number} otherCount - 对面 AI 说了几条。
 * @returns {string} 形如 `5005复习 / 试卷 · 你说 4 条 · 对面 12 条`。
 */
export function candidateLabel(title, userCount, otherCount) {
  const name = clip(oneLine(title), 48) || '(无标题)';
  return `${name} · 你说 ${userCount} 条 · 对面 ${otherCount} 条`;
}

/* ── 工具 ─────────────────────────────────────────────────── */

/**
 * 一次最多扫几条目录。
 *
 * 这只是**防呆**（别让一个坏目录把内存吃光），不是给用户看的条数上限：
 * 默认返回就是扫到的全量。实测 65 个 rollout 全读一遍只要约 100ms。
 */
const SCAN_LIMIT = 1000;

/** `list_conversations` 的默认返回条数 = 全量（用户有 40+ 条，只给 8 条等于让他看不见大半）。 */
const DEFAULT_LIST_LIMIT = SCAN_LIMIT;

/**
 * 把一条对话压成候选行 —— 两条数据源共用同一个形状，
 * 这样 label / 两个条数 / lastSaid 不会在两个分支里各写一份而漂移。
 * @param {object} input - 条目与已抽好的字段。
 * @returns {object} 候选行（带内部 `_mtime`，返回前会剥掉）。
 */
function candidateRow({ entry, kind, title, userMessages, otherMessages, lastSaid, hint }) {
  return {
    id: entry.id,
    kind,
    title,
    label: candidateLabel(title, userMessages, otherMessages),
    when: new Date(entry.mtime).toISOString().slice(5, 16),
    userMessages,
    otherMessages,
    lastSaid: clip(lastSaid, 70),
    hint: clip(hint, 70) || '(读不到内容)',
    _mtime: entry.mtime,
  };
}

/**
 * 安装审核模式的两个工具，并收掉干活工具。
 * @param {object} ctx - 预设作用域的插件上下文。
 */
export function apply(ctx) {
  // 收掉干活工具，双保险。
  //
  // **必须容错。** `tools.restrict()` 要求「有作用域的上下文」，而预设是「共享激活一次」
  // 的，没有 agent 作用域时它会直接抛错 —— 那个错会让整个预设声明注册失败，
  // 于是预设从模式选择器里**整个消失**（实测踩过：选择器里只剩 4 个内置模式）。
  // 其实这个预设根本没挂 tool-fs / tool-bash，所以这一层只是保险，失败绝不该外抛。
  try {
    ctx.effect(() => ctx.tools.restrict({ deny: WORK_TOOLS }), 'reviewer.restrict()');
  } catch (error) {
    ctx.logger?.warn?.(`review-mode: 收工具失败，审核功能不受影响：${error instanceof Error ? error.message : String(error)}`);
  }

  ctx.tools.register({
    name: 'list_conversations',
    description: '列出可以被审核的对话。**入口是面板那三个方块**；只有当用户用文字点名要审某条对话时，'
      + '才用它把候选找出来，随后调 `review_conversation` 把复审交给宿主（结果只落在面板）。'
      + 'kind=codex 是用户在 ChatGPT 桌面版/Codex 里的对话；kind=dsh 是 DSH 自己的会话。'
      + 'lane=me（默认，「审我」）会跳过「你一句话都没说」的对话并把跳过几条报出来；'
      + 'lane=conversation（「审对话」）与 lane=agent（「审 Agent」）不跳过 —— 你没说话时，整条对话和对面 AI 的回答照样可以审。'
      + '每条给 label（「项目 / 标题 · 你说 N 条 · 对面 M 条」）与 lastSaid（你最后说的那句原话）。',
    // `parameters` 必须是**编译后的 JSON Schema**（`type: 'object'` 打头）。
    // 官方工具写的是「属性表」形式，但那是 `defineTool()` 的入参 —— 它会调
    // parameterSchemaSpecToJsonSchema() 转一次。我们绕过了 defineTool，所以自己给最终形态。
    // 写成属性表的话，提供商收到的是 `type: null`，工具直接调用失败。
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'all（默认）/ codex / dsh' },
        lane: { type: 'string', description: 'me（默认，「审我」）/ conversation（「审对话」：整条往返）/ agent（「审 Agent」：对面 AI 的回答）' },
        limit: { type: 'number', description: `返回几条，默认 ${DEFAULT_LIST_LIMIT}（≈全量，最多 ${SCAN_LIMIT}）` },
      },
    },
    output: {
      // 注意：`output.schema` 用的是标准 JSON Schema —— `required` 是**数组**，放在
      // object 这一层。写成工具 parameters 那种「每个属性上 required: true」会被判
      // 「unsupported JSON schema」，工具注册失败，**整个预设声明跟着 broken**。
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['lane', 'conversations', 'total', 'matching', 'excluded', 'excludedNote'],
        properties: {
          lane: { type: 'string' },
          conversations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'kind', 'title', 'label', 'when', 'userMessages', 'otherMessages', 'lastSaid', 'hint'],
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' },
                title: { type: 'string' },
                label: { type: 'string' },
                when: { type: 'string' },
                userMessages: { type: 'integer' },
                otherMessages: { type: 'integer' },
                lastSaid: { type: 'string' },
                hint: { type: 'string' },
              },
            },
          },
          total: { type: 'integer' },
          matching: { type: 'integer' },
          excluded: { type: 'integer' },
          excludedNote: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const laneName = value.lane === 'conversation' ? '审对话' : '审我';
        const lines = value.conversations.map((c) => [
          `label: ${c.label}`,
          `description 用: ${c.kind} · ${c.when} · 你最后说：${c.lastSaid || '（这条你一句话都没说）'}`,
          `id: ${c.id}`,
        ].join('\n    '));
        const notes = [];
        if (value.excludedNote.length > 0) notes.push(value.excludedNote);
        if (value.excluded > 0) {
          notes.push('提示：要连这些你没说话的也一起看（走「审对话」这条线），再调一次 '
            + 'list_conversations({lane:"conversation"})。');
        }
        return [{
          type: 'text',
          text: [
            `共 ${value.total} 条 · 「${laneName}」这条线可用 ${value.matching} 条 · 本次给出 ${value.conversations.length} 条`,
            ...notes,
            '',
            lines.length === 0 ? '没有找到可审的对话。' : lines.join('\n'),
          ].join('\n'),
        }];
      },
    },
    execute(args) {
      const want = args.kind ?? 'all';
      // 两条审核线：me = 审你；conversation = 审对面 AI 的回答。
      const lane = LANES.includes(args.lane) ? args.lane : 'me';
      const limit = Number.isFinite(args.limit) && args.limit > 0
        ? Math.trunc(args.limit)
        : DEFAULT_LIST_LIMIT;
      // **先扫全量 → 再按 lane 过滤 → 最后才按 limit 切。** 顺序反了有两个后果：
      // ① 「跳过几条」只统计到窗口里那几条（数字骗人）；② 「审我」这条线上
      // 窗口里恰好全是「你说了 0 条」的对话时，返回一个空列表。
      const pool = [];
      // 探查缓存只读一次、给这一批全部复用（每个 rollout 都要「项目名 / 标题」）。
      const index = readCodexIndex();
      if (want !== 'dsh') {
        for (const entry of listCodex(SCAN_LIMIT)) {
          const read = readCodex({ ...entry, _index: index });
          const lastSaid = read.asks[read.asks.length - 1]?.text ?? '';
          const lastAction = read.did[read.did.length - 1] ?? '';
          pool.push(candidateRow({ entry, kind: 'codex', title: read.title,
            userMessages: read.askCount, otherMessages: read.otherCount,
            lastSaid, hint: lastSaid || lastAction }));
        }
      }
      if (want !== 'codex') {
        for (const entry of listDshSessions(SCAN_LIMIT)) {
          const read = readDsh(entry);
          const lastSaid = read.asks[read.asks.length - 1]?.text ?? '';
          pool.push(candidateRow({ entry, kind: 'dsh', title: read.title,
            userMessages: read.askCount, otherMessages: read.otherCount,
            lastSaid, hint: lastSaid }));
        }
      }
      const total = pool.length;
      // 排序：**有你说话的排前面**，同类里最近的在最上面。
      pool.sort((a, b) => (Number(b.userMessages > 0) - Number(a.userMessages > 0))
        || (b._mtime - a._mtime));
      // 「审我」这条线：你说 0 条 = 没什么可审的。**只在这条线排除，不全局隐藏** ——
      // 「审对话」那条线里它们照样是候选，因为对面 AI 说过话。
      const usable = lane === 'me' ? pool.filter((row) => row.userMessages > 0) : pool;
      const excluded = total - usable.length;
      const excludedNote = lane === 'me' && excluded > 0
        ? `另有 ${excluded} 组你说 0 句的对话在「审我」这条线上跳过——没有你的话就没什么可审的；它们仍可以在「审对话」那条线上审。`
        : '';
      return {
        lane,
        conversations: usable.slice(0, limit).map(({ _mtime, ...rest }) => rest),
        total,
        matching: usable.length,
        excluded,
        excludedNote,
      };
    },
  });

  ctx.tools.register({
    name: 'review_conversation',
    description: '把一条对话交给**宿主复审员**复审。复审由宿主的独立子 Agent 完成，'
      + '结论只出现在下面的**审核面板**；你这一轮的回复最多一句话（例如「已交给复审员，结果在下面的审核面板」），'
      + '不要复述证据、不要贴表格。工具结果会如实告诉你这次有没有受理成功。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'list_conversations 给出的 id' },
        kind: { type: 'string', description: 'codex 或 dsh' },
        lane: { type: 'string', description: 'me（默认，「审我」）/ conversation（「审对话」：整条往返）/ agent（「审 Agent」：对面 AI 的回答）' },
      },
      required: ['id', 'kind'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['lane', 'title', 'youSaid', 'otherSaid', 'background', 'stats', 'reviewStatus', 'reviewNote'],
        properties: {
          lane: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          youSaid: { type: 'array', items: { type: 'string' } },
          otherSaid: { type: 'array', items: { type: 'string' } },
          background: { type: 'array', items: { type: 'string' } },
          stats: { type: 'string' },
          // 这次复审**真的**被受理了吗？三个取值见 REVIEW_STATUS。
          reviewStatus: { type: 'string' },
          // 给模型看的一句如实说明（受理成功 / 没接上 / 启动失败）。
          reviewNote: { type: 'string' },
        },
      },
      /**
       * 模型真正读到的东西（`dsh-tools` 把 render 的内容放进 `tool/result` 的
       * `content`；结构化 `value` 只给宿主与测试合）。
       *
       * **这里必须是一句回执，不是证据，也不是表格。** 以前 render 把整份证据 +
       * 「输出格式」+ 空表格倒给主 Agent，等于请它自己填表再写进回复 —— 用户看到
       * 的正是「评价长在对话里、面板空着」。复审现在是宿主的事，主 Agent 只需要
       * 一句能对用户说的话。
       * @param {object} _args - 工具入参（这里用不到）。
       * @param {object} value - 工具返回值。
       * @returns {object[]} 一段文本。
       */
      render: (_args, value) => {
        const status = Object.values(REVIEW_STATUS).includes(value.reviewStatus)
          ? value.reviewStatus : REVIEW_STATUS.UNAVAILABLE;
        const head = status === REVIEW_STATUS.STARTED
          ? '审核已受理（复审员正在后台生成，结果只落在审核面板）'
          : (status === REVIEW_STATUS.FAILED ? '审核未受理（复审没能启动）' : '审核未受理（宿主管线不可用）');
        const lane = LANES.includes(value.lane) ? value.lane : 'me';
        return [{
          type: 'text',
          text: [
            `${head}：${value.title}`,
            `这条线：${LANE_LABELS[lane] ?? '审我'} · 规模：${value.stats}`,
            '',
            value.reviewNote,
            '',
            '（不要在本轮回复里复现证据或表格 —— 用户要看的结论只在下面的审核面板。）',
          ].join('\n'),
        }];
      },
    },
    /**
     * 取证 → 记目标 → **把这次复审交给宿主管线**。第二个参数是工具的 exec
     * （`dsh-tools` 的 `execute(args, exec)`），`exec.agent` 就是发起这次调用的
     * 审核会话；有了它，宿主不需要猜是哪条会话。
     * @param {object} args - `{id, kind, lane}`。
     * @param {object} [exec] - 工具执行上下文（含 `agent`）。
     * @returns {object} 证据 + 受理状态（形状见 output.schema）。
     */
    execute(args, exec) {
      const kind = String(args.kind ?? '');
      const id = String(args.id ?? '');
      const lane = LANES.includes(args.lane) ? args.lane : 'me';
      const evidence = conversationEvidence(kind, id, lane);
      // **B. 宿主工具记下用户选的那条。** index.js 的 Codex 监控器每次 tick 读
      // `currentTarget()`，所以用户走原生可点选项选了哪条、走了哪条线，监控器下次就审哪条。
      try { setTarget({ kind, id, title: evidence?.title ?? id, lane }); } catch { /* 记录失败不影响取证 */ }
      // **A. 这次复审交给宿主**（与面板按钮、监控器同一条 `runDirectedReview` 管线）。
      // 证据已经取好了，一起递过去，宿主不必再读一遍盘。
      const outcome = dispatchReview({
        kind,
        id,
        lane,
        title: String(evidence?.title ?? id),
        evidence,
        agent: exec?.agent,
      });
      return { ...evidence, reviewStatus: outcome.status, reviewNote: outcome.note };
    },
  });
}

// 给 `bridge.js` 复用：面板要展示候选目录、要立刻拿到「问」那一栏的证据，
// 用的是同一套读盘逻辑。只加具名导出，不改这个模块作为插件的行为
// （Loader 仍然只看 name/inject/apply）。
// `readCodexIndex` / `setTarget` / `currentTarget` / `discoverRoots` 在定义处直接
// export，这里不重复列出（重复导出会让整个模块语法错误）。
export {
  listCodex,
  listDshSessions,
  readCodex,
  readDsh,
  codexThreadId,
  oneLine,
  clip,
};


/**
 * 一条对话的完整证据（`review_conversation` 工具和面板状态 3 共用，
 * 避免两份逻辑漂移）。
 *
 * `lane` 决定「谁是主体」：`me` = 用户说的话是主体；`conversation` = 对面 AI 的回答是主体。
 * 两种材料都返回（youSaid / otherSaid），只是 render 时的顺序和标题不同 —— 两份结论格式
 * 在 persona 与 `index.js` 里分开，这里只负责把材料备齐。
 * @param {string} kind - `codex` 或 `dsh`。
 * @param {string} id - 对话 id。
 * @param {string} [lane] - `me`（默认）或 `conversation`。
 * @returns {object} `{lane, title, cwd, youSaid, otherSaid, background, stats}`。
 */
export function conversationEvidence(kind, id, lane = 'me') {
  const wantLane = LANES.includes(lane) ? lane : 'me';
  if (kind === 'codex') {
    // 用和 `list_conversations` 同一个扫描范围找 —— 之前这里是 60、候选默认只列 8，
    // 表面上一致；一旦候选给全量，60 就会出现「列表里有、点进去却找不到」。
    // 一条对话 = 一个线程，所以除了「最新文件的 id」，**线程 id 与更旧文件的 id
    // 也都要认得**：用户早先点选的那条、旧 checkpoint 里记的 id 不能因为合并就失灵。
    const entry = listCodex(SCAN_LIMIT).find((c) => c.id === id
      || c.threadId === id
      || (Array.isArray(c.files) && c.files.some((file) => file.id === id)));
    if (entry === undefined) throw new Error(`找不到那条 Codex 对话：${id}`);
    const read = readCodex(entry);
    return {
      lane: wantLane,
      title: read.title,
      cwd: read.cwd,
      youSaid: read.asks.map((a) => a.text),
      otherSaid: read.said.map((a) => a.text),
      background: read.did,
      stats: `你说 ${read.askCount} 条${read.askCount > read.asks.length ? `（证据里列出最近 ${read.asks.length} 条）` : ''}`
        + ` · 对面 ${read.otherCount} 条${read.otherCount > read.said.length ? `（列出最近 ${read.said.length} 条）` : ''}`
        + ` · 对面 ${read.did.length} 个动作 · 最后活动 ${new Date(entry.mtime).toISOString().slice(5, 16)}`,
    };
  }
  const entry = listDshSessions(SCAN_LIMIT).find((c) => c.id === id);
  if (entry === undefined) throw new Error(`找不到那个 DSH 会话：${id}`);
  const read = readDsh(entry);
  return {
    lane: wantLane,
    title: read.title,
    cwd: read.cwd,
    youSaid: read.asks.map((a) => (read.turns > 1 ? `第${a.turn}轮：${a.text}` : a.text)),
    otherSaid: read.said.map((a) => (read.turns > 1 ? `第${a.turn}轮：${a.text}` : a.text)),
    background: [`共 ${read.calls} 次工具调用，跨 ${read.turns} 轮`],
    stats: `你说 ${read.askCount} 条 · 对面 ${read.otherCount} 条 · 共 ${read.calls} 次工具调用`
      + ` · 最后活动 ${new Date(entry.mtime).toISOString().slice(5, 16)}`,
  };
}

/**
 * 从一个**活着的会话**的内存事件快照里抽出与 {@link conversationEvidence} **同形状**的材料。
 *
 * 为什么必须有这条路：面板上的「审你自己」审的是**当前这个会话**，而
 * `conversationEvidence('dsh', id)` 读的是 `~/.dsh/sessions` 里**已落盘**的日志 ——
 * 刚建的会话可能还没写出来。`agent.session.snapshotEvents()`
 * （`dsh-session/lib/index.js:1376-1382` 读的是内存里的 `this.log`）永远是最新的，
 * 所以「审你自己」不读盘、也不怕会话还没持久化。
 *
 * 字段名与 {@link conversationEvidence} 逐字一致，所以提示词渲染器只有一份
 * （`index.js` 的 `renderEvidencePrompt`），按钮路与监控路不会各写一套材料格式。
 * @param {object[]} events - `agent.session.snapshotEvents()` 的结果。
 * @param {string} [lane] - 主体线（`me` / `conversation` / `agent`）。
 * @returns {object} `{lane, title, cwd, youSaid, otherSaid, background, stats}`。
 */
export function evidenceFromEvents(events, lane = 'me') {
  const wantLane = LANES.includes(lane) ? lane : 'me';
  const list = Array.isArray(events) ? events : [];
  const title = oneLine(list.find((e) => e?.type === 'session/title')?.data?.title)
    || oneLine(list.find((e) => e?.type === 'session')?.data?.header?.id)
    || '(当前会话)';
  const cwd = list.find((e) => e?.type === 'session')?.data?.header?.cwd
    ?? list.find((e) => e?.type === 'session')?.data?.cwd ?? '';
  const asks = [];
  const said = [];
  let turn = 0;
  let calls = 0;
  for (const e of list) {
    if (e?.type === 'turn/start') turn = Number(e.data?.turn ?? turn);
    if (e?.type === 'tool/call') calls += 1;
    if (e?.type === 'user/message' && e.data?.source?.kind === 'user') {
      const text = oneLine(contentText(e.data.content));
      if (text.length > 0) asks.push({ turn, text });
    }
    if (e?.type === 'assistant/message') {
      const text = oneLine(contentText(e.data.message?.content ?? e.data.content));
      if (text.length > 0) said.push({ turn, text });
    }
  }
  const prefix = (a) => (turn > 1 ? `第${a.turn}轮：${a.text}` : a.text);
  return {
    lane: wantLane,
    title,
    cwd,
    youSaid: asks.map(prefix),
    otherSaid: said.map(prefix),
    background: [`共 ${calls} 次工具调用，跨 ${turn} 轮`],
    stats: `你说 ${asks.length} 条 · 对面 ${said.length} 条 · 共 ${calls} 次工具调用`,
  };
}
