/** Pure evidence directory and retrieval helpers. UI uses the host command channel. */
import { randomUUID } from 'node:crypto';
import {
  LANES,
  TARGET_KINDS,
  clip,
  conversationEvidence,
  currentTarget,
  listCodex,
  listDshSessions,
  readCodexIndex,
  readDsh,
  setTarget as setSharedTarget,
} from './reviewer.js';

/** Cordis 服务键，同时也是远程命名空间。 */
export const SERVICE = 'reviewRemote';

/** 三个方向。和 `reviewer.js` 共用同一份定义。 */
export const KINDS = TARGET_KINDS;

/** 目录里最多列几条。 */
const DEFAULT_LIMIT = 40;

/** 宿主上下文（构造时记下）。问答要读投影、要往会话里注入，都靠它。 */
let hostCtx = null;

/** 极简的消息冻结（`index.js` 里那份等价；不跨模块 import，避免环）。 */
function freezeMessage(message, seen = new WeakSet()) {
  if (message === null || typeof message !== 'object') return message;
  if (seen.has(message)) return message;
  seen.add(message);
  Object.freeze(message);
  for (const key of Object.keys(message)) freezeMessage(message[key], seen);
  return message;
}

/**
 * 把「针对评价的提问」回答成一句话：在**最近一次评价的分析段落**里定位相关的那一条。
 *
 * 这是**检索式回答**（不重新跑一遍完整复审）：用户问「为什么这么说」「分析里第二条展开讲讲」
 * 「建议是什么」，答案就是把那条评价里对得上的原话摊开 —— 可解释、廉价、
 * 也不打断正在流式生成的自动评价。
 *
 * 旧版是在固定表格里按行名找；表格已经删掉（判据改成 `rubric.js` 的四段自适应分析），
 * 所以这里改成按 `rubric.js` 的段落表 `sections` 找段落、再按问题里的关键词选条目。
 * @param {string} question - 用户的问题。
 * @param {object|null} last - 最近一次评价（带 `sections` + 四个段落）。
 * @returns {string} 回答。
 */
export function answerFromTable(question, last) {
  const sections = Array.isArray(last?.sections) ? last.sections : [];
  if (sections.length === 0 || last === null || last === undefined) {
    return '还没有可参照的评价 —— 等右边自动生成第一条评价之后再问。';
  }
  const ask = String(question ?? '');
  const ordinal = /(?:第\s*([一二三四1234])\s*[条点项]|([①②③④]))/.exec(ask);
  if (ordinal) {
    const digit = ordinal[1] ?? ordinal[2];
    const index = '一二三四'.includes(digit) ? '一二三四'.indexOf(digit)
      : ('①②③④'.includes(digit) ? '①②③④'.indexOf(digit) : Number(digit) - 1);
    const insight = last.analysis?.[index];
    if (!insight) return `这次评价没有第${index + 1}条洞察。`;
    const parts = String(insight).split('｜');
    const evidence = parts.find(x => /^依据[:：]/.test(x));
    return `已有评价摘录 · 第${index + 1}条：${/依据|原话|证据/.test(ask) && evidence ? evidence : insight}${/建议|怎么|做法/.test(ask) && last.advice?.[index] ? `；建议：${last.advice[index]}` : ''}`;
  }
  const itemsOf = (key) => (key === 'summary'
    ? (String(last.summary ?? '').trim().length > 0 ? [String(last.summary).trim()] : [])
    : (Array.isArray(last[key]) ? last[key].map((item) => String(item)) : []));
  // 1) 问题里点名的段落优先（「建议」「分析」「概述」「对话」）。
  const named = sections.find((section) => ask.includes(String(section.title)));
  // 2) 否则挑第一条「问句里的关键词命中」的条目。
  const hitSection = named ?? sections.find((section) => itemsOf(section.key)
    .some((item) => item.length > 0 && item.replace(/\s+/g, '').split(/[，。；、,.]/).some((chunk) => chunk.length >= 4 && ask.includes(chunk))));
  const target = hitSection ?? sections.find((section) => section.key === 'analysis' && itemsOf('analysis').length > 0) ?? sections[0];
  const items = itemsOf(target.key);
  if (items.length === 0) {
    return `这条评价里「${target.title}」还是空的（复审员没写这一段）—— 换个说法或等下一次复审。`;
  }
  const head = `按「${target.title}」这一段`;
  return `${head}：${items.map((item) => item.replace(/^[-*•·]\s*/, '')).join('；')}`;
}

/**
 * 造一条 `qa` 通知消息：进同一个流，但 `form: 'qa'` 让它和自动评价**一眼可分**。
 * @param {object} review - `{question, answer, lane, turn, table}`。
 * @returns {object} 冻结后的消息。
 */
function createQaMessage(review) {
  return freezeMessage({
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: `问：${review.question}\n→ ${review.answer}` }],
    source: {
      kind: 'review-mode',
      form: 'qa',
      summary: '审核问答',
      review,
    },
  });
}

/**
 * 从会话投影里取**最近一张自动评价**（跳过 `kind:'qa'` 的问答条目）。
 *
 * 面板那条 `ask` 命令和 `remoteExportAsk` 都用它 —— 一处取卡片，避免两份逻辑漂。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} agent - 目标 Agent。
 * @returns {object|null} 最近一张评价卡片，或 null。
 */
export function lastReviewCard(ctx, agent) {
  let state = null;
  try { state = ctx.sessionProjections?.stateOf(agent.session, 'reviewMode') ?? null; } catch { state = null; }
  const feed = Array.isArray(state?.feed) ? state.feed : [];
  return feed.slice().reverse().find((entry) => entry?.kind !== 'qa') ?? state?.last ?? null;
}

/* ── 当前选中的目标（宿主内共享）────────────────────────────── */

// 状态本体在 `reviewer.js`（那个模块零依赖，预设行加载它）。这里只做转发，
// 让 `index.js` 继续从 `remote.js` 读到同一个 `currentTarget()`。
export { currentTarget };

/**
 * 记下用户选中的对话。**B：宿主工具用它记录原生可点选项里的选择**，
 * 监控器（`index.js`）下次 tick 读 `currentTarget()` 就盯着那条。
 * @param {object|null} target - `{kind, id, title?, project?}`。
 * @returns {object|null} 记录后的目标。
 */
export function setTarget(target) {
  return setSharedTarget(target);
}

/* ── 目录：快、确定、不读大文件 ─────────────────────────────── */

/** 相对时间，像 Codex 那样只给个大概。 */
function ageOf(mtime) {
  const minutes = Math.max(0, Math.round((Date.now() - mtime) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.round(days / 30)} 个月前`;
}

/**
 * 列出可审的对话。
 *
 * 刻意**不读 rollout 正文**（只 stat + 读名字索引），所以它很快、不花 token ——
 * 用户明确要过「快、固定、省 token」。条数等细节留到选中之后取证据时再算。
 * @param {object} input - `{kind, limit}`。
 * @returns {object} `{kind, recent, groups, total}`。
 */
export function buildTargets(input = {}) {
  const kind = KINDS.includes(input.kind) ? input.kind : 'codex';
  const limit = Number.isFinite(input.limit) && input.limit > 0
    ? Math.min(200, Math.trunc(input.limit))
    : DEFAULT_LIMIT;

  const rows = [];
  if (kind === 'codex') {
    const index = readCodexIndex();
    for (const entry of listCodex(limit)) {
      const project = index.projectOf.get(entry.threadId) ?? '';
      const heading = index.titleOf.get(entry.threadId) ?? '';
      rows.push({
        id: entry.id,
        kind: 'codex',
        project: project || '（未归类）',
        title: heading || clip(entry.id, 28),
        // Codex 侧边栏显示的是「项目 / 标题」；这里也带上，方便前端一行显示。
        label: project.length > 0 && heading.length > 0 ? `${project} / ${heading}` : (heading || project || entry.id),
        age: ageOf(entry.mtime),
        mtime: entry.mtime,
      });
    }
  } else {
    // 'self'（本会话）和 'dsh'（别的历史会话）是同一份数据源，前端按需要过滤。
    for (const entry of listDshSessions(limit)) {
      let title = entry.id.slice(0, 8);
      try { title = readDsh(entry).title || title; } catch { /* 读不了就用 id */ }
      rows.push({
        id: entry.id,
        kind: 'dsh',
        project: 'DSH',
        title,
        label: title,
        age: ageOf(entry.mtime),
        mtime: entry.mtime,
      });
    }
  }

  rows.sort((left, right) => right.mtime - left.mtime);

  // ① 最近优先（用户要的「最上面有一个最近」）
  const recent = rows.slice(0, 8);
  // ② 照 Codex 的分组：项目 → 对话（组内也是最近优先）
  const groups = [];
  const seen = new Map();
  for (const row of rows) {
    let group = seen.get(row.project);
    if (group === undefined) {
      group = { project: row.project, conversations: [] };
      seen.set(row.project, group);
      groups.push(group);
    }
    group.conversations.push({ id: row.id, kind: row.kind, title: row.title, age: row.age });
  }

  return {
    kind,
    total: rows.length,
    recent: recent.map(({ mtime, ...rest }) => rest),
    groups: groups.map((group) => ({ project: group.project, count: group.conversations.length, conversations: group.conversations })),
    selected: currentTarget(),
  };
}
