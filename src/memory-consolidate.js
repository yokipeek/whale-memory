// 巩固器：把「一天的情景流水」炼成「关于他的理解」。
//
// ── 为什么这一层是整个记忆系统里最关键的一块 ────────────────────────
// 存储、检索、衰减都只是搬运。真正让记忆「像人」的是消化：
// 人睡一觉醒来不会记得昨天说过的每一句话，但会多出几句「关于这个人我知道了什么」。
// 海马体在慢波睡眠里做的事就是这个 —— 把白天的情景痕迹反复重放，
// 蒸馏成不依赖当时场景的语义（squashing），再写进新皮层长期保存。
//
// 没有这一层的时候发生了什么（实测数据）：
//   一天 500 条情景流水，语义层只有靠「情绪分最高的那一句原文」抄过去一条。
//   结果是——它记住了 500 句话，但说不出「我爸叫什么」。
//   有流水不等于有理解。
//
// ── 和 memory-core 里那个纯本地 consolidateDay 的分工 ──────────────
//   纯本地版（consolidateDay）：零成本兜底，只在没有模型可用时跑，
//     干的事是「挑一句情绪最重的原文抄进语义层」—— 不编造，但也不理解。
//   本文件（本地 + 模型）：正常路径，让模型真的读一遍昨天，写出提炼过的事实。
//     **失败一律降级到纯本地版**，不会因为模型挂了就丢掉一整天的记忆。
//
// ── 为什么不用 tool-calling 让它自己写 ────────────────────────────
//   巩固跑在没人看着的时候。让它调 qq_memory_remember 意味着失败会静默、
//   而且一次要来回十几个 turn。这里让它**输出一段 JSON**，由本地校验后写入：
//   模型只负责「理解」，写入、去重、限流、溯源全部在本地代码里控制。
//   这样即使模型胡言乱语，也进不了库。

import { shouldEncodeEpisode, emotionWeight } from './memory-core.js';

// 一次喂进去多少条情景。太多模型会开始概括成废话（「他今天聊了很多」），
// 太少看不出模式。40 条 ≈ 半天的有效对话，是实测下来信噪比最好的量。
export const MAX_ROWS_PER_CALL = 40;
// 单条截断：长消息对「提炼事实」没帮助，只会挤占上下文
const ROW_TEXT_LIMIT = 180;
// 一次巩固最多产出几条新事实。宁可少而准 —— 垃圾事实比没事实更糟，
// 因为它们会占掉工作记忆的 4 个槽位。
export const MAX_FACTS_PER_DAY = 3;
// 喂给模型时保留哪些字段。刻意不给 id —— 让它引用序号，本地映射回真 id，
// 避免模型编造 32 位十六进制（它一定会编）。
function trimRow(r, idx) {
  const gated = shouldEncodeEpisode(r.text || '', { self: r.self === true });
  // 感知引用要一起喂给模型：不然「他发过一段语音说想我」在巩固时只剩
  // 「[语音] 说的是：「…」」这句流水，模型不知道那是一次「听见」而不是「打字」。
  // 而「听觉记忆」和「读到一句话」在人的记忆里完全不是一回事。
  const sensory = Array.isArray(r.sensory) && r.sensory.length
    ? ` （当时还有${r.sensory.map((s) => {
      const label = { vision: '画面', audio: '声音', file: '文件', link: '链接' }[s.channel] || '附件';
      return s.summary ? `${label}：${String(s.summary).slice(0, 40)}` : label;
    }).join('、')}）`
    : '';
  return {
    i: idx + 1,
    who: String(r.who || ''),
    self: r.self === true,
    time: r.at ? new Date(Number(r.at)).toTimeString().slice(0, 5) : '',
    text: String(r.text || '').replace(/\s+/g, ' ').slice(0, ROW_TEXT_LIMIT) + sensory,
    _w: gated.keep ? gated.weight : 0,
  };
}

/**
 * 把一天的情景挑选成「值得送进模型看的一批」。
 *
 * 挑选规则（为什么不是全给）：
 *   1) 丢掉门禁判为噪声的（"嗯"、"哈哈"、"["表情]" — 这些连人看一遍也不会记住）
 *   2) 我自己的话只留「有关怀/有承诺/有信息」的，且降权（我的回复不是关于他的事实）
 *   3) 按 编码权重 × 情绪 排序，取前 MAX_ROWS_PER_CALL 条 —— 保证重要的不会因为
 *      排在一天末尾而漏掉
 *   4) 最后**按原始时间顺序**排回去 —— 模型需要看到对话的顺序才能理解因果关系
 *      （「他说不想活了」在前、「后来笑了」在后，这两句的顺序不能颠倒）
 */
export function pickRowsForConsolidation(rows, { maxRows = MAX_ROWS_PER_CALL } = {}) {
  const scored = [];
  rows.forEach((r, idx) => {
    if (!r || !r.text) return;
    const trimmed = trimRow(r, idx);
    if (!trimmed._w) return;
    const score = trimmed._w * emotionWeight(r.text);
    scored.push({ ...trimmed, _s: score });
  });
  scored.sort((a, b) => b._s - a._s);
  const chosen = scored.slice(0, maxRows);
  // self 名额：纯按分排，我自己的话（编码打六折后）几乎进不了窗口，
  // 模型巩固时就「只见他不见我」—— 我说过的立场、答应过的事全都蒸发了。
  // 从窗口里给 self 保底 4 个名额：取 self 里分最高的补进去（去重）。
  const SELF_QUOTA = 4;
  const selfCount = chosen.filter((r) => r.self).length;
  if (selfCount < SELF_QUOTA) {
    const seen = new Set(chosen.map((r) => r.i));
    const selfExtras = scored
      .filter((r) => r.self && !seen.has(r.i))
      .slice(0, SELF_QUOTA - selfCount);
    chosen.push(...selfExtras);
  }
  chosen.sort((a, b) => a.i - b.i);
  return chosen;
}

const SYSTEM_RULES = `你是一个记忆巩固器（不是聊天机器人）。
你的任务：读一天的对话流水，提炼出关于「对方」值得长期记住的事实，并更新你对他的印象。

严格遵守：
1. 只输出 JSON，不要输出任何解释、不要用 markdown 代码块包裹。
2. 事实必须是**流水里真实出现过的**，不许推测、不许补全、不许美化。
   说「他喜欢蓝色」必须有原话依据；只能说「他说蓝色好看」。
3. 不要抄原句当事实 —— 事实要去掉当时的语境，写成一句能独立成立的话。
   好：「他的生日是 3 月 14 日」「他在做 QQ 机器人叫小鲸鱼」
   坏：「他说'我生日是3月14号'」
4. 流水里没有值得记的就输出空数组 —— 宁可空，不要凑数。凑出来的垃圾事实
   会占掉她下次唤醒时的工作记忆槽位，比不记更糟。
5. profile 是「这个人是什么样的人」，一句话，可以比单条事实更概括，
   但只能用这一天里看到的东西支撑。`;

function buildPrompt({ day, rows, who, existing }) {
  const lines = [];
  lines.push(`日期：${day}`);
  if (who) lines.push(`对话对象：${who}`);
  if (existing?.length) {
    lines.push('');
    lines.push('【已经记着的事（不要重复写，除非这次出现了新细节要更正）】');
    for (const e of existing.slice(0, 12)) lines.push(`- ${e.text}`);
  }
  lines.push('');
  lines.push('【这一天的流水】（序号 说话人 时间 内容；self=true 表示是你自己说的）');
  for (const r of rows) {
    const spk = r.self ? '我(自己)' : (r.who || '某人');
    lines.push(`${r.i}. ${spk} ${r.time}：${r.text}`);
  }
  lines.push('');
  lines.push(`请输出 JSON，格式：
{
  "facts": [
    { "text": "一句去掉语境的事实", "who": "说话人名字", "from": [流水序号], "importance": 1-5, "kind": "fact|preference|event|relationship" }
  ],
  "profile": "一句话：这个人是什么样的人（只依据这一天看到的；没把握就空字符串）"
}`);
  lines.push(`要求：facts 最多 ${MAX_FACTS_PER_DAY} 条，from 必须是真的序号。没有值得记的就 "facts": []。`);
  return lines.join('\n');
}

/** 从模型输出里抠出 JSON。模型经常加 ```json 围栏或前后废话。 */
export function parseConsolidationOutput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { facts: [], profile: '' };
  let body = raw;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1];
  // 找到第一个 { 和最后一个 } —— 比正则可靠
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { facts: [], profile: '' };
  let parsed;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return { facts: [], profile: '' }; }
  const facts = [];
  for (const f of Array.isArray(parsed?.facts) ? parsed.facts : []) {
    if (!f || typeof f !== 'object') continue;
    const t = String(f.text ?? '').trim();
    if (!t) continue;
    const from = Array.isArray(f.from) ? f.from.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    facts.push({
      text: t.slice(0, 400),
      who: String(f.who ?? '').trim(),
      from,
      importance: Math.min(5, Math.max(1, Number(f.importance) || 3)),
      kind: ['fact', 'preference', 'event', 'relationship'].includes(f.kind) ? f.kind : 'fact',
    });
  }
  return { facts: facts.slice(0, MAX_FACTS_PER_DAY), profile: String(parsed?.profile ?? '').trim().slice(0, 400) };
}

/**
 * 把解析结果落到 store 里。
 *
 * 溯源（derivedFrom）：每条语义事实记住它是从哪几条情景推出来的。
 * 这是「防虚构症」的地基 —— 人分不清记忆来源就会编（Loftus 实验），
 * 模型也一样。有了 derivedFrom，任何时候都能回答「你凭什么这么记得」，
 * 也能在原始流水被删除时把派生事实一起清掉。
 */
export function applyConsolidation(store, { day, parsed, rows, log = () => {} }) {
  const byIndex = new Map(rows.map((r) => [r.i, r]));
  let learned = 0;
  let reinforced = 0;
  const existing = store.allSemantic();

  for (const f of parsed.facts || []) {
    // 溯源：序号 → 真情景 item（拿到真实 id 与 at）
    const derived = [];
    for (const n of f.from || []) {
      const r = byIndex.get(n);
      if (r) derived.push({ day, idx: r.i - 1, at: r._at || 0, text: r.text.slice(0, 60) });
    }
    if (!derived.length) {
      // 没有溯源就不写 —— 这是硬规则。凭空而来的「事实」不许进库。
      log(`[memory] 巩固丢弃无溯源事实：${f.text.slice(0, 30)}`);
      continue;
    }
    // 去重：已经存在同样意思的（文本高度重合）就算强化，不重复写
    const norm = f.text.replace(/\s+/g, '').toLowerCase();
    const dup = existing.find((m) => {
      if (m.kind === 'profile') return false;
      const t = String(m.text || '').replace(/\s+/g, '').toLowerCase();
      if (!t) return false;
      if (t === norm) return true;
      // 「他的生日是三月十四日」与「他的生日是 3 月 14 日」不该存两份
      const a = t.replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
      const b = norm.replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
      return a && b && (a === b || (Math.min(a.length, b.length) / Math.max(a.length, b.length) > 0.85 && (a.includes(b) || b.includes(a))));
    });
    if (dup) {
      dup.hits = (Number(dup.hits) || 0) + 1;
      dup.lastHitAt = Date.now();
      reinforced += 1;
      continue;
    }
    store.remember(f.text, {
      kind: 'semantic',
      layer: 'long',
      who: f.who || '',
      importance: f.importance,
      at: derived[0]?.at || Date.now(),
      source: 'consolidate',
      tags: ['巩固', day, f.kind],
    });
    // remember 返回的是库里的对象；把溯源挂在它上面（remember 不认这个字段，事后补）
    const written = store.allSemantic().find((m) => m.text === f.text.slice(0, 800) && !m.derivedFrom);
    if (written) {
      written.derivedFrom = derived;
      written.factKind = f.kind;
    }
    learned += 1;
  }

  if (parsed.profile) {
    const whoName = (rows.find((r) => !r.self && r.who) || {}).who || '';
    if (whoName) {
      store.setProfile(whoName, parsed.profile, { importance: 5, tags: ['巩固', day] });
    }
  }
  return { learned, reinforced };
}

/**
 * 主入口：巩固一天。
 *
 * ask 是一个 async (promptText) => string，由调用方注入（bridge 用它去开一次
 * 一次性会话）。这样本文件零依赖 DSH，可以纯单测。
 * ask 抛错或返回空 → 自动降级到纯本地模式（只挑高情绪原文），绝不空手而归。
 */
export async function consolidateDayWithModel(store, day, {
  ask = null,
  who = '',
  log = () => {},
  now = () => Date.now(),
  fallback = null,
} = {}) {
  const rowsRaw = store.readDay(day);
  if (!rowsRaw.length) return { day, learned: 0, reinforced: 0, episodic: 0, mode: 'empty' };

  const picked = pickRowsForConsolidation(rowsRaw);
  if (!picked.length) {
    log(`[memory] 巩固 ${day}：${rowsRaw.length} 条全是噪声，无可巩固`);
    store.markConsolidated(day);
    return { day, learned: 0, reinforced: 0, episodic: rowsRaw.length, mode: 'noise-only' };
  }

  // 把原始 at 挂到 picked 上给溯源用（trimRow 只留了 HH:MM 给人看）
  for (const p of picked) {
    const src = rowsRaw[p.i - 1];
    if (src) p._at = Number(src.at) || 0;
  }

  if (!ask) {
    // 没给模型：退回纯本地（只抄高情绪原文），保证一天不会白过
    const r = fallback ? fallback(store, day) : { learned: 0, reinforced: 0 };
    store.markConsolidated(day);
    log(`[memory] 巩固 ${day}（无模型，纯本地）：新学 ${r.learned} 条`);
    return { day, ...r, episodic: rowsRaw.length, mode: 'local' };
  }

  let output = '';
  try {
    output = await ask(buildPrompt({
      day,
      rows: picked,
      who,
      existing: store.allSemantic().filter((m) => !m.kind || m.kind !== 'profile').slice(-12).reverse(),
    }), { day });
  } catch (error) {
    log(`[memory] 巩固 ${day} 模型调用失败，降级纯本地：${error?.message ?? error}`);
    const r = fallback ? fallback(store, day) : { learned: 0, reinforced: 0 };
    store.markConsolidated(day);
    return { day, ...r, episodic: rowsRaw.length, mode: 'local-fallback' };
  }

  const parsed = parseConsolidationOutput(output);
  if (!parsed.facts.length && !parsed.profile) {
    log(`[memory] 巩固 ${day}：模型判定无可记（${String(output).slice(0, 60).replace(/\n/g, ' ')}）`);
    store.markConsolidated(day);
    return { day, learned: 0, reinforced: 0, episodic: rowsRaw.length, mode: 'model-empty' };
  }

  const applied = applyConsolidation(store, { day, parsed, rows: picked, log });
  store.markConsolidated(day);
  log(`[memory] 巩固 ${day}：${rowsRaw.length} 条 → 送模型 ${picked.length} 条，新学 ${applied.learned} 条，强化 ${applied.reinforced} 条${parsed.profile ? '，画像已更新' : ''}`);
  return { day, ...applied, episodic: rowsRaw.length, mode: 'model', profile: parsed.profile || '' };
}

/**
 * 补跑：从水位之后逐天巩固。
 * maxDays 防止第一次上线时一口气处理几百天（会卡住事件循环，也会烧钱）。
 */
export async function consolidatePendingWithModel(store, {
  maxDays = 3,
  ask = null,
  who = '',
  log = () => {},
  fallback = null,
} = {}) {
  const days = store.listDays();
  const through = store.consolidatedThrough();
  const todo = days.filter((d) => !through || d > through).slice(0, maxDays);
  const out = [];
  for (const day of todo) {
    try {
      out.push(await consolidateDayWithModel(store, day, { ask, who, log, fallback }));
    } catch (error) {
      log(`[memory] 巩固 ${day} 异常：${error?.message ?? error}`);
    }
  }
  return out;
}

// ── 再巩固（reconsolidation）─────────────────────────────────────────────
//
// 人不是把记忆存成只读文件：每次回忆都会把它拉出来重写一遍再放回去
// （Nader, Schafe & LeDoux 2000 做的就是这个实验 —— 回忆时给蛋白合成抑制剂，
// 旧记忆会被抹掉，说明回忆那一刻记忆是「可写」的）。
//
// 这一层解决的是「记错了还越来越牢」：一条事实被反复检索说明它重要，
// 重要的事实更该被核对。所以策略是：被想起来 N 次 → 排一次队 → 问模型
// 「结合现在的流水，这条还成立吗」，成立就留着，不成立就改写。

const REVIEW_RULES = `你是一个记忆核对器（不是聊天机器人）。
给你一条「你以前记着的事」和最近几天的对话流水，判断这条还成立吗。

严格遵守：
1. 只输出 JSON，不要任何解释、不要 markdown 代码块。
2. verdict 只能是三种之一：
   - "keep"   ：流水没推翻它，保持原样
   - "revise" ：流水给出了更准确/更完整的版本，用 text 给新版本
   - "drop"   ：流水明确推翻了它（比如记着「他养猫」后来他说猫送人了）
3. revise 的新文本必须能独立成立，不许带「据对话」「他说」这种前缀。
4. 流水里什么都没提到这条 → 一律 "keep"。没有证据就不要改，改写比不改更危险。`;

function buildReviewPrompt({ item, rows }) {
  const lines = [];
  lines.push('【你以前记着的事】');
  lines.push(`- ${item.text}`);
  if (item.who) lines.push(`  （关于：${item.who}）`);
  lines.push('');
  lines.push('【最近的流水】（序号 说话人 时间 内容）');
  if (!rows.length) lines.push('（这几天没有相关流水）');
  for (const r of rows) {
    const spk = r.self ? '我(自己)' : (r.who || '某人');
    lines.push(`${r.i}. ${spk} ${r.time}：${r.text}`);
  }
  lines.push('');
  lines.push('请输出 JSON：{"verdict":"keep|revise|drop","text":"revise 时给新版本，其它情况空字符串","reason":"十个字以内说为什么"}');
  return lines.join('\n');
}

/**
 * 对排队中的条目做一次再巩固。
 *
 * 刻意做成「一次只处理少量」：再巩固是改写别人的记忆，宁可慢慢来。
 * 每次跑 limit 条，跑完清掉 reviewDue 标记（reviseFact 里清），
 * 没被改的也要清 —— 否则同一批会被无限重复核对。
 */
export async function reconsolidateDue(store, {
  ask = null,
  limit = 3,
  log = () => {},
  recentRows = null,
} = {}) {
  const due = store.listReviewDue({ limit });
  if (!due.length) return { checked: 0, revised: 0, dropped: 0, kept: 0 };

  const out = { checked: 0, revised: 0, dropped: 0, kept: 0 };
  // 流水：默认取最近的 2 天，按关键词粗筛（全量塞进去会撑爆上下文）
  const pickRows = (item) => {
    if (typeof recentRows === 'function') {
      try { return recentRows(item) || []; } catch { return []; }
    }
    const days = store.listDays().slice(-2);
    const words = String(item.text || '').split(/[\s，。、的和在是有他我]/).filter((w) => w.length >= 2);
    const rows = [];
    for (const d of days) rows.push(...store.readDay(d));
    const hit = rows.filter((r) => {
      const t = String(r.text || '');
      return words.some((w) => t.includes(w));
    });
    const picked = (hit.length ? hit : rows.slice(-12)).slice(0, 24);
    return picked.map((r, i) => ({
      i: i + 1,
      self: Boolean(r.self),
      who: r.who || '',
      time: r.at ? new Date(Number(r.at)).toISOString().slice(11, 16) : '',
      text: String(r.text || '').slice(0, 120),
    }));
  };

  for (const item of due) {
    out.checked += 1;
    if (!ask) { store.clearReviewDue(item.id); out.kept += 1; continue; }
    const rows = pickRows(item);
    let raw = '';
    try {
      raw = await ask(buildReviewPrompt({ item, rows }), { review: item.id });
    } catch (error) {
      log(`[memory] 再巩固失败（${item.id}）：${error?.message ?? error}`);
      store.clearReviewDue(item.id);   // 失败也要清，否则卡死一条永久重试
      out.kept += 1;
      continue;
    }
    const parsed = parseReviewOutput(raw);
    if (parsed.verdict === 'drop') {
      store.forget(item.id);
      log(`[memory] 再巩固丢弃：${item.text.slice(0, 30)}（${parsed.reason || '被推翻'}）`);
      out.dropped += 1;
      continue;
    }
    if (parsed.verdict === 'revise' && parsed.text) {
      store.reviseFact(item.id, parsed.text, { reason: parsed.reason });
      log(`[memory] 再巩固改写：${item.text.slice(0, 20)} → ${parsed.text.slice(0, 20)}（${parsed.reason || ''}）`);
      out.revised += 1;
      continue;
    }
    store.clearReviewDue(item.id);
    out.kept += 1;
  }
  return out;
}

/** 从模型输出里抠 verdict。跟 parseConsolidationOutput 一样容错。 */
export function parseReviewOutput(text) {
  const raw = String(text ?? '').trim();
  const empty = { verdict: 'keep', text: '', reason: '' };
  if (!raw) return empty;
  let body = raw;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;
  let parsed;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return empty; }
  const verdict = ['keep', 'revise', 'drop'].includes(parsed?.verdict) ? parsed.verdict : 'keep';
  return {
    verdict,
    text: String(parsed?.text ?? '').trim().slice(0, 800),
    reason: String(parsed?.reason ?? '').trim().slice(0, 60),
  };
}
