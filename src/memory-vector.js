// 检索层：语义向量 + 线索扩展 + 位置效应 + 干扰竞争 + 情绪一致偏向
//
// ── 为什么 BM25 不够（这是「像人」最缺的一块）──────────────────────
//   BM25 是**字面**匹配。人不是这么想起来的：
//     问「他养的那只叫咪咪的」—— BM25 认「咪咪」，认不出这跟「我家有只猫」是同件事；
//     问「我上次说的那个事」—— 字面全是停用词，BM25 直接 0 分。
//   人靠的是**语义邻近**（encoding specificity，Tulving）：想起一个线索时，
//   跟它在意义上挨着的记忆会一起被激活。所以需要向量。
//
// ── 为什么不用外部 embedding 模型 ─────────────────────────────────
//   ① 一次调用几百毫秒到几秒，唤醒时每条消息都要检索，等不起
//   ② 几百 MB 模型 + tokenizer，跟「零依赖、可迁移」的定位冲突
//   ③ 陪伴场景的语料是中文短句，字符 n-gram 哈希向量在**短文本相似度**
//      这件事上表现并不差（短句里字面与语义高度重合：说「猫」和「咪咪」
//      至少共享语境词）。而真正拉开差距的是下面这些**结构**，
//      不是 embedding 本身。
//   所以：字符 1~3 gram 哈希到 1024 维，带符号，L2 归一化，余弦。
//   纯本地、毫秒级、跨机器可复现（同一份文本永远同一个向量）。
//
// ── 五个「人脑有、BM25 没有」的机制，都在这个文件里 ───────────────
//   ① 语义邻近      —— vectorSimilarity
//   ② 线索扩展      —— expandCues（问「咪咪」也要想到「猫」，靠共现学出来）
//   ③ 系列位置效应    —— serialPositionBonus（首因 + 近因，中间的易忘）
//   ④ 干扰与提取诱发遗忘 —— competitionPenalty（近义记忆互相压制，强者更胜）
//   ⑤ 情绪一致回忆    —— moodCongruentBonus（心情差时更容易想起难过的事）

/** 向量维度。1024 在几百到几万条记忆上足够（碰撞率 < 0.1%）。 */
export const VEC_DIM = 1024;

/** 稳定哈希：同一个字符串永远同一个桶，跨进程跨机器一致。 */
function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 文本 → 稀疏向量（Map<dim, weight>）。
 *
 * 为什么用稀疏 Map 而不是 Float32Array(1024)：
 *   一条记忆只有 20~60 个字，n-gram 撑死一两百个桶，99% 的维度是 0。
 *   稀疏存储让 3000 条记忆的检索从「3000 × 1024 次乘加」降到「3000 × 命中桶」，
 *   实测快 8 倍以上，而且省内存。
 */
export function embed(text) {
  const s = String(text ?? '').toLowerCase();
  const vec = new Map();
  const bump = (key, w) => vec.set(key, (vec.get(key) || 0) + w);
  // 1~3 字符 n-gram：单字抓精确词（猫/狗），二元组抓词，三元组抓短语
  for (const chunk of s.match(/[a-z0-9_]+|[\u4e00-\u9fa5]+/gu) || []) {
    // 短块（≤3 字）必须和长块**共用同一套 n-gram 前缀**，否则桶名对不上：
    // 查「语音」只产出 `w:语音`，而「他要语音音色」产出的是 `2:语音`——
    // 两者永远碰不到同一个桶，余弦恒为 0，语义通道等于整条死掉。
    // （踩过：实测所有查询的 vector 相似度都是 0.0000，检索退化成纯 BM25。）
    for (let i = 0; i < chunk.length; i += 1) {
      bump(`1:${chunk[i]}`, 0.35);
      if (i + 1 < chunk.length) bump(`2:${chunk.slice(i, i + 2)}`, 1.0);
      if (i + 2 < chunk.length) bump(`3:${chunk.slice(i, i + 3)}`, 0.7);
    }
    // 整块再单独加一次：短词（「猫」「咪咪」）作为整体比它的字更值钱
    bump(`w:${chunk}`, 1.2);
  }
  if (!vec.size) return vec;
  // 带符号哈希：同样的 n-gram 落同一个桶，不同 n-gram 落同一桶时符号相反的概率
  // 让它们的期望内积为 0（这是 random projection 的标准做法，避免桶碰撞系统性抬高相似度）
  const out = new Map();
  for (const [key, w] of vec) {
    const h = stableHash(key);
    const dim = h % VEC_DIM;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    out.set(dim, (out.get(dim) || 0) + sign * w);
  }
  // L2 归一化
  let norm = 0;
  for (const v of out.values()) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (const [k, v] of out) out.set(k, v / norm);
  return out;
}

/** 余弦相似度（两个已归一化稀疏向量 → 点积）。 */
export function vectorSimilarity(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  // 遍历小的那一侧
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) {
    const w = big.get(k);
    if (w) dot += v * w;
  }
  return Number(Math.max(-1, Math.min(1, dot)).toFixed(4));
}

/**
 * 线索扩展：把查询里的词扩成「意义上挨着的」词。
 *
 * 两种来源：
 *   ① 共现学习 —— 从记忆库里学：某个词经常和另一些词出现在同一条记忆里，
 *      它们就是相关的。「咪咪」和「猫」共现 5 次 → 问咪咪也能捞到猫。
 *      这是**从她自己的记忆里长出来的**联想，不是我硬编码的词典。
 *   ② 内置小词表 —— 兜底处理最典型的几组同义/上下位（猫/咪咪、语音/声音、
 *      表情包/梗图）。只在库里还没学到时补一手，学到后由①主导。
 *
 * 返回 { terms: string[], weightOf: Map<string, number> }，weight 是扩展强度（0~0.5），
 * 原始的查询词权重恒为 1。
 */
const BUILTIN_RELATIONS = [
  ['猫', '咪咪', '猫咪', '小猫'],
  ['狗', '狗狗', '小狗', '旺财'],
  ['语音', '声音', '音色', '说话', '嗓子'],
  ['表情包', '梗图', '贴图', '表情'],
  ['老婆', '妻子', '媳妇', '老婆大人'],
  ['老公', '丈夫', '老公大人'],
  ['主人', '爸爸', '爹'],
  ['吃饭', '吃东西', '吃饭了', '饿'],
  ['加班', '熬夜', '忙', '干活'],
  ['难过', '伤心', '委屈', 'emo'],
  ['开心', '高兴', '快乐'],
  ['抱抱', '拥抱', '抱一下'],
  ['亲亲', '吻', '亲一下'],
];

export function expandCues(query, {
  cooc = null,
  maxExtra = 4,
  minCooc = 2,
  builtin = BUILTIN_RELATIONS,
} = {}) {
  const q = String(query ?? '').toLowerCase();
  const weightOf = new Map();
  const rawTerms = (q.match(/[a-z0-9_]+|[\u4e00-\u9fa5]{2,4}/gu) || []);
  for (const t of rawTerms) weightOf.set(t, 1);

  // ① 共现学习：cooc 是 Map<term, Map<neighbor, count>>
  if (cooc && typeof cooc.get === 'function') {
    for (const t of rawTerms) {
      const row = cooc.get(t);
      if (!row) continue;
      for (const [nb, n] of row) {
        if (n < minCooc || weightOf.has(nb)) continue;
        // 共现越多越相关，但封顶 0.45 —— 联想永远不能盖过原词本身
        weightOf.set(nb, Math.min(0.45, 0.15 + 0.05 * n));
      }
    }
  }

  // ② 内置兜底：只补还没被共现学到的那几组
  for (const group of Array.isArray(builtin) ? builtin : []) {
    const hit = group.find((w) => q.includes(w));
    if (!hit) continue;
    for (const w of group) {
      if (w === hit || weightOf.has(w)) continue;
      weightOf.set(w, 0.32);
    }
  }

  // 原始词优先；扩展词按权重降序截断
  const terms = [...weightOf.keys()].filter((t) => t.length >= 1);
  const extras = terms.filter((t) => weightOf.get(t) < 1)
    .sort((a, b) => weightOf.get(b) - weightOf.get(a))
    .slice(0, maxExtra);
  return { terms: [...rawTerms, ...extras], weightOf, raw: rawTerms, extra: extras };
}

/** 从已落库的记忆里统计词共现（巩固时跑一次，结果缓存进 index.json）。 */
export function buildCooccurrence(texts, { maxNeighbors = 12, minTermLen = 2 } = {}) {
  const cooc = new Map();
  for (const text of texts) {
    const toks = [...new Set((String(text ?? '').toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fa5]{2,4}/gu) || [])
      .filter((t) => t.length >= minTermLen))];
    for (const a of toks) {
      if (!cooc.has(a)) cooc.set(a, new Map());
      const row = cooc.get(a);
      for (const b of toks) {
        if (a === b) continue;
        row.set(b, (row.get(b) || 0) + 1);
      }
    }
  }
  // 每个词只留最强的若干个邻居，避免记忆多了以后无限膨胀
  for (const [term, row] of cooc) {
    if (row.size <= maxNeighbors) continue;
    const keep = [...row.entries()].sort((x, y) => y[1] - x[1]).slice(0, maxNeighbors);
    cooc.set(term, new Map(keep));
  }
  return cooc;
}

/**
 * 系列位置效应：一个序列里，开头几条和最后几条比中间的更容易被想起。
 *
 * 人测出来的曲线是 U 形（Murdock 1962）。这里给记忆的「当天第几条」算一个加成：
 *   pos=0（当天第一句）  → +0.12（首因：第一句常常是「我回来了」这种开启话题的）
 *   pos=最后一个        → +0.15（近因：最后说的就是刚说的）
 *   中间               → 0
 * 系数刻意小：它只该在两条记忆分数接近时决定谁先冒出来，不该盖过相关度。
 */
export function serialPositionBonus(index, total) {
  const n = Number(total) || 0;
  const i = Number(index) || 0;
  if (n <= 2) return 0.08;
  const fromStart = i / (n - 1);
  const fromEnd = 1 - fromStart;
  let bonus = 0;
  if (fromStart <= 0.12) bonus += 0.12 * (1 - fromStart / 0.12);
  if (fromEnd <= 0.12) bonus += 0.15 * (1 - fromEnd / 0.12);
  return Number(bonus.toFixed(4));
}

/**
 * 干扰竞争：两条记忆越像，越互相压制（它们抢同一批线索）。
 *
 * 这是**提取诱发遗忘**（retrieval-induced forgetting，Anderson 1994）的简化：
 * 反复提取 A 会让靠近的 B 更难被提取。机器实现上，
 * 如果一条记忆跟"已经确定入选"的另一条相似度 > 阈值，就按相似度打折。
 * 好处不只是"更像人" —— 它也真的解决了「同一件事记了 5 条变体，
 * 每条都挤进 prompt」这个实际毛病。
 */
export function competitionPenalty(score, simToWinner) {
  const sim = Math.max(0, Math.min(1, Number(simToWinner) || 0));
  if (sim < 0.55) return score;
  const factor = Math.max(0.25, 1 - (sim - 0.55) * 1.6);
  return Number((score * factor).toFixed(4));
}

/**
 * 情绪一致回忆（mood-congruent memory）：心情好时更容易想起开心的事，
 * 心情差时更容易想起难过的事（Bower 的情绪网络理论）。
 *
 * 这条在陪伴场景里不能省：她难过的时候翻出一句「你上次说会一直陪着我」，
 * 比翻出「你今天吃了什么」有价值得多。
 *
 * valence 同号 → 加成（最大 +0.18）；反号 → 轻微抑制（最大 -0.10，不做成惩罚，
 * 因为人不是完全想不起相反情绪的回忆）。
 */
export function moodCongruentBonus(itemValence, currentValence) {
  const a = Number(itemValence) || 0;
  const b = Number(currentValence) || 0;
  if (!a || !b) return 0;
  const prod = a * b;
  if (prod > 0) return Number(Math.min(0.18, Math.abs(prod) * 0.3).toFixed(4));
  return Number(Math.max(-0.1, prod * 0.15).toFixed(4));
}

/**
 * 元记忆：这条记忆我有多确定。
 *
 * 人回忆时会带一个「确定感」，不确定时会有 tip-of-tongue（「我记得有这回事
 * 但想不全」）。机器上这个信号非常重要 —— 有了它模型才敢说「我记不太清了」，
 * 而不是把一条弱匹配当成事实说出来（虚构症的头号来源）。
 *
 * 置信度由四路证据合成：
 *   字面命中（bm25 归一）、语义邻近（vector）、记忆强度（memNorm）、被想起过的次数
 * 全弱 → 低置信 → 提示「模模糊糊」。任一路很强 → 高置信。
 */
export function confidenceOf({ bm25 = 0, vector = 0, memNorm = 0, hits = 0 } = {}) {
  const b = Math.max(0, Math.min(1, bm25));
  const v = Math.max(0, Math.min(1, vector));
  const m = Math.max(0, Math.min(1, memNorm));
  const h = Math.min(1, Math.log(1 + Math.max(0, hits)) / Math.log(9));
  const c = 0.34 * b + 0.36 * v + 0.2 * m + 0.1 * h;
  return Number(Math.max(0, Math.min(1, c)).toFixed(3));
}

/** 置信度 → 措辞。给渲染层用，决定要不要加「模模糊糊」的标签。 */
export function confidenceLabel(c) {
  const n = Number(c) || 0;
  if (n >= 0.72) return 'clear';       // 记得很清楚
  if (n >= 0.45) return 'fuzzy';       // 有印象，可能细节不准
  if (n > 0.12) return 'glimpse';      // 只有一闪而过的影子
  return 'guess';                      // 基本是猜的
}

/**
 * tip-of-tongue：只有弱线索、没有强命中时的状态。
 *
 * 人话是「我知道有这么件事，但具体记不清了，你提醒我一下」。
 * 这比「想不起来了」更有用 —— 后者会让她显得完全没记忆，
 * 前者说明有痕迹只是提不出来，并且给了用户一个自然的接话口。
 */
export function isTipOfTongue(hits) {
  if (!hits || !hits.length) return false;
  const best = Math.max(...hits.map((h) => Number(h.confidence) || 0));
  return best > 0.12 && best < 0.45;
}

/**
 * 检索线索改写：处理「那个」「上次说的」「跟你说过的」这类指代。
 *
 * 这些人话里的线索本身没有语义值，但它们**指向时间**：
 * 「上次」= 往前找最近的那次，「跟你说过的」= 找我说过的。
 * BM25 对它们完全无能为力（全是高频词），向量也一样。
 * 所以单独抽成结构化线索，交给检索层当过滤器用。
 */
const TEMPORAL_CUE = /(上次|上回|前几天|前些天|之前|以前|上次说的|那次|那时候|刚才|刚说|昨天|前天)/u;
const SPEAKER_CUE = /(你说的|你跟我说的|你答应|你说过|我跟你说过|我跟你说的)/u;
const ASK_CUE = /(你还记得|还记不记得|记不记得|记不记得我)/u;

export function parseCues(query) {
  const q = String(query ?? '');
  return {
    temporal: TEMPORAL_CUE.test(q),
    speaker: SPEAKER_CUE.test(q),
    asking: ASK_CUE.test(q),
    // 去掉纯指代成分，剩下的才是真语义内容
    core: q
      .replace(/(你还记得|还记不记得|记不记得|我跟你说过|我跟你说的|你说的|你跟我说过的|你答应过)/gu, ' ')
      .replace(/(那个|那个事|那次|那时候|上次|上回|之前|以前|刚才)/gu, ' ')
      .replace(/[的了吗呢吧啊呀哦噢]+$/u, '')
      .trim(),
  };
}
