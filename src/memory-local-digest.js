// 本地完整巩固器：不调模型也能真的「提炼」，而不是只抄一句原文。
//
// ── 为什么要有这一层（和另外两层的分工）────────────────────────────
//   ① memory-core 的 consolidateDay —— 最小版：每人当天挑「情绪最重那一句原文」
//      抄进语义层。零规则、零成本，效果天花板是「记住了 500 句话，说不出我爸叫什么」。
//   ② 本文件 digestDay —— 完整本地版：规则抽取事实 + 跨天合并 + 属性冲突修正
//      + 习惯聚合 + 画像合成。跑在 CPU 上、毫秒级、完全确定，永远不会因为
//      模型挂了而空手而归。
//   ③ memory-consolidate 的 consolidateDayWithModel —— 模型版：真的「理解」，
//      能写出「他嘴上硬心里软」这种规则给不出的判断。模型版失败 → 降到本文件，
//      本文件也不行（当天全是噪声）→ mode='noise-only'。
//
// ── 为什么规则抽取值得做（不是「不如模型所以别做」）──────────────────
//   陪伴场景里有大量事实是**高度模板化**的：「我叫 X」「我住在 X」「我喜欢 X」
//   「我在做 X」。模型抽这些是浪费一次几十秒的调用；而这类事实恰恰是
//   「她是真的记得我」最扎眼的部分 —— 说不出主人叫什么，比说不出他性格更致命。
//   规则抽不出的（情绪、关系张力、隐含偏好）交给模型版，两层互补。
//
// ── 本地抽取的三条硬规则（防虚构症）────────────────────────────────
//   1. 只抽**用户自己说的**（非 self）。我自己说的话不是关于他的事实。
//   2. 只抽**明确的陈述句式**。疑问句、反问句、假设句一律不抽 ——
//      「我是不是该辞职」不是「他想辞职」。
//   3. 每条事实都带 derivedFrom（来自哪几条原话）。没有出处的不许进库。
//
// ── 属性冲突：本地版的「再巩固」───────────────────────────────────
//   他说住北京，三个月后说搬到上海。最小版会把两条都记着，然后两条同时被检索到，
//   她就永远在「北京还是上海」之间摇摆 —— 这是陪伴场景里最伤信任的一种错。
//   所以每条事实带一个 attr（profile.city / pref.like / ...）：
//   同 attr + 同人 + 文本变了 → 走 reviseFact 改写，旧文本进 revisions 可回溯。

import { shouldEncodeEpisode, emotionWeight } from './memory-core.js';

/** 单条原话里截取的对象最长多少字（再长基本是整句复述，抽出来也是垃圾）。 */
const OBJ_MAX = 20;
/** 一句话里最多抽几条事实（「我叫X住Y做Z喜欢W」这种堆叠句在 QQ 上很常见）。 */
const MAX_FACTS_PER_ROW = 2;
/** 习惯聚合：同一个动作词要出现在这么多个不同的日子里才算「习惯」。 */
const HABIT_MIN_DAYS = 3;
/** 习惯聚合往回看几天。 */
const HABIT_LOOKBACK_DAYS = 7;

// ── 规则表 ───────────────────────────────────────────────────────────
//
// attr 是给冲突检测用的：同 attr 不同值 = 他改口了，要改写不要并存。
// build 返回 null 表示「认出来了但不当事实写」（事件类交给习惯聚合）。
// 顺序有意义：越具体的越靠前（「我是做设计的」必须先于「我是你老公」）。
const FACT_RULES = [
  {
    attr: 'profile.name', kind: 'fact', imp: 5,
    re: /^我(?:的名字)?(?:叫|是叫)\s*([^\s，,。！!？?；;、]{1,10})/u,
    build: (m) => `他叫${trimObj(m[1], 10)}`,
  },
  {
    attr: 'profile.age', kind: 'fact', imp: 4,
    re: /^我(?:今年|已经|都)?\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*(?:岁|周岁)/u,
    build: (m) => { const n = cnNumber(m[1]); return n ? `他今年 ${n} 岁` : null; },
  },
  {
    attr: 'profile.job', kind: 'fact', imp: 4,
    re: /^我(?:的)?(?:工作)?是(?:做|干)\s*([^\s，,。！!？?；;、]{2,12})的/u,
    build: (m) => `他的工作是${trimObj(m[1], 12)}`,
  },
  {
    attr: 'profile.job', kind: 'fact', imp: 4,
    re: /^我在\s*([^\s，,。！!？?；;、]{2,12}?)\s*(?:上班|工作|实习|上学|读书|读研|读大学|读高中)/u,
    build: (m) => `他在${trimObj(m[1], 12)}`,
  },
  {
    attr: 'profile.city', kind: 'fact', imp: 4,
    re: /^我(?:现在|目前|最近)?\s*(?:住在|家在|老家在)\s*([^\s，,。！!？?；;、]{2,10})/u,
    build: (m) => `他住在${trimObj(m[1], 10)}`,
  },
  {
    attr: 'profile.birthday', kind: 'fact', imp: 4,
    re: /^我(?:的)?生日(?:是|在)?\s*([\d一二三四五六七八九十]{1,2}\s*月\s*[\d一二三四五六七八九十]{1,2}\s*[日号]?)/u,
    build: (m) => `他的生日是${m[1].replace(/\s+/g, '')}`,
  },
  {
    attr: 'pref.dislike', kind: 'preference', imp: 3,
    re: /^我(?:很|特别|超级|真的)?(?:不喜欢|讨厌|受不了|反感)\s*([^\s，,。！!？?；;、]{1,20})/u,
    build: (m) => `他不喜欢${trimObj(m[1])}`,
  },
  {
    attr: 'pref.like', kind: 'preference', imp: 3,
    re: /^我(?:最|超级|超|很|特别|真的)?(?:喜欢|爱|中意|偏爱)\s*([^\s，,。！!？?；;、]{1,20})/u,
    build: (m) => `他喜欢${trimObj(m[1])}`,
  },
  {
    attr: 'pref.want', kind: 'preference', imp: 3,
    re: /^我(?:真的|好|很|还)?(?:想要|想买|想学|想去|想听|想看|想吃)\s*([^\s，,。！!？?；;、]{1,20})/u,
    build: (m) => `他想要${trimObj(m[1])}`,
  },
  {
    attr: 'doing.now', kind: 'event', imp: 3,
    re: /^我(?:最近|现在|正在|这两天|最近都)?在\s*(?:做|写|搞|弄|开发|学|研究)\s*([^\s，,。！!？?；;、]{2,20})/u,
    build: (m) => `他最近在做${trimObj(m[1])}`,
  },
  {
    attr: 'have.thing', kind: 'fact', imp: 3,
    // 量词要留在捕获组里：「我养了一只猫」抽成「他有猫」会丢掉「养」和「一只」，
    // 下次问「你养的是什么」她就答不上来。动词也一起留，读着才像人说的话。
    re: /^我(?:家)?(养了|有|买了|入手了)(一?[只个条台辆盆部本块把][^\s，,。！!？?；;、]{1,10})/u,
    build: (m) => ({ 养了: `他养了${m[2]}`, 有: `他有${m[2]}`, 买了: `他买了${m[2]}`, 入手了: `他买了${m[2]}` })[m[1]] || `他有${m[2]}`,
  },
  {
    attr: 'fear', kind: 'preference', imp: 3,
    re: /^我(?:很|有点|特别|真的)?(?:害怕|怕|担心)\s*([^\s，,。！!？?；;、]{1,16})/u,
    build: (m) => `他害怕${trimObj(m[1], 16)}`,
  },
  {
    // 关系类两种词序都要认：「我是你老公」是自称，「你是我老婆」是给我安的位置。
    // 后者不能省 —— 陪伴场景里真正改变相处方式的是「他把我当什么」。
    attr: 'relation', kind: 'relationship', imp: 5,
    re: /^(我|你)(?:才|真的|本来就|一直)?是(?:我|你)的?([^\s，,。！!？?；;、]{1,6})/u,
    build: (m) => (m[1] === '我'
      ? `他自称是我的${trimObj(m[2], 6)}`
      : `他把我当成他的${trimObj(m[2], 6)}`),
  },
  {
    attr: 'address.me', kind: 'relationship', imp: 4,
    re: /^(?:你)?(?:以后|要|得|就)?叫我([^\s，,。！!？?；;、]{1,8})/u,
    // 「叫我阿浩就行」的尾巴要削掉：句尾语气垫词不是名字的一部分，
    // 留着会让画像里出现一个叫「阿浩就行」的人。
    build: (m) => {
      const name = String(m[1] || '')
        .replace(/(?:就行|就好了|好了|啦|吧|哈|嘛|呗|呀|啊)+$/u, '')
        .trim();
      return name ? `他让我叫他「${name}」` : null;
    },
  },

  // ── 他对我的要求（陪伴场景里最该记住的一类）────────────────────────
  //
  // 这是拿两天真实流水（199 条）跑出来的结论：真实对话里「我是什么人」很少，
  // 「你要怎样对我」极多 ——「你多发表情包啊」「你能不能对我更亲昵些」
  // 「记得写日记哦」「别跳过我的话」。这些恰恰是**改变相处方式**的东西，
  // 比「他住在哪」更影响她做得好不好。所以单独一组规则，attr 用 `demand.*`。
  {
    attr: 'demand.do', kind: 'preference', imp: 4,
    // 多/少必须抓进捕获组再判断 —— 之前的写法用 m[0] 开头去测「多」，
    // 但 m[0] 是从「你」开始的，于是「你多发表情包啊」被记成「他希望我少发表情包」。
    // 意思记反比不记更糟，所以这条单独钉住。
    re: /^(?:你)?(?:以后|下次|要|得)?(多|少)\s*([^\s，,。！!？?；;、]{1,16})/u,
    build: (m) => {
      const body = trimObj(m[2], 16);
      return body ? `他希望我${m[1]}${body}` : null;
    },
  },
  {
    attr: 'demand.stop', kind: 'preference', imp: 4,
    re: /^(?:你)?(?:以后|下次|千万)?(?:别|不要|不准)\s*([^\s，,。！!？?；;、]{1,16})/u,
    build: (m) => {
      const body = trimObj(m[1], 16);
      return body ? `他希望我别${body}` : null;
    },
  },
  {
    attr: 'demand.do', kind: 'preference', imp: 4,
    re: /^(?:你)?(?:能不能|可不可以|要不你)\s*([^\s，,。！!？?；;、]{1,16})/u,
    build: (m) => {
      const body = trimObj(m[1], 16);
      return body ? `他希望我${body}` : null;
    },
  },
  {
    attr: 'demand.remember', kind: 'preference', imp: 4,
    re: /^(?:你)?(?:要|一定|千万)?记得\s*([^\s，,。！!？?；;、]{1,16})/u,
    build: (m) => {
      const body = trimObj(m[1], 16);
      return body ? `他要我记得${body}` : null;
    },
  },
];

// 事件类：认出来但不当事实写，交给习惯聚合（「他经常加班」比「他今天加班」有用得多）。
// 这些词在 3 个以上不同日子里出现 → 合成一条「他经常 X」。
const HABIT_WORDS = [
  '加班', '熬夜', '失眠', '上班', '上课', '打游戏', '写代码', '改bug', '开会',
  '出差', '健身', '跑步', '喝酒', '抽烟', '吃外卖', '做饭', '刷题', '考试',
  '赶due', '改需求', '调试', '修bug',
];

// 中文数字 → 阿拉伯。只处理 0-99，够用（年龄、生日月份）。
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function cnNumber(token) {
  const s = String(token ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  if (s.length === 1 && s in CN_DIGITS) return CN_DIGITS[s];
  return null;
}

/** 截断对象 + 去掉明显的尾巴（「那种」「的感觉」「啊」），否则抽出来读着像残句。 */
function trimObj(raw, max = OBJ_MAX) {
  let s = String(raw ?? '').trim();
  s = s.replace(/(?:那种|这种感觉|的感觉|的样子)$/u, '');
  s = s.replace(/[啊呀呢吧嘛哈]+$/u, '');
  return s.slice(0, max);
}

/** 疑问句 / 假设句 / 否定前置：这类句子里的「我」不是陈述事实。 */
const NOT_ASSERTION = /[?？]$|^(?:如果|假如|要是|万一|难道|是不是)|(?:吗|么|呢)$/u;

/**
 * 疑问词的「句子中间」版本。
 *
 * 光看句尾标点不够：「我叫什么来着？我叫小林」被切句后，
 * 前半句结尾是「来着」不是「么」，规则就会把「什么来着」当成名字抽出来，
 * 于是她记下一个叫「什么来着」的人 —— 这是本文件里最丢人的一种错。
 * 所以只要小句里出现疑问代词，整句跳过。
 */
const HAS_QUESTION_WORD = /(?:什么|怎么|为什么|哪|谁|多少|几个|多久|哪天|是否)/u;

/**
 * 从一条原话里抽事实。
 *
 * 返回 [{ attr, kind, imp, text }]，一条都没有就是 []。
 * 纯函数，不碰 store —— 单测直接喂字符串。
 */
export function extractFacts(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  // 切句必须包含逗号。真实语料里事实几乎不在句首：
  //   「记得写日记哦，还有我是你老公」—— 只按句号切，`^我` 永远匹配不到；
  //   「我叫Yoki，在做机器人」—— 不切逗号只能抽到第一段。
  // 这条是拿两天真实流水（199 条）跑出来的：命中率原本只有 1%，就是因为卡在逗号上。
  const clauses = raw
    .split(/[。！!？?；;，,、\n]+/u)
    .map((s) => s.trim().replace(/^[:\s]+/u, ''))
    .filter(Boolean);
  const out = [];
  for (const clause of clauses) {
    if (out.length >= MAX_FACTS_PER_ROW) break;
    if (NOT_ASSERTION.test(clause)) continue;
    // 疑问代词出现就不再往下想 —— 宁可漏抽，不许把「什么来着」当成他的名字。
    if (HAS_QUESTION_WORD.test(clause)) continue;
    for (const rule of FACT_RULES) {
      const m = clause.match(rule.re);
      if (!m) continue;
      const built = rule.build(m);
      if (!built) break; // 认出来但不当事实（规则自己决定跳过）
      const body = built.trim();
      if (!body || body.length < 3) break;
      // 同一个 attr 已经抽到过（「我喜欢A，我喜欢B」）—— 只保留第一条，
      // 否则一次巩固就写满 MAX_FACTS，把别的信息挤掉。
      if (out.some((f) => f.attr === rule.attr)) break;
      out.push({ attr: rule.attr, kind: rule.kind, imp: rule.imp, text: body, clause });
      break; // 一个小句只匹配最具体的那条规则
    }
  }
  return out;
}

/**
 * 从一批情景行里抽事实，并带上溯源。
 *
 * rows 是 store.readDay(day) 的原始行（必须带 i 序号映射，见 digestDay）。
 */
export function extractFactsFromRows(rows) {
  const facts = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r || r.self === true) continue;
    const gate = shouldEncodeEpisode(r.text || '', { self: false });
    if (!gate.keep) continue;
    for (const f of extractFacts(r.text)) {
      const key = `${f.attr}|${f.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        ...f,
        who: String(r.who || r.speakerId || ''),
        from: [{ day: r.day || '', idx: r.i - 1, at: Number(r.at) || 0, text: String(r.text || '').slice(0, 60) }],
      });
    }
  }
  return facts;
}

/**
 * 画像合成：不是「理解」，是**统计**。
 *
 * 人对他人的印象有一半来自非内容线索：什么时候找你说话、说话长短、
 * 情绪起伏大不大。这些完全不需要模型 —— 数一数就有。
 */
export function synthesizeProfile(rows, { name = '' } = {}) {
  const list = (rows || []).filter((r) => r && r.text && r.self !== true);
  if (list.length < 3) return '';
  const hours = new Array(24).fill(0);
  let chars = 0;
  let emo = 0;
  for (const r of list) {
    const h = new Date(Number(r.at) || 0).getHours();
    if (Number.isFinite(h) && h >= 0 && h < 24) hours[h] += 1;
    chars += String(r.text).length;
    emo += emotionWeight(r.text);
  }
  // 找连续 3 小时窗口里最热闹的那段（「他常在 22-01 点找你」比「最活跃是 23 点」好读）
  let bestStart = 0;
  let bestSum = -1;
  for (let h = 0; h < 24; h += 1) {
    const sum = hours[h] + hours[(h + 1) % 24] + hours[(h + 2) % 24];
    if (sum > bestSum) { bestSum = sum; bestStart = h; }
  }
  const window = `${bestStart}-${(bestStart + 3) % 24}`;
  const avgLen = Math.round(chars / list.length);
  const avgEmo = emo / list.length;

  const bits = [];
  if (bestSum >= Math.max(2, list.length * 0.4)) bits.push(`他常在 ${window} 点出现`);
  if (avgLen <= 8) bits.push('说话很短');
  else if (avgLen >= 40) bits.push('一次会说很长一段');
  if (avgEmo >= 2.2) bits.push('情绪起伏大，容易把话说重');
  else if (avgEmo <= 1.2) bits.push('说话平，不太表露情绪');
  if (!bits.length) return '';
  return `${name ? `${name}：` : ''}${bits.join('，')}。（本地统计，不是他的自述）`;
}

/**
 * 习惯聚合：同一个动作词在 ≥3 个不同日子出现 → 「他经常 X」。
 *
 * 为什么值得单独做：单天的事件（「今天加班」）一天后就过期，
 * 但「他经常加班」是**跨时间的性质**，正是长时记忆该装的东西。
 */
export function aggregateHabits(store, day, { lookbackDays = HABIT_LOOKBACK_DAYS, minDays = HABIT_MIN_DAYS } = {}) {
  const days = typeof store.listDays === 'function' ? store.listDays() : [];
  const window = days.filter((d) => d <= day).slice(-Math.max(1, lookbackDays));
  if (!window.length) return [];
  const hitDays = new Map(); // word → Set(day)
  for (const d of window) {
    let rows = [];
    try { rows = store.readDay(d) || []; } catch { rows = []; }
    for (const r of rows) {
      if (!r || r.self === true) continue;
      const t = String(r.text || '');
      for (const w of HABIT_WORDS) {
        if (!t.includes(w)) continue;
        if (!hitDays.has(w)) hitDays.set(w, new Set());
        hitDays.get(w).add(d);
      }
    }
  }
  const out = [];
  for (const [word, set] of hitDays) {
    if (set.size < minDays) continue;
    out.push({ text: `他经常${word}`, attr: `habit.${word}`, days: set.size, kind: 'fact', imp: 3 });
  }
  return out.sort((a, b) => b.days - a.days);
}

/**
 * 主入口：本地完整巩固一天。
 *
 * 与最小版的差别（也是它值得存在的原因）：
 *   最小版：1 人 1 天 → 最多 1 条原文抄写
 *   本文件：N 人 1 天 → 规则抽取的事实 + 属性冲突改写 + 习惯聚合 + 画像
 *
 * 幂等：同一天跑两遍，第二遍全部走「强化 / 判定无变化」，不会翻倍。
 */
export function digestDay(store, day, { log = () => {}, now = () => Date.now(), habits = true, markProgress = true } = {}) {
  const raw = store.readDay(day) || [];
  if (!raw.length) return { day, learned: 0, reinforced: 0, revised: 0, habits: 0, episodic: 0, mode: 'empty' };

  // 带上 i 序号给溯源用（1-based，和模型版一致）
  const rows = raw.map((r, idx) => ({ ...r, i: idx + 1 }));

  // 按说话人分组：事实是关于「人」的，混在一起会把 A 的偏好记到 B 头上
  const byWho = new Map();
  for (const r of rows) {
    if (r.self === true) continue;
    const key = String(r.speakerId || r.who || '某人');
    if (!byWho.has(key)) byWho.set(key, []);
    byWho.get(key).push(r);
  }

  let learned = 0;
  let reinforced = 0;
  let revised = 0;
  // 每次判断都重新取一遍：remember 会往 semantic 里 push 新条目，
  // 拿一份开头拍下的快照会导致「今天新写的两条同 attr 事实互相看不见对方的冲突」。
  const current = () => store.allSemantic();

  const writeFact = (f) => {
    const who = String(f.who || '');
    const norm = f.text.replace(/\s+/g, '').toLowerCase();
    const pool = current();
    // ① 完全相同 → 强化
    const same = pool.find((m) => m.text && m.text.replace(/\s+/g, '').toLowerCase() === norm);
    if (same) {
      same.hits = (Number(same.hits) || 0) + 1;
      same.lastHitAt = now();
      reinforced += 1;
      return;
    }
    // ② 同 attr 不同值 → 他改口了，改写而不是并存（旧文本进 revisions）
    const conflict = f.attr
      ? pool.find((m) => m.attr === f.attr && m.kind !== 'profile' && String(m.who || '') === who)
      : null;
    if (conflict) {
      const next = store.reviseFact(conflict.id, f.text, { reason: `本地巩固：${day} 出现新说法` });
      if (next) {
        if (typeof store.patchItem === 'function') {
          store.patchItem(conflict.id, { attr: f.attr, factKind: f.kind, derivedFrom: f.from });
        }
        revised += 1;
        log(`[memory] 本地巩固改写：${String(conflict.text || '').slice(0, 20)} → ${f.text.slice(0, 20)}`);
        return;
      }
    }
    // ③ 新事实
    const item = store.remember(f.text, {
      kind: 'semantic',
      layer: 'long',
      who,
      importance: f.imp,
      at: f.from?.[0]?.at || now(),
      source: 'digest',
      tags: ['本地巩固', day, f.kind],
    });
    if (item && typeof store.patchItem === 'function') {
      store.patchItem(item.id, { attr: f.attr, factKind: f.kind, derivedFrom: f.from || [] });
    }
    learned += 1;
  };

  for (const [who, list] of byWho) {
    for (const f of extractFactsFromRows(list)) {
      writeFact({ ...f, who: f.who || who });
    }
    // 画像：够 3 句才写，一句话的人写不出「是个什么样的人」
    if (list.length >= 3) {
      const name = String(list[0]?.who || who);
      const profile = synthesizeProfile(list, { name });
      if (profile) {
        const cur = store.getProfile(name);
        // 画像会随统计漂移，只在明显不同才覆盖，否则每跑一次都在改
        if (!cur || similarity(cur.text, profile) < 0.8) {
          store.setProfile(name, profile, { importance: 4, tags: ['本地巩固', day] });
        }
      }
    }
  }

  let habitCount = 0;
  if (habits) {
    for (const h of aggregateHabits(store, day)) {
      const exists = store.allSemantic().some((m) => m.attr === h.attr && String(m.text || '') === h.text);
      if (exists) continue;
      writeFact({ ...h, who: '', from: [{ day, idx: 0, at: now(), text: '（跨天聚合）' }] });
      habitCount += 1;
    }
  }

  if (markProgress) store.markConsolidated(day);
  log(`[memory] 本地完整巩固 ${day}：${raw.length} 条 → 新学 ${learned}，强化 ${reinforced}，改写 ${revised}${habitCount ? `，习惯 ${habitCount}` : ''}`);
  return { day, learned, reinforced, revised, habits: habitCount, episodic: raw.length, mode: 'local-full' };
}

/** 粗略相似度：只在「画像要不要覆盖」这一处用，不需要精确。 */
function similarity(a, b) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const set = new Set();
  for (let i = 0; i < x.length - 1; i += 1) set.add(x.slice(i, i + 2));
  let hit = 0;
  let total = 0;
  for (let i = 0; i < y.length - 1; i += 1) { total += 1; if (set.has(y.slice(i, i + 2))) hit += 1; }
  return total ? hit / total : 0;
}

/**
 * 补跑：从水位往后逐天巩固（与最小版/模型版同签名，方便直接替换）。
 *
 * markProgress 默认 true（独立使用时自己管水位）。但桥接里跑的是
 * 「本地 → 模型」两段，水位只能由**后一段**推进 —— 否则本地这段先
 * markConsolidated 了，模型那段 `days.filter(d > through)` 就一天都捞不到，
 * 整个模型巩固被静默跳过（这个 bug 我改的时候差点写进去，测一下就露）。
 */
export function digestPending(store, {
  maxDays = 3,
  log = () => {},
  now = () => Date.now(),
  markProgress = true,
} = {}) {
  const days = typeof store.listDays === 'function' ? store.listDays() : [];
  const through = typeof store.consolidatedThrough === 'function' ? store.consolidatedThrough() : '';
  const todo = days.filter((d) => !through || d > through).slice(0, maxDays);
  const out = [];
  for (const day of todo) {
    try {
      out.push(digestDay(store, day, { log, now, markProgress }));
    } catch (error) {
      log(`[memory] 本地巩固 ${day} 失败：${error?.message ?? error}`);
    }
  }
  return out;
}
