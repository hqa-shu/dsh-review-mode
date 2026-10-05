/**
 * Select a small, ordered set of original excerpts for one review. The markers
 * are private join keys for quote checking; the panel renders human labels.
 */
const CONSTRAINT = /不要|不能|必须|只能|只要|只需|先不|先别|更正|纠正|改成|改为|撤回|优先|记住|确认|验收|不需要|并非|instead|must|only|never|don't|do not|correction/i;
const MAX_SOURCES = 16;
const MAX_TEXT = 9500;
const MAX_EXCERPT = 1200;

function terms(value) {
  const text = String(value ?? '').toLowerCase();
  const out = new Set((text.match(/[a-z][a-z0-9_-]{2,}/g) ?? []).slice(0, 30));
  const chinese = (text.match(/[\u3400-\u9fff]{2,}/g) ?? []).join('');
  for (let i = 0; i < chinese.length - 1; i += 1) out.add(chinese.slice(i, i + 2));
  return out;
}

function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const term of a) if (b.has(term)) hits += 1;
  return hits / Math.max(1, Math.min(a.size, b.size));
}

/**
 * @param {Array<{role:'user'|'ai'|'tool',text:string,turn?:number,status?:string}>} timeline
 * @param {'me'|'conversation'|'agent'} lane
 */
export function buildReviewPacket(timeline, lane = 'me', { latestTurnComplete = null, unknownPending = false } = {}) {
  const rows = (Array.isArray(timeline) ? timeline : [])
    // Keep the original whitespace: a displayed quote must be a continuous
    // substring of one source message, not a reconstruction of several lines.
    .map((item, index) => ({ ...item, index, text: String(item?.text ?? '').trim() }))
    .filter((item) => ['user', 'ai', 'tool'].includes(item.role) && item.text.length > 0);
  const user = rows.filter((item) => item.role === 'user');
  const latestUser = user.at(-1);
  const focus = terms(latestUser?.text);
  const candidates = new Map();
  const add = (row, score) => {
    if (row) candidates.set(row.index, Math.max(score, candidates.get(row.index) ?? -1));
  };

  // Start with the current question, then recover the task's first instruction
  // and relevant corrections. This is not a tail-only or whole-prompt scan.
  add(user[0], 75);
  const recentUsers = user.slice(lane === 'conversation' ? -5 : -4);
  for (const [offset, row] of recentUsers.entries()) add(row, 110 + offset);
  for (const row of user.slice(1, -recentUsers.length || undefined)) {
    const relevance = overlap(terms(row.text), focus);
    if (CONSTRAINT.test(row.text) || relevance >= 0.16) add(row, 55 + relevance * 30 + (CONSTRAINT.test(row.text) ? 15 : 0));
  }

  const selectedUserIndexes = [...candidates.keys()];
  for (const index of selectedUserIndexes) {
    const current = rows.find((row) => row.index === index);
    if (!current || current.role !== 'user') continue;
    const following = rows.filter((row) => row.index > index && row.role === 'ai'
      && (current.turn > 0 ? row.turn === current.turn : row.index < (user.find((next) => next.index > index)?.index ?? Infinity)));
    // In a review of AI or the exchange, the actual response is as important
    // as the request. In a review of the user it remains useful context.
    add(following.at(-1), lane === 'me' ? 65 : 100);
  }

  if (lane !== 'me') {
    const latestTurn = latestUser?.turn;
    const tools = rows.filter((row) => row.role === 'tool'
      && (latestTurn > 0 ? row.turn === latestTurn : row.index > (latestUser?.index ?? -1)));
    for (const row of tools.slice(-3)) add(row, 62);
  }

  const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  const kept = [];
  let used = 0;
  for (const [index] of ranked) {
    if (kept.length >= MAX_SOURCES || used >= MAX_TEXT) break;
    const row = rows.find((item) => item.index === index);
    if (!row) continue;
    const text = row.text.slice(0, Math.min(MAX_EXCERPT, MAX_TEXT - used));
    if (!text) break;
    kept.push({ ...row, text, truncated: text.length < row.text.length });
    used += text.length;
  }
  kept.sort((a, b) => a.index - b.index);
  const counters = { user: 0, ai: 0, tool: 0 };
  const sources = kept.map((row) => {
    const id = `${{ user: 'U', ai: 'A', tool: 'T' }[row.role]}${++counters[row.role]}`;
    return { id, role: row.role, turn: Number(row.turn) || null, text: row.text,
      truncated: row.truncated, status: row.status ?? '', sourceKey: row.sourceKey ?? '',
      userOrdinal: row.role === 'user' ? user.findIndex((item) => item.index === row.index) + 1 : null };
  });
  const lastAiAfterUser = rows.some((row) => row.role === 'ai' && row.index > (latestUser?.index ?? Infinity));
  const missingReply = Boolean(latestUser && !lastAiAfterUser);
  const coverage = `本次参考 ${sources.length} 段原话或操作记录（所选会话共 ${rows.length} 段）；`
    + (sources.length < rows.length ? '其余内容未逐条复核' : '已覆盖全部可读记录')
    + (sources.some((item) => item.truncated) ? '；部分长消息只取连续开头' : '');
  return { sources, coverage, pendingReply: Boolean(latestUser && (latestTurnComplete === false || (unknownPending && latestTurnComplete === null && missingReply))),
    missingReply, latestTurnComplete,
    total: rows.length, selected: sources.length };
}

/**
 * Give a single-message suggestion a small, chronological view of its task.
 * Later messages are labelled as follow-up evidence, never as words the user
 * had already supplied when the target message was written.
 */
export function buildTurnContext(timeline, sourceKey) {
  const rows = (Array.isArray(timeline) ? timeline : []).filter((row) =>
    ['user', 'ai'].includes(row?.role) && String(row?.text ?? '').trim());
  const targetIndex = rows.findIndex((row) => row.role === 'user' && row.sourceKey === sourceKey);
  if (targetIndex < 0) return null;
  const target = rows[targetIndex];
  const nextUser = rows.findIndex((row, index) => index > targetIndex && row.role === 'user');
  const end = nextUser < 0 ? rows.length : nextUser;
  const paired = rows.slice(targetIndex + 1, end).filter((row) => row.role === 'ai'
    && (!target.turn || !row.turn || row.turn === target.turn)).slice(-2);
  const usersBefore = rows.slice(0, targetIndex).filter((row) => row.role === 'user');
  const usersAfter = rows.slice(end).filter((row) => row.role === 'user');
  const chosen = new Map();
  const add = (row) => { if (row?.sourceKey && row.sourceKey !== sourceKey) chosen.set(row.sourceKey, row); };
  add(usersBefore[0]);
  for (const row of usersBefore.slice(-2)) add(row);
  const focus = terms(target.text);
  for (const row of usersBefore.slice(1, -2)) {
    if (CONSTRAINT.test(row.text) && overlap(terms(row.text), focus) >= 0.08) add(row);
  }
  for (const row of usersAfter.slice(0, 2)) add(row);
  for (const row of usersAfter.slice(2)) {
    if (overlap(terms(row.text), focus) >= 0.22) add(row);
  }
  const indexOf = (row) => rows.indexOf(row);
  const ranked = [...chosen.values()].sort((a, b) => {
    const score = (row) => (row === usersBefore[0] ? 100 : 0)
      + (indexOf(row) > targetIndex ? 20 : 0)
      + overlap(terms(row.text), focus) * 25
      - Math.abs(indexOf(row) - targetIndex) * 0.05;
    return score(b) - score(a);
  }).slice(0, 5).sort((a, b) => indexOf(a) - indexOf(b));
  const before = ranked.filter((row) => indexOf(row) < targetIndex);
  const after = ranked.filter((row) => indexOf(row) > targetIndex);
  const replyTo = (row) => {
    const from=indexOf(row);
    const following=rows.findIndex((candidate,index)=>index>from && candidate.role==='user');
    return rows.slice(from+1,following<0 ? rows.length : following)
      .filter((candidate)=>candidate.role==='ai' && (!row.turn || !candidate.turn || row.turn===candidate.turn)).at(-1);
  };
  const beforeReplies=before.map(replyTo).filter(Boolean);
  const afterReplies=after.map(replyTo).filter(Boolean);
  const selected = [...before,...beforeReplies,target, ...paired, ...after,...afterReplies];
  const format = (row,max=340) => `${row.role === 'user' ? '用户' : 'AI'}${row.turn ? `第${row.turn}轮` : ''}：${String(row.text).slice(0, max)}${String(row.text).length > max ? '〔节选〕' : ''}`;
  const withReply=(items)=>items.flatMap((row)=>[format(row),replyTo(row) ? format(replyTo(row)) : '〔该轮未可靠配对到 AI 回复〕']);
  return {
    target, paired, before, after,beforeReplies,afterReplies,
    promptText: [
      '## 写这条原话以前的任务背景（只作上下文）', ...(before.length ? withReply(before) : ['未选入更早的相关原话']),
      '## 本条原话', format(target,1800),
      '## 这一条之后、下一条用户消息之前的 AI 回复', ...(paired.length ? paired.map((row)=>format(row,1000)) : ['未能从日志可靠配对这一轮的 AI 回复']),
      '## 后续修正与进展（发生在本条之后，不得倒算成当时已知条件）', ...(after.length ? withReply(after) : ['未选入后续相关记录']),
    ].join('\n').slice(0, 6500),
    summary: `参考本条原话、${paired.length} 条同轮 AI 回复、${before.length} 条更早消息、${after.length} 条后续消息及可配对回复；其余未逐条核查`,
    selectedCount: selected.length,
    totalCount: rows.length,
  };
}

const QUOTE = /[「“]([^」”]+)[」”]/g;
const CITATION = /\[([UAT]\d+)\]\s*[「“]([^」”]+)[」”]/g;
const STRONG_ABSENCE = /从未|始终没有|一直没有|完全没有|没有做|未执行|未回应|持续犯错|仍然没有/;

/** Turn model-written claims into evidence that can be checked by source ID. */
export function verifyReviewRecord(record, packet) {
  if (!Array.isArray(packet?.sources)) return { ...record, evidenceChecked: false };
  const byId = new Map(packet.sources.map((source) => [source.id, source]));
  const analysis = [];
  const advice = [];
  const evidenceSources = [];
  const dialog = [];
  let dropped = 0;
  for (const [index, raw] of (record.analysis ?? []).entries()) {
    const parts = String(raw).split('｜').map((part) => part.trim());
    const evidenceIndex = parts.findIndex((part) => /^依据[:：]/.test(part));
    if (evidenceIndex < 0) { dropped += 1; continue; }
    const evidence = parts[evidenceIndex];
    const explicit = [...evidence.matchAll(CITATION)];
    const quotes = [...evidence.matchAll(QUOTE)].map((match) => match[1]);
    const matched = [];
    let valid = true;
    for (const citation of explicit) {
      const source = byId.get(citation[1]);
      if (!source || citation[2].length > 180 || !source.text.includes(citation[2])) { valid = false; break; }
      matched.push({ source, quote: citation[2] });
    }
    // Older model responses omit markers. Accept a quote only when it occurs
    // in exactly one selected source; duplicate text cannot prove its speaker.
    if (valid && explicit.length === 0) {
      for (const quote of quotes) {
        const owners = packet.sources.filter((source) => source.text.includes(quote));
        if (quote.length > 180 || owners.length !== 1) { valid = false; break; }
        matched.push({ source: owners[0], quote });
      }
    }
    if (explicit.length > 0 && explicit.length !== quotes.length) valid = false;
    if (valid && matched.length === 0) {
      const markers = [...evidence.matchAll(/\[([UAT]\d+)\]/g)];
      // An operation description is checked against an actual tool result,
      // never against a command or a model-written account of the command.
      if (markers.length !== 1 || byId.get(markers[0][1])?.role !== 'tool'
        || !byId.get(markers[0][1])?.status) valid = false;
      else matched.push({ source: byId.get(markers[0][1]), quote: '' });
    }
    const claim = `${parts[0]} ${parts.find((part) => /^洞察[:：]/.test(part)) ?? ''}`;
    if (STRONG_ABSENCE.test(claim)
      && (packet.selected < packet.total || packet.sources.some((source) => source.truncated))) valid = false;
    if (!valid || matched.length === 0) { dropped += 1; continue; }

    const labels = matched.map(({ source, quote }) => {
      const actor = source.role === 'user' ? '你' : source.role === 'ai' ? 'AI' : '工具';
      const turn = source.turn ? `在第${source.turn}轮` : '';
      const verb = source.role === 'user' ? '说' : source.role === 'ai' ? '回答' : '返回';
      const status = source.role === 'tool' ? `（${source.status}）` : '';
      const excerpt = quote || source.text.slice(0, 160);
      return `${actor}${turn}${verb}${status}：「${excerpt}」${!quote && source.text.length > excerpt.length ? '（节选）' : ''}`;
    });
    parts[evidenceIndex] = `依据：${labels.join('；')}`;
    if (parts.join('｜').length > 650) { dropped += 1; continue; }
    analysis.push(parts.join('｜'));
    advice.push(String(record.advice?.[index] ?? parts.find((part) => /^建议[:：]/.test(part))?.replace(/^建议[:：]/, '') ?? ''));
    const citedIds = new Set(matched.map(({ source }) => source.id));
    const context = packet.sources.filter((source) => source.turn && !citedIds.has(source.id)
      && matched.some(({ source: cited }) => cited.turn === source.turn
        && ((cited.role === 'user' && source.role === 'ai') || (cited.role === 'ai' && source.role === 'user'))));
    const links = [...new Map([...matched.map(({ source }) => source), ...context].map((source) => [source.id, {
      id: source.id, sourceKey: source.sourceKey, role: source.role, turn: source.turn, status: source.status,
      text: source.text, truncated: source.truncated, userOrdinal: source.userOrdinal,
      cited: citedIds.has(source.id),
    }])).values()].slice(0, 3);
    evidenceSources.push(links);
    for (const { quote } of matched) if (quote && !dialog.includes(quote)) dialog.push(quote);
  }
  const checked = analysis.length > 0;
  return { ...record, evidenceChecked: true, coverage: packet.coverage,
    analysis, advice, dialog: dialog.slice(0, 4), evidenceSources, droppedEvidence: dropped,
    openIssues: [], resolvedIssues: [], good: [], noise: [], constraints: [], codexObs: [], nextCheck: '',
    verdict: checked ? record.verdict : 'unknown',
    headline: checked ? analysis[0].split('｜')[0] : '本次没有可核对的洞察',
    summary: checked ? record.summary : '现有材料不足以支持可核对的建议。' };
}
