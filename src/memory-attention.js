// 编码层：注意力门控 + 情绪标记 + 习惯化 + 自我参照
//
// ── 为什么单独一层（人的「编码」不是全录）────────────────────────────
//   memory-core 里原来的 shouldEncodeEpisode 只做「别把噪声存进去」。
//   那只是最粗的一道筛子。人真正记住什么，由四件事共同决定：
//
//   ① 注意力（是否能吸引注意）—— 突然的、意外的、跟预期不符的
//   ② 情绪唤醒（arousal）—— 高唤醒（惊吓、激动、愤怒）会提高编码强度
//      杏仁核在情绪唤醒时给海马体打「这条重要」的标记（McGaugh 的调制假说）
//   ③ 自我参照（self-reference effect）—— 跟自己有关的记得最牢
//      一句「我妈今天住院了」比「今天下雨」重要得多，因为主语是他自己
//   ④ 习惯化（habituation）—— 同一个刺激反复出现，反应变弱
//      连说三次「在吃饭」，第三次几乎不该占记忆容量
//
//   这四条都是可计算的，不需要模型。所以这一层纯本地、毫秒级、确定可复现。
//
// ── 为什么不复用 memory-core 的 emotionWeight ────────────────────────
//   memory-core 会被这一层反过来 import，双向 import 会成环。
//   所以这里自带一份 valence/arousal 词表 —— 而且它和 memory-core 那份
//   目的不同：那份是「这句话多重」，这里要拆成 valence（正负）与
//   arousal（强弱）两个独立轴。情绪二维模型（Russell 的环状模型）说明
//   这两个轴不能混：「平静地爱你」（正、低唤醒）和「暴怒地骂你」
//   （负、高唤醒）在单一分数上可能撞在一起，两个轴上完全不同。

/** 正性词（valence > 0）。 */
const POS = [
  '开心', '高兴', '喜欢', '爱', '爱你', '想你了', '想你', '乖', '好棒', '厉害',
  '可爱', '温柔', '舒服', '放心', '安心', '谢谢', '辛苦', '厉害', '满意', 'hehe',
  '哈哈', '嘿嘿', '抱抱', '亲亲', '老婆', '老公', '宝贝', '亲爱的', '主人',
  '在一起', '娶', '嫁', '陪你', '陪你', '成功', '搞定', '跑通了', '修好了',
];
/** 负性词（valence < 0）。 */
const NEG = [
  '难过', '伤心', '委屈', '生气', '烦', '烦死', '讨厌', '恨', '哭', '崩', '炸',
  '累死', '累', '熬夜', '失眠', '焦虑', '担心', '害怕', '怕', '疼', '病', '住院',
  '失败', '报错', '挂了', '坏了', '吵架', '滚', '算了', '失望', '孤独', '想死',
  '别走', '离开', '再见', '对不起', '抱歉',
];
/** 高唤醒标记：强度上去了，编码就加深。 */
const AROUSAL_MARKS = [
  '！！', '!!!', '？？', '?!', '……', '卧槽', '我靠', '救命', '快', '赶紧',
  '马上', '立刻', '千万', '一定', '真的', '超级', '特别', '非常', '太',
];
/** 自我参照词：主语是他自己 / 关于他的所有物。 */
const SELF_REF = ['我', '我的', '我家', '我妈', '我爸', '我老婆', '我对象', '咱们', '我们'];

function countHits(text, list) {
  let n = 0;
  for (const w of list) {
    if (!w) continue;
    let from = 0;
    while (true) {
      const i = text.indexOf(w, from);
      if (i < 0) break;
      n += 1;
      from = i + w.length;
      if (n > 40) return n;
    }
  }
  return n;
}

/**
 * 情绪二维分析。
 *
 * valence ∈ [-1, 1]：负到正
 * arousal ∈ [ 0, 1]：平静到激动
 *
 * valence 用「正词数 - 负词数 / 总情绪词数」而不是纯差：
 * 「又开心又难过」这种矛盾句应该是中性偏激（valence≈0, arousal 高），
 * 纯差会算成 0 但让人误以为是「平静」。
 */
export function moodOf(text) {
  const s = String(text ?? '');
  if (!s) return { valence: 0, arousal: 0 };
  const pos = countHits(s, POS);
  const neg = countHits(s, NEG);
  const total = pos + neg;
  const valence = total ? (pos - neg) / total : 0;
  let arousal = 0;
  arousal += Math.min(0.5, countHits(s, AROUSAL_MARKS) * 0.18);
  // 重复标点单独算：连打三个感叹号是典型的情绪溢出
  arousal += Math.min(0.25, (s.match(/[!！?？]{2,}/g) || []).length * 0.15);
  arousal += Math.min(0.2, (Math.abs(pos - neg) / Math.max(1, total)) * 0.2);
  // 短促的强负性（「烦」「操」）唤醒高但词数少，单独补一点
  if (neg && s.length <= 6) arousal += 0.2;
  return {
    valence: Number(valence.toFixed(3)),
    arousal: Number(Math.min(1, arousal).toFixed(3)),
  };
}

/** 累积用词频。习惯化的判定靠它：越常见的词越不新奇。 */
export function accumulateVocab(vocab, text) {
  const v = vocab instanceof Map ? vocab : new Map();
  for (const tok of String(text ?? '').toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fa5]{2,4}/gu) || []) {
    v.set(tok, (Number(v.get(tok)) || 0) + 1);
  }
  return v;
}

/**
 * 新奇度：这句话里的词有多「不常见」。
 *
 * 用 1 / (1 + log(1 + freq)) 的均值。没见过的词 freq=0 → 分数 1（最新奇）。
 * 这不是 TF-IDF，因为我们衡量的是「对他自己而言新奇」而不是「对语料而言罕见」，
 * 一个满口技术名词的人说「docker」不该比说「我妈」更新奇。
 */
export function noveltyOf(text, vocab) {
  const s = String(text ?? '').toLowerCase();
  const toks = s.match(/[a-z0-9_]+|[\u4e00-\u9fa5]{2,4}/gu) || [];
  if (!toks.length) return 0.5;
  let sum = 0;
  for (const t of toks) {
    const f = Number(vocab?.get?.(t)) || 0;
    sum += 1 / (1 + Math.log(1 + f));
  }
  return Number((sum / toks.length).toFixed(3));
}

/**
 * 习惯化折减：跟最近说过的话越像，越不该再占一份记忆。
 *
 * recentMaxSim 是「这句话跟最近 N 条的最大相似度」（0..1，由调用方用向量算）。
 * 相似度 1（原话重复）→ 权重乘 0.15；相似度 0 → 不折减。
 * 人的神经适应大概就是这个形状：重复刺激的反应按指数下降。
 */
export function habituate(weight, recentMaxSim) {
  const sim = Math.max(0, Math.min(1, Number(recentMaxSim) || 0));
  if (sim <= 0.35) return weight;
  const factor = Math.max(0.15, 1 - (sim - 0.35) * 1.3);
  return Number((weight * factor).toFixed(3));
}

/**
 * 编码分析：这是「该不该记、记多牢」的唯一入口。
 *
 * 返回：
 *   keep     是否落盘
 *   weight   编码强度（0.05~1.6），后面巩固时按它排序
 *   salience { novelty, surprise, selfRef, intensity, habituation }
 *   mood     { valence, arousal }
 *   reason   为什么（可观测，不静默）
 *
 * 与旧 shouldEncodeEpisode 的关系：这里是**升级替代**，噪声判定更全
 * （多了「纯重复」「只有标点」「占位符」的细分统计），并且多出四维显著性。
 * 旧函数保留是为了兼容与单测，新代码一律走这里。
 */
export function analyzeAttention(text, {
  self = false,
  vocab = null,
  recentMaxSim = 0,
  arousalFloor = 0,
} = {}) {
  const body = String(text ?? '').trim();
  const empty = { keep: false, weight: 0, salience: zeroSalience(), mood: { valence: 0, arousal: 0 }, reason: 'empty' };
  if (!body) return empty;

  // ── 噪声判定（比旧版更细，且每类单独计数）───────────────────────
  const bare = body.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!bare) return { ...empty, reason: 'punct-only' };
  if (/^(?:\[[^\]]{1,12}\]\s*)+$/u.test(body)) return { ...empty, reason: 'placeholder' };
  if (/^(.)\1{2,}$/u.test(bare)) return { ...empty, reason: 'repeated' };
  if (bare.length <= 4) {
    const stem = bare.replace(/(的|了|啦|呀|啊|吧|嘛|呢|哦|噢|嗯)+$/u, '');
    // 连续重复的字先压成一个再比：「哈哈」「嘿嘿」「好好」都是应声，
    // 但 filler 表里只有单字，不压就全漏过去（实测「哈哈」被当成正经内容存下来）。
    const squashed = stem.replace(/(.)\1+/gu, '$1');
    const filler = ['嗯', '哦', '噢', '啊', '哈', '呵', '嘿', '嘻', '额', '呃', '唔', '好', '行', 'ok', '对', '是', '在', '收到', '知道了', '明白了', '没事', '算了'];
    if (filler.includes(bare) || filler.includes(stem) || filler.includes(squashed)) return { ...empty, reason: 'filler' };
  }
  if (bare.length >= 4) {
    const counts = new Map();
    for (const ch of bare) counts.set(ch, (counts.get(ch) || 0) + 1);
    if (Math.max(...counts.values()) / bare.length > 0.6) return { ...empty, reason: 'repeated' };
  }

  // ── 四维显著性 ─────────────────────────────────────────────────
  const mood = moodOf(body);
  const novelty = noveltyOf(body, vocab);
  const selfRef = Math.min(1, countHits(body, SELF_REF) * 0.34);
  // 「意外度」用情绪强度近似：情绪越强，说明越偏离预期基线。
  // 真正的事件相关电位式 surprise 需要预测模型，这里不假装有。
  const surprise = Math.min(1, mood.arousal * 1.4 + (novelty > 0.85 ? 0.2 : 0));
  const lenBonus = Math.min(1, bare.length / 40);
  const intensity = Number(Math.min(1, 0.35 * mood.arousal + 0.3 * selfRef + 0.2 * lenBonus + 0.15 * novelty).toFixed(3));

  let weight = 0.5 + 0.22 * lenBonus + 0.18 * mood.arousal + 0.12 * selfRef + 0.08 * novelty;
  weight = habituate(weight, recentMaxSim);
  // 我自己说的话打折：我的回复是对他的反应，不是关于他的事实。
  // 原来打三折（×0.3）太狠 —— 实测「我今天说过什么立场」几乎全被挤出
  // 巩固窗口，模型只见到他见不到我。改成六折：仍然比他的话轻，
  // 但带自我参照词（我/我们/我的…）的话能保住一个及格的编码强度。
  if (self) weight = weight * 0.6;
  // 高唤醒硬下限：再重复的「我害怕」，也不能被习惯化压成噪声。
  if (Number(arousalFloor) > 0 && mood.arousal >= Number(arousalFloor)) {
    weight = Math.max(weight, 0.55);
  }
  weight = Number(Math.max(0.05, Math.min(1.6, weight)).toFixed(3));

  return {
    keep: true,
    weight,
    salience: {
      novelty,
      surprise: Number(surprise.toFixed(3)),
      selfRef: Number(selfRef.toFixed(3)),
      intensity,
      habituation: Number(Math.max(0, Math.min(1, recentMaxSim)).toFixed(3)),
    },
    mood,
    reason: self ? 'self' : 'ok',
  };
}

function zeroSalience() {
  return { novelty: 0, surprise: 0, selfRef: 0, intensity: 0, habituation: 0 };
}
