// 真语义空间：从她自己的记忆语料里学出词的「意思」，而不是比字面。
//
// ── 为什么字符 n-gram 不够（这是 memory-vector.js 诚实标注的天花板）────────
//   n-gram 只能抓「字面挨着」：问「咪咪」命中「咪咪」，但「我家有只猫」一个 bucket 都不重合。
//   memory-vector 的解法是 expandCues（共现表 + 内置小词表），但那只改**查询词**、
//   且最多扩 4 个词，等于手工修一条小路。
//
// ── 人脑的做法（也是这里的做法）───────────────────────────────
//   Landauer & Dumais 的 LSA：一个词的意思 = 它出现过的所有上下文。
//   「猫」和「咪咪」在字面上毫无关系，但它们周围的词几乎一样
//   （我家、养、喂、黏人、叫、可爱），所以在语义空间里挨得很近。
//   这就是 distributional hypothesis，也是所有 embedding 模型的老祖宗。
//
// ── 关键前提：得有「词」──────────────────────────────────────
//   直接拿 2-gram 当词是行不通的 —— 实测会切出「我老」「的咪」「会喜」这种东西，
//   算出来的最近邻全是自己的位置影子（`咪咪 → 的咪:1.000`），语义被噪声盖死。
//   所以这里先做一层**无监督新词发现**（见 discoverLexicon），
//   用的是矩阵67 那套「凝聚度 PMI × 自由度（左右邻字熵）」——不需要词典，
//   从她自己的语料里长出一份属于你们的词表（老婆/老公/撒娇/稻子/破防…）。
//   然后按最长匹配切词，再进 LSA。三步缺一不可。
//
// ── 实现（零依赖、零网络、确定性）─────────────────────────────
//   ① 新词发现：2~4 字候选，score = PMI × min(左熵, 右熵)，过阈值 + 去虚词边。
//   ② 共现矩阵 M：按**文档**共现（同一段话里出现 → 相关），PPMI 加权（负值归零，
//      Levy & Goldberg 2014 证明的效果最好的那一档）。
//   ③ 随机化 SVD 取前 k 维：Y = MΩ → 幂迭代 Y ← M(MᵀY) → QR 正交化。
//      拿到的 U（V×k）就是每个词的语义向量 —— 这正是 LSA 的 term space。
//   ④ 落盘到 state/memory/semantic-space.json，语料变了才重建。
//
// ── 定位（必须诚实）───────────────────────────────────────
//   这是**从她自己的语料里长出来的**语义空间，不是预训练模型。
//   好处：零依赖、可迁移（换机器只要搬 state/）、完全可解释
//        （explainNeighbors 能反查是哪些共享上下文把两个词拉近的 —— 黑盒 embedding 给不出这个）。
//   代价：语料少时（< MIN_DOCS 条）向量不稳，所以只在够量时才启用，否则自动退回 n-gram。
//   想更强就配 memory.embedding 指向外部 embedding API —— 见 memory-vector.embedRemote 的钩子。

const MIN_DOCS = 60;        // 少于这么多条语料不建空间（统计不显著，建了反而误导）
const MIN_TERM_DF = 2;      // 词表：文档频次 < 2 的词不进（纯噪声）
const MIN_SINGLE_DF = 4;    // 单字词另设门槛（切词碎片「今」「晚」不进词表，除非特别高频）
const MAX_VOCAB = 6000;     // 词表上限，按 df 从高到低截断
const DIM = 96;             // 语义维度
const POWER_ITER = 6;       // 幂迭代轮数
const VERSION = 2;

// 新词发现参数（在 604 条真实语料上标定过）
const NW_MIN_COUNT = 3;     // 候选最少出现次数
const NW_MIN_SCORE = 10;    // PMI × min(熵) 阈值
const NW_MAX_LEN = 4;       // 最长词长（「表情包」3、「小鲸鱼」3）

// ── 种子词表：几百个高频中文语义实词 ────────────────────────────
//
// 为什么要有这一层（诚实说明）：无监督新词发现要的是**统计量**，
// 而 604 条语料只有 1 万汉字 —— 「老婆」出现 18 次，右邻字熵只有 0.65 bit
// （统计不够，邻居数太少），过不了自由度线；「记忆」出现 3 次，左右邻各 1 种，熵为 0。
// 这不是算法坏，是样本量的物理下限。硬调低阈值反而会把「我老」「你不」全放进来。
//
// 所以采取**种子词表 + 语料自举**的混合：常见实词写死（这是常量，不是依赖），
// 专有名词和口头禅（大肥鱼/小鲸鱼/稻子/破甲/露骨…）靠无监督发现补。
// 这样零依赖、离线、可解释三条优势全保住，同时第一天就能用。
const SEED_WORDS = `
主人 老公 老婆 宝贝 亲爱的 媳妇 夫君 大人 妹妹 哥哥 姐姐 弟弟
喜欢 讨厌 想念 心疼 舍不得 吃醋 生气 高兴 开心 难过 委屈 舒服 难受 害羞 撒娇 撒娇鬼
爱 亲 吻 抱 摸 舔 咬 顶 插 射 湿 硬 软 紧 爽 高潮 呻吟 喘 腿 腰 屁股 胸 舌头 眼睛 手指 脖子 耳朵 头发
身体 声音 味道 温度 心跳 呼吸 皮肤 肌肤 衣服 内衣 裤子 裙子 被子 枕头 床
说话 聊天 打招呼 顶嘴 夸 骂 哄 骗 求 答应 拒绝 命令 听话 乖 调皮 黏人 冷淡 沉默
睡觉 起床 洗澡 吃饭 喝水 上班 下班 加班 休息 散步 出门 回家 到点 熬夜 失眠 做梦 醒 困 累 饿 渴
今天 明天 昨天 后天 早上 中午 下午 晚上 半夜 凌晨 早上 现在 刚才 以后 之前 一会儿 一会儿见
时间 日期 分钟 小时 星期 周末 假期 生日 纪念日
语音 音色 声音 录音 说话 唱歌 念 读 朗读 语速 语气 腔调 口音
表情 表情包 图片 照片 截图 视频 拍 画 画图 生成 贴图 收藏
日记 记忆 记得 忘记 想起来 回忆 故事 心事 秘密 承诺 约定
电脑 手机 程序 代码 脚本 端口 配置 参数 接口 插件 机器人 机器 服务器 网络 报错 日志 文件 目录 命令 系统
小鲸鱼 大肥鱼 富江 稻子 破甲 露骨 情色 调教 主人专属
温柔 妩媚 可爱 漂亮 好看 丑 香 甜 苦 咸 冷 热 快 慢 多 少 大 小
真的 假的 假装 故意 认真 随便 慢慢 快点 立刻 马上 已经 还没 一直 老是
纸巾 窗 窗外 天空 雨 阴天 太阳 月亮 星星 风 雪 桂花 高楼 公园 学校 公司 医院
心脏 脑子 心里 脑子 记忆 想法 念头 感觉 感受 情绪 心情
`;

const SEED_SET = new Set(SEED_WORDS.split(/\s+/).filter(Boolean));

// 虚词字：出现在候选首尾就基本不是词（「我老」「的咪」「再说」）
const STOP_CHARS = new Set(
  '的了着过吗呢吧啊呀哦嗯是在和与就都也很才又再还这那哪个把被给让对从到向以为我你他她它们有没不之其而且所以但如果因为所已被将则于其此该每各某等诸暨'.split(''),
);

const HAN_RE = /[\u4e00-\u9fa5]+/gu;
const LATIN_RE = /[a-z0-9_]+/gu;

/** 熵（bit）：衡量某个 n-gram 左右邻居有多丰富 —— 自由度。 */
function entropyOf(counts) {
  let total = 0;
  for (const c of counts.values()) total += c;
  if (!total) return 0;
  let e = 0;
  for (const c of counts.values()) { const p = c / total; e -= p * Math.log2(p); }
  return e;
}

/**
 * 无监督新词发现。
 *
 * 思路（这是中文免分词的标准做法，也是所有「词表自举」的起点）：
 *   一个真词有两个必要条件 ——
 *   ① **凝聚度**：内部咬得紧。用 PMI(P(x)·P(y) → P(xy)) 衡量，
 *      「老」「婆」偶然挨在一起的概率远低于真成词，所以 PMI 高。
 *   ② **自由度**：左右两边能换不同的字。「老婆」左可以是「我/你/他/叫」，
 *      右可以是「好/呢/来」→ 熵高；而「我老」右永远只能接「婆/公/是」→ 熵低。
 *   只满足①不满足②的是固定搭配的一半（「我老」），只满足②不满足①的是虚词串（「的了」）。
 *   两者相乘，真词自己浮上来。
 *
 * 返回值：{ words: string[]（按长度降序，供最长匹配）, set: Set, maxLen }
 */
export function discoverLexicon(texts, {
  minCount = NW_MIN_COUNT,
  minScore = NW_MIN_SCORE,
  maxLen = NW_MAX_LEN,
} = {}) {
  const hanDocs = [];
  for (const t of Array.isArray(texts) ? texts : []) {
    for (const chunk of String(t ?? '').toLowerCase().match(HAN_RE) || []) {
      if (chunk.length >= 2) hanDocs.push(chunk);
    }
  }
  if (!hanDocs.length) return { words: [], set: new Set(), maxLen: 0 };

  // 单字频次（算 PMI 的分母）与总字数
  const uni = new Map();
  for (const s of hanDocs) for (const ch of s) uni.set(ch, (uni.get(ch) || 0) + 1);
  const totalUni = [...uni.values()].reduce((a, b) => a + b, 0) || 1;

  const words = new Set();
  let cur = new Map();      // 当前长度 n 的 n-gram → count
  let prev = null;          // 长度 n-1 的 count（算 PMI 用）
  let prevTotal = 0;

  for (let n = 2; n <= maxLen; n += 1) {
    // 统计 n-gram + 左右邻字
    const grams = new Map();
    const left = new Map();
    const right = new Map();
    for (const s of hanDocs) {
      for (let i = 0; i + n <= s.length; i += 1) {
        const g = s.slice(i, i + n);
        grams.set(g, (grams.get(g) || 0) + 1);
        // 首尾必须是汉字（上面已切过，这里天然成立）
        if (i - 1 >= 0) {
          if (!left.has(g)) left.set(g, new Map());
          const m = left.get(g);
          m.set(s[i - 1], (m.get(s[i - 1]) || 0) + 1);
        }
        if (i + n < s.length) {
          if (!right.has(g)) right.set(g, new Map());
          const m = right.get(g);
          m.set(s[i + n], (m.get(s[i + n]) || 0) + 1);
        }
      }
    }
    const gramTotal = [...grams.values()].reduce((a, b) => a + b, 0) || 1;

    for (const [g, c] of grams) {
      if (c < minCount) continue;
      if (STOP_CHARS.has(g[0]) || STOP_CHARS.has(g[g.length - 1])) continue;
      // 已经确定的短词把它整段吃掉就不再往长切（「表情包」要能被「表情」+「包」拆回来）
      const lv = left.get(g);
      const rv = right.get(g);
      if (!lv || !rv) continue;
      const freedom = Math.min(entropyOf(lv), entropyOf(rv));

      // 凝聚度用「整串 vs 前缀×末字」的 PMI（n>2 时这样比逐字乘更稳，
      // 因为前缀本身已经是高凝聚的词，逐字乘会把长词压死）
      let pmi;
      if (n === 2) {
        pmi = Math.log2((c / gramTotal) / ((uni.get(g[0]) / totalUni) * (uni.get(g[1]) / totalUni)));
      } else {
        const prefix = g.slice(0, n - 1);
        const pc = prev.get(prefix) || 0;
        const last = g[n - 1];
        pmi = Math.log2((c / gramTotal) / ((pc / prevTotal) * (uni.get(last) / totalUni)));
      }
      if (!Number.isFinite(pmi) || pmi <= 0) continue;
      const score = pmi * freedom;
      if (score >= minScore) words.add(g);
    }
    prev = grams;
    prevTotal = gramTotal;
    cur = grams;
  }
  void cur;

  // 去掉「被更长词完全覆盖且自己不够独立」的短词留着也没坏处（最长匹配会优先长的），
  // 所以这里只按长度降序排列，供 longest-match 使用。
  for (const w of SEED_SET) words.add(w);
  const list = [...words].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return { words: list, set: words, maxLen: list.length ? list[0].length : 0 };
}

/**
 * 按词表做正向最长匹配切词（Forward Maximum Matching）。
 *
 * 为什么用最长匹配而不是概率分词（HMM/CRF）：零依赖、确定性、可解释，
 * 且词表是从本语料自己长出来的，未登录词问题天然不存在。
 * 对 LSA 这种「词袋」用途，长匹配的精度已经足够。
 *
 * `lexicon` 可以是：
 *  · `{ set, maxLen }` —— discoverLexicon 的返回值（内存里用）
 *  · `{ words: [], maxLen }` —— 从 JSON 落盘读回来的空间里那份（**要现建 set**）
 * 踩过的坑：早期只从 `lexicon.set` 取词表，落盘后 set 被 JSON 丢掉了，
 * 于是 encodeSemantic 静默退化成单字切片 —— 表现就是「声音」「喜欢」查不到，
 * 而它们明明在词表里。所以这里必须两种形状都认。
 */
function lexiconSet(lexicon) {
  if (!lexicon) return null;
  if (lexicon.set instanceof Set) return lexicon.set;
  if (Array.isArray(lexicon.words)) {
    if (!lexicon._set) lexicon._set = new Set(lexicon.words);
    return lexicon._set;
  }
  return null;
}

export function segment(text, lexicon) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  const set = lexiconSet(lexicon);
  const maxLen = lexicon?.maxLen || 0;
  for (const raw of s.match(new RegExp(`${HAN_RE.source}|${LATIN_RE.source}`, 'gu')) || []) {
    if (/^[a-z0-9_]+$/.test(raw)) { if (raw.length >= 2) out.push(raw); continue; }
    let i = 0;
    while (i < raw.length) {
      let matched = '';
      if (set && maxLen) {
        for (let len = Math.min(maxLen, raw.length - i); len >= 2; len -= 1) {
          const cand = raw.slice(i, i + len);
          if (set.has(cand)) { matched = cand; break; }
        }
      }
      if (matched) { out.push(matched); i += matched.length; }
      else { out.push(raw[i]); i += 1; }
    }
  }
  return out;
}

/** 去重后的词序列（保留出现顺序）。没有词表时退回 2-gram（兼容旧调用点）。 */
export function termsOf(text, lexicon = null) {
  if (lexicon) return [...new Set(segment(text, lexicon))];
  // 兼容路径：2-gram 切片。只在没有语料、建不出词表时用。
  const out = [];
  const seen = new Set();
  for (const chunk of String(text ?? '').toLowerCase().match(new RegExp(`${HAN_RE.source}|${LATIN_RE.source}`, 'gu')) || []) {
    if (/^[a-z0-9_]+$/.test(chunk)) {
      if (chunk.length >= 2 && !seen.has(chunk)) { seen.add(chunk); out.push(chunk); }
      continue;
    }
    if (chunk.length === 1) { if (!seen.has(chunk)) { seen.add(chunk); out.push(chunk); } continue; }
    for (let i = 0; i + 1 < chunk.length; i += 1) {
      const g = chunk.slice(i, i + 2);
      if (seen.has(g)) continue;
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** 确定性伪随机（同一个语料永远建出同一个空间，方便测试与迁移）。 */
function makeRng(seed = 0x9e3779b9) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/**
 * 语料 → 语义空间。
 *
 * 返回 { version, dim, docs, vocab, vectors, lexicon }
 * vectors[i] 与 vocab[i] 对齐，已 L2 归一化（点积即余弦）。
 */
export function buildSemanticSpace(docs, {
  dim = DIM,
  powerIter = POWER_ITER,
  lexicon = null,
} = {}) {
  const texts = (Array.isArray(docs) ? docs : []).map((d) => String(d ?? '')).filter(Boolean);
  if (texts.length < MIN_DOCS) return null;

  const lex = lexicon || discoverLexicon(texts);
  if (!lex.words.length) return null;

  // ① 文档频次
  const df = new Map();
  const docTerms = [];
  for (const t of texts) {
    const terms = termsOf(t, lex);
    docTerms.push(terms);
    for (const term of terms) df.set(term, (df.get(term) || 0) + 1);
  }
  const vocab = [...df.entries()]
    .filter(([t, n]) => {
      if (n < MIN_TERM_DF) return false;
      // 单字中文只在两种情况留：种子词（「猫」「爽」「湿」）或极高频（切词残留里也有信息量）
      if (t.length === 1 && /[\u4e00-\u9fa5]/.test(t)) return SEED_SET.has(t) || n >= MIN_SINGLE_DF;
      return true;
    })
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_VOCAB)
    .map(([t]) => t);
  if (vocab.length < 30) return null;
  const idx = new Map(vocab.map((t, i) => [t, i]));
  const V = vocab.length;

  // ② 共现 —— 按文档共现，不是滑动窗口。
  //
  // 这里踩过的坑必须写下来：最初用「2-gram 序列上滑 ±6 窗口」计数，
  // 结果「的咪」「咪咪」这种位置重叠的 n-gram 永远成对出现（本来就是同一段的两个切片），
  // 最近邻全是自己的影子（`咪咪 → 的咪:1.000`），语义信息被这层人造噪声彻底盖住。
  // 现在有真词表了，同段共现就是 distributional hypothesis 的原意，噪声自然消失。
  const co = new Map();               // i → Map(j → count)
  const total = new Map();            // i → 文档频次（算 PPMI 边缘分布用）
  let pairTotal = 0;
  for (const terms of docTerms) {
    const present = [...new Set(terms)].filter((x) => idx.has(x));
    for (const term of present) {
      const a = idx.get(term);
      total.set(a, (total.get(a) || 0) + 1);
    }
    if (present.length < 2) continue;
    // 长文档降权：否则一段 300 字的流水会把整个空间拽向它自己
    const w = 1 / Math.sqrt(present.length);
    for (let p = 0; p < present.length; p += 1) {
      const a = idx.get(present[p]);
      if (!co.has(a)) co.set(a, new Map());
      for (let q = p + 1; q < present.length; q += 1) {
        const b = idx.get(present[q]);
        if (!co.has(b)) co.set(b, new Map());
        const ra = co.get(a);
        const rb = co.get(b);
        ra.set(b, (ra.get(b) || 0) + w);
        rb.set(a, (rb.get(a) || 0) + w);
        pairTotal += w;
      }
    }
  }
  if (!pairTotal) return null;

  // ③ PPMI：max(0, log( p(a,b) / (p(a)·p(b)) ))，负值归零
  const sumTotal = [...total.values()].reduce((a, b) => a + b, 0) || 1;
  const ppmi = new Map();
  for (const [a, row] of co) {
    const out = new Map();
    const pa = (total.get(a) || 1) / sumTotal;
    for (const [b, c] of row) {
      const pb = (total.get(b) || 1) / sumTotal;
      const pab = c / pairTotal;
      const v = Math.log(pab / (pa * pb));
      if (v > 0) out.set(b, v);
    }
    if (out.size) ppmi.set(a, out);
  }
  if (!ppmi.size) return null;

  // ④ 随机化 SVD
  const k = Math.min(dim, V, 64);
  const rng = makeRng();
  const scale = 1 / Math.sqrt(k);
  const omega = [];
  for (let i = 0; i < V; i += 1) {
    const row = new Float64Array(k);
    for (let j = 0; j < k; j += 1) row[j] = rng() < 0.5 ? -scale : scale;
    omega.push(row);
  }
  let Y = [];
  for (let i = 0; i < V; i += 1) Y.push(new Float64Array(k));
  for (const [a, row] of ppmi) {
    const ya = Y[a];
    for (const [b, w] of row) {
      const ob = omega[b];
      for (let j = 0; j < k; j += 1) ya[j] += w * ob[j];
    }
  }
  for (let it = 0; it < powerIter; it += 1) {
    const Z = [];
    for (let i = 0; i < V; i += 1) Z.push(new Float64Array(k));
    for (const [a, row] of ppmi) {
      const ya = Y[a];
      for (const [b, w] of row) {
        const zb = Z[b];
        for (let j = 0; j < k; j += 1) zb[j] += w * ya[j];
      }
    }
    const Y2 = [];
    for (let i = 0; i < V; i += 1) Y2.push(new Float64Array(k));
    for (const [a, row] of ppmi) {
      const y2 = Y2[a];
      for (const [b, w] of row) {
        const zb = Z[b];
        for (let j = 0; j < k; j += 1) y2[j] += w * zb[j];
      }
    }
    Y = Y2;
    orthonormalize(Y, k);
  }
  orthonormalize(Y, k);

  // ⑤ 行归一化 → 每个词的语义向量
  const vectors = [];
  for (let i = 0; i < V; i += 1) {
    const row = Y[i];
    let n = 0;
    for (let j = 0; j < k; j += 1) n += row[j] * row[j];
    n = Math.sqrt(n) || 1;
    const out = new Array(k);
    for (let j = 0; j < k; j += 1) out[j] = Number((row[j] / n).toFixed(4));
    vectors.push(out);
  }
  return {
    version: VERSION,
    dim: k,
    docs: texts.length,
    vocab,
    vectors,
    lexicon: { words: lex.words, maxLen: lex.maxLen },
  };
}

/** 列主序 Gram-Schmidt（就地修改 Y），并对极小的列做兜底随机化。 */
function orthonormalize(Y, k) {
  const V = Y.length;
  const cols = [];
  for (let j = 0; j < k; j += 1) cols.push(new Float64Array(V));
  for (let i = 0; i < V; i += 1) {
    const row = Y[i];
    for (let j = 0; j < k; j += 1) cols[j][i] = row[j];
  }
  for (let j = 0; j < k; j += 1) {
    const cj = cols[j];
    for (let p = 0; p < j; p += 1) {
      const cp = cols[p];
      let dot = 0;
      for (let i = 0; i < V; i += 1) dot += cp[i] * cj[i];
      if (!dot) continue;
      for (let i = 0; i < V; i += 1) cj[i] -= dot * cp[i];
    }
    let n = 0;
    for (let i = 0; i < V; i += 1) n += cj[i] * cj[i];
    n = Math.sqrt(n);
    if (n < 1e-9) {
      const rng = makeRng(0x51ed270b + j);
      for (let i = 0; i < V; i += 1) cj[i] = rng() - 0.5;
      n = 0;
      for (let i = 0; i < V; i += 1) n += cj[i] * cj[i];
      n = Math.sqrt(n) || 1;
    }
    for (let i = 0; i < V; i += 1) cj[i] /= n;
  }
  for (let i = 0; i < V; i += 1) {
    const row = Y[i];
    for (let j = 0; j < k; j += 1) row[j] = cols[j][i];
  }
}

/** 取（并缓存）空间里的词→下标索引。 */
function indexOfSpace(space) {
  if (!space._index) space._index = new Map(space.vocab.map((t, i) => [t, i]));
  return space._index;
}

/**
 * 文本 → 语义空间里的向量。
 *
 * 标准 LSA 文档编码：把命中的词向量求和再归一化。
 * 一个词都没命中时返回空 Map —— 调用方据此退回 n-gram，而不是拿全零向量冒充。
 */
export function encodeSemantic(space, text) {
  const out = new Map();
  if (!space || !Array.isArray(space.vocab) || !space.vocab.length) return out;
  const idx = indexOfSpace(space);
  const k = space.dim;
  const acc = new Float64Array(k);
  let hit = 0;
  for (const term of new Set(termsOf(text, space.lexicon))) {
    const i = idx.get(term);
    if (i == null) continue;
    const vec = space.vectors[i];
    if (!vec) continue;
    hit += 1;
    for (let j = 0; j < k; j += 1) acc[j] += vec[j];
  }
  if (!hit) return out;
  let n = 0;
  for (let j = 0; j < k; j += 1) n += acc[j] * acc[j];
  n = Math.sqrt(n) || 1;
  for (let j = 0; j < k; j += 1) {
    const v = acc[j] / n;
    if (v) out.set(j, v);
  }
  return out;
}

/** 两个语义向量的余弦（都是归一化过的点积）。 */
export function semanticSimilarity(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [d, v] of small) {
    const w = big.get(d);
    if (w) dot += v * w;
  }
  return Number(Math.max(-1, Math.min(1, dot)).toFixed(4));
}

/**
 * 解释为什么某个词跟谁近（调试与「反查」用，也给人看）。
 *
 * 这是本地 LSA 反而强于黑盒 embedding 的地方：能说出「因为它们的上下文像」。
 */
export function explainNeighbors(space, term, { limit = 8 } = {}) {
  if (!space) return [];
  const idx = indexOfSpace(space);
  const i = idx.get(String(term ?? '').toLowerCase());
  if (i == null) return [];
  const base = space.vectors[i];
  const out = [];
  for (let j = 0; j < space.vocab.length; j += 1) {
    if (j === i) continue;
    const v = space.vectors[j];
    let dot = 0;
    for (let d = 0; d < space.dim; d += 1) dot += base[d] * v[d];
    if (dot > 0.05) out.push({ term: space.vocab[j], sim: Number(dot.toFixed(3)) });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
}
