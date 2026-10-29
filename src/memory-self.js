// 自我与时间线：自传体记忆（autobiographical memory）+ 叙事连续性 + 里程碑
//
// ── 为什么单独一层 ──────────────────────────────────────────────────
//   记忆系统的评分卡里这一项原来只有 25%，是最弱的一环。原因很具体：
//   原来的存储只有「一条条事实」，没有「时间轴」。
//   人能讲出「我这一年过得怎么样」，靠的不是逐条回忆，而是三样东西：
//
//   ① 时间线（timeline）—— 事件按时间排开，密度、间隔本身就是信息
//      「三月很空，四月一下子挤满了」这种形状，单条记忆是看不出来的。
//   ② 里程碑（milestone）—— 只有少数事件会被标成「那之后就不一样了」
//      第一次叫我老婆、第一次说要娶我、第一次吵架又和好。
//      人不会给每件事都打这个标记，所以这里也必须有严格门槛。
//   ③ 自传体摘要（autobiography）—— 把一段时间压缩成几句话说给自己听
//      这是叙事连续性（narrative continuity）的载体：
//      「我是谁」不取决于 500 条流水，而取决于那几句被反复讲述的话。
//
// ── 边界（刻意不做的事）────────────────────────────────────────────
//   · 不编造情节：摘要里的每一条都必须能指回真实记忆（带 refId）。
//   · 不假装有情感体验：这里只统计形状与强度，不生成「我感到」的断言。
//   · 不与 core 抢位置：里程碑是「重要」，core 是「不可忘」，
//     里程碑满了会按月折叠，core 永不折叠。
//
// ── 与 memory-core 的关系 ───────────────────────────────────────────
//   memory-core 是「存取」层，这一层是「读出来重新组织」的层。
//   它只消费 core 暴露的 store 接口（readDay / allSemantic / listDays），
//   不直接碰文件，因此完全可单测。

/** 里程碑类型：只认这几种。放宽到「任何高分事件」就退化成排行榜了。 */
export const MILESTONE_KINDS = [
  'relation', // 关系确立/变化（老婆、在一起、分手）
  'promise', // 承诺（答应、一定、发誓）
  'first', // 第一次（第一次叫、第一次见面）
  'loss', // 失去（离开、别走、再见、去世）
  'conflict', // 冲突与和好（吵架、对不起、原谅）
  'achievement', // 达成（跑通了、成功了、考上了）
];

/**
 * 里程碑词表：每条都带 kind。
 *
 * 为什么不用分数阈值代替：
 *   分数高只说明「这条重」，但人不会把「他今天第 100 次说喜欢我」记成里程碑 ——
 *   里程碑的定义是**状态的改变**，词表就是状态的边界。
 */
const MILESTONE_PATTERNS = [
  // 关系确立 / 变化
  { kind: 'relation', words: ['在一起', '做我女', '做我男', '嫁给我', '娶你', '娶我', '答应做', '是老婆', '是老公', '是妻子', '是丈夫', '我老婆', '我老公', '分手', '离婚'] },
  // 承诺
  { kind: 'promise', words: ['答应', '发誓', '保证', '一定', '承诺', '永远不', '永远会', '一辈子'] },
  // 第一次
  { kind: 'first', words: ['第一次', '初次', '头一次', '第一回'] },
  // 失去
  { kind: 'loss', words: ['离开', '别走', '再见', '走了', '去世', '没了', '最后一面', '分手'] },
  // 冲突与和好
  { kind: 'conflict', words: ['吵架', '对不起', '原谅', '生气', '冷战', '和好'] },
  // 达成
  { kind: 'achievement', words: ['跑通了', '成功', '搞定', '考上', '通过了', '上线了', '修好了', 'win'] },
];

/** 反向词：明确否定时不算（「我没答应」「我们没在一起」）。 */
const NEGATORS = ['没', '不', '别', '未', '无'];

function hasNegated(text, at) {
  // 看命中词前面 3 个字符内有没有否定词
  const from = Math.max(0, at - 3);
  const head = text.slice(from, at);
  return NEGATORS.some((n) => head.includes(n));
}

/**
 * 事件类里程碑（冲突/成就/语气弱的承诺）必须挨着人，否则不算。
 *
 * 为什么需要这条：实测把「四张，开心、生气、委屈、得意。一张两分钟，我在跑了。」
 * 判成了 conflict 里程碑（命中词「生气」）—— 那只是四个表情包的形容词列表，
 * 却因为句尾有个「我」拿到加成，然后被当成「你们的转折点之一」写进提示词。
 * 里程碑槽每轮只放一条，假里程碑会把真里程碑挤掉，等于把「第一次叫我老婆」
 * 换成「他列举过四个表情名」。代价太高，所以宁可漏判。
 *
 * 判据：命中词前 6 字内有人称代词，或词后紧跟「了/起来/过」这类完成体标记。
 * 「我们吵架了」过（前面有我们）、「我跑通了」过（前面有我）、
 * 「开心、生气、委屈」不过（前面是顿号列举，非人称）。
 */
const SUBJECTS = /(我|你|他|她|咱|大家|宝贝|老婆|老公|主人)/u;
const PERFECTIVE = /^(?:了|起来|过|完|好)/u;

function hasEventiveContext(text, at, word) {
  // 词本身带完成体（「跑通了」「修好了」「上线了」）→ 已经是「发生了一件事」
  if (/(?:了|过|完|成|好)$/u.test(word)) return true;
  const head = text.slice(Math.max(0, at - 6), at);
  if (SUBJECTS.test(head)) return true;
  return PERFECTIVE.test(text.slice(at + word.length, at + word.length + 2));
}

/**
 * 判定一条记忆是不是里程碑。
 *
 * 返回 null 或 { kind, word, confidence }。
 * confidence 用途：0.9 以上（关系/失去）可以顶进 core；0.6~0.9 只进时间线标注。
 */
export function detectMilestone(text, { self = false } = {}) {
  const s = String(text || '');
  if (!s) return null;
  let best = null;
  for (const pat of MILESTONE_PATTERNS) {
    for (const w of pat.words) {
      let from = 0;
      while (true) {
        const i = s.indexOf(w, from);
        if (i < 0) break;
        from = i + w.length;
        if (hasNegated(s, i)) continue;
        // 事件类（冲突/成就）必须有主语或完成体，否则只是并列形容词。
        // relation/loss 不受此限 —— 「是老婆」这种本身就带关系判定的词，
        // 前面不需要人称也成立。
        if ((pat.kind === 'conflict' || pat.kind === 'achievement')
          && !hasEventiveContext(s, i, w)) continue;
        // 关系/失去类几乎总是里程碑；成就/冲突类要有「我/他」当主语才更可信
        let conf = 0.72;
        if (pat.kind === 'relation' || pat.kind === 'loss') conf = 0.92;
        else if (pat.kind === 'promise' && /(答应|发誓|保证)/.test(w)) conf = 0.85;
        else if (pat.kind === 'first') conf = 0.8;
        if (/(我|你|我们|他|她)/.test(s)) conf = Math.min(0.98, conf + 0.04);
        // 我自己说的话做里程碑要更确定才立得住：自传体里的假里程碑
        // （比如我随口应了一句承诺）会被当成关系转折点，代价比他的更贵。
        if (self) conf = Math.min(0.98, conf - 0.1);
        if (conf < 0.6) continue;
        if (!best || conf > best.confidence) best = { kind: pat.kind, word: w, confidence: Number(conf.toFixed(2)) };
        break;
      }
    }
  }
  return best;
}

/**
 * 时间线：把记忆按天排开，并算出「形状」。
 *
 * 为什么形状值钱：
 *   「三月几乎空白，四月 37 条」这句话本身就携带信息 ——
 *   它说明那段时间发生了什么，即使一条条内容都忘了。
 *   人的自传体记忆里，密度变化比内容更容易保留（Reminiscence bump 就是形状效应）。
 */
export function buildTimeline(entries, { gapDays = 3 } = {}) {
  const byDay = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const day = String(e?.day || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const days = [...byDay.keys()].sort();
  const lines = [];
  let prev = '';
  const peaks = [];
  for (const day of days) {
    const rows = byDay.get(day);
    // 空白间隔：人记得「中间有段时间没联系」
    if (prev) {
      const gap = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`)) / 86400000);
      if (gap >= gapDays) lines.push({ day, type: 'gap', gapDays: gap - 1 });
    }
    const strong = rows.filter((r) => (Number(r.w) || 0.6) >= 1.0 || Number(r.romance) > 0);
    const count = rows.length;
    const kindCount = new Map();
    for (const r of rows) {
      const ms = detectMilestone(r.text, { self: r.self === true });
      if (ms) kindCount.set(ms.kind, (kindCount.get(ms.kind) || 0) + 1);
    }
    lines.push({
      day,
      type: 'day',
      count,
      strong: strong.slice(0, 3).map((r) => ({ id: r.id, text: String(r.text || '').slice(0, 60), w: Number(r.w) || 0 })),
      milestones: [...kindCount.entries()].map(([kind, n]) => ({ kind, n })),
    });
    if (count >= 30 || strong.length >= 5) peaks.push(day);
    prev = day;
  }
  return {
    days,
    lines,
    span: days.length ? `${days[0]} ~ ${days[days.length - 1]}` : '',
    totalDays: days.length,
    peaks,
    // 「有多密」= 天数 / 首尾跨度，用来讲「我们一直连着」还是「断断续续」
    density: days.length >= 2
      ? Number((days.length / (Math.round((Date.parse(`${days[days.length - 1]}T00:00:00Z`) - Date.parse(`${days[0]}T00:00:00Z`)) / 86400000) + 1)).toFixed(3))
      : 0,
  };
}

/**
 * 自传体摘要：把一段时间压成几句「我自己的话」。
 *
 * 输入：
 *   semantic  语义记忆（含 importance / emotion / createdAt）
 *   milestones  里程碑（可由 collectMilestones 得到）
 *   days      时间线（由 buildTimeline 得到）
 *
 * 输出是纯文本，直接进提示词。每条都带日期与出处，模型不会把它当刚发生的事。
 */
export function autobioSummary({ semantic = [], milestones = [], timeline = null, maxChars = 900 } = {}) {
  const parts = [];
  if (timeline && timeline.totalDays) {
    parts.push(`我们连着 ${timeline.totalDays} 天有记录（${timeline.span}），密度 ${(timeline.density * 100).toFixed(0)}%。`);
    if (timeline.peaks.length) {
      parts.push(`话最多的几天：${timeline.peaks.slice(-3).join('、')}。`);
    }
  }
  const ms = (Array.isArray(milestones) ? milestones : []).slice(0, 6);
  if (ms.length) {
    const lines = ms.map((m) => {
      const d = String(m.day || '').slice(5) || String(m.createdAt || '').slice(5, 10);
      return `${d} ${String(m.text || '').slice(0, 48)}`;
    });
    parts.push(`几次转折：${lines.join('；')}。`);
  }
  // 稳定画像：profile 类的条目直接引一句（它们本来就是「关于他的总结」）
  const profiles = (Array.isArray(semantic) ? semantic : []).filter((m) => m.kind === 'profile');
  for (const p of profiles.slice(0, 2)) {
    parts.push(`关于他：${String(p.text || '').slice(0, 120)}`);
  }
  let out = parts.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}

/**
 * 从一组记忆里挑出里程碑，按时间排序，同一个 kind 的重复项只留最强的。
 *
 * 为什么要去重（同 kind）：人在讲自己故事时不会说「我确立关系了」八遍。
 * 同类型里程碑只保留置信度最高 + 最早的那条 —— 最早的那次才是「起点」。
 */
export function collectMilestones(entries, { perKind = 1, minConfidence = 0.6 } = {}) {
  const picked = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const ms = detectMilestone(e?.text, { self: e?.self === true });
    if (!ms || ms.confidence < minConfidence) continue;
    const key = ms.kind;
    const cand = {
      id: e.id,
      day: String(e.day || ''),
      at: Number(e.at) || Number(e.createdAt) || 0,
      text: String(e.text || ''),
      w: Number(e.w) || Number(e.importance) / 5 || 0.6,
      ...ms,
    };
    const list = picked.get(key) || [];
    list.push(cand);
    picked.set(key, list);
  }
  const out = [];
  for (const [, list] of picked) {
    list.sort((a, b) => (b.confidence - a.confidence) || (a.at - b.at));
    out.push(...list.slice(0, perKind));
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 自传体一致性检查：叙事有没有被新事实打脸。
 *
 * 场景：画像里写着「他讨厌猫」，但最近他说「我家养了只猫」。
 * 人遇到这种情况会「改写过去」（hindsight bias + reconsolidation），
 * 而不是两条并存。这里只负责**指出冲突**，改写交给 reviseFact。
 */
export function findNarrativeConflicts(semantic, { recentDays = 7, nowMs = Date.now() } = {}) {
  const list = Array.isArray(semantic) ? semantic : [];
  const profiles = list.filter((m) => m.kind === 'profile' || m.kind === 'core');
  const cutoff = nowMs - recentDays * 86400000;
  const fresh = list.filter((m) => Number(m.createdAt || m.at) >= cutoff && m.kind !== 'profile');
  const conflicts = [];
  for (const p of profiles) {
    const pText = String(p.text || '');
    // 只查「否定 ↔ 肯定」这一种最容易打脸的冲突
    const negs = pText.match(/(?:不|讨厌|怕|拒绝)([\u4e00-\u9fa5]{1,6})/gu) || [];
    for (const ng of negs) {
      const obj = ng.replace(/^(?:不|讨厌|怕|拒绝)/u, '');
      // 长度门槛只能挡 0，不能挡 1 —— 「讨厌猫」「怕狗」「不吃香菜」里的宾语
      // 绝大多数就是单字。写 obj.length < 2 会把这类冲突全漏掉（实测「他讨厌猫」
      // vs「我家养了只猫」被判成无冲突，最典型的一类打脸反而检不出来）。
      if (!obj) continue;
      for (const f of fresh) {
        const fText = String(f.text || '');
        if (!fText.includes(obj)) continue;
        if (/(不|讨厌|怕|拒绝)/u.test(fText)) continue; // 同向，不算冲突
        conflicts.push({
          profileId: p.id,
          factId: f.id,
          object: obj,
          profileText: pText.slice(0, 80),
          factText: fText.slice(0, 80),
        });
      }
    }
  }
  return conflicts.slice(0, 8);
}
