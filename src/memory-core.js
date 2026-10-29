// 小鲸鱼的记忆系统核心（纯本地、可单测、不 import bridge 内部符号）。
//
// 为什么要有这一层：
//   以前记忆散成三份互不相干的东西 —— companion-memory.json（人物账本）、
//   companion-turns.jsonl（对话流水）、social-v2.json 里的 activeTopics/pendingThoughts。
//   三份都没有「重要度」，满了就 shift() 砍最老的，于是「他凌晨说过想被叫老婆」
//   会和「今天天气不错」同等对待，谁先来谁先被扔掉。
//   而且是「最近 N 条无脑塞进提示词」，她根本不会按当下话题去想起来某件事。
//
// 这一层照人脑分四类，每条记忆都带分数：
//   情景记忆 episodic  —— 谁在哪天说了什么（流水，会被自然遗忘）
//   语义记忆 semantic  —— 提炼过的事实/性格/话题（重要，半衰期长）
//   未说出口 pending   —— 想说但没说的一句话（会过期）
//   核心记忆 core      —— 永不忘（他是主人、我叫小鲸鱼）
//
// 分数公式（所有项都是可解释的，不做黑盒）：
//   base   = 重要度 1..5
//   emo    = 情绪权重 1 + min(3, 情绪命中数 * 0.6)   —— 吵架/告白/深夜这类会被加权
//   recency = (1 + 天数)^-alpha                      —— 幂律遗忘（不是指数），尾巴长、不归零
//   freq    = (1 + 命中次数)^0.6                     —— 被想起来一次就牢一点，也是幂律
//   score  = base * emo * recency * freq
// 幂律而不是指数的理由见 LAYER_CONFIG 上方注释。巩固（consolidate）时把 day 维度的
// 「天」推进，衰减自动发生，不需要遍历删除。

import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeAttention,
  moodOf,
  accumulateVocab,
  habituate,
} from './memory-attention.js';
import {
  embed,
  vectorSimilarity,
  expandCues,
  buildCooccurrence,
  serialPositionBonus,
  competitionPenalty,
  moodCongruentBonus,
  confidenceOf,
  confidenceLabel,
  isTipOfTongue,
  parseCues,
} from './memory-vector.js';
import {
  detectMilestone,
  collectMilestones,
  buildTimeline,
  autobioSummary,
  findNarrativeConflicts,
} from './memory-self.js';
import {
  detectSensory,
  renderSensory,
  extractProcedures,
  shouldReviseProcedure,
  renderProcedures,
  extractPitfalls,
} from './memory-procedural.js';
import {
  buildSemanticSpace,
  encodeSemantic,
  semanticSimilarity as spaceSimilarity,
} from './memory-semantic.js';
// 通用中文词表（jieba）：真词分词 + 词频稀有度。见 memory-lexicon.js 顶部说明。
import {
  segmentCached,
  cueWords,
  universalRarity,
  isCue,
  hasLexicon,
  lexiconStats,
  asksTime,
} from './memory-lexicon.js';

export const MEMORY_LAYERS = ['core', 'long', 'working'];
// procedural 是程序记忆（怎么做），和「发生过什么」并列但检索方式完全不同。
export const MEMORY_KINDS = ['episodic', 'semantic', 'pending', 'core', 'profile', 'procedural'];

// 每层的容量上限与衰减指数。core / profile 不进衰减也不被裁。
//
// 为什么用幂律而不是指数半衰期（这是「像人」的关键一处）：
//   指数衰减意味着「180 天的东西一定比 179 天的旧一半」，人不是这样。
//   Anderson & Schooler 在新闻标题的记忆实验里测出的是幂律：
//     记住概率 ≈ 频率^a × 新近度^-b
//   幂律的尾巴特别长 —— 一年前的事还记得一点，十年后也还有点，
//   而不是像指数那样几年后精确等于 0。指数衰减会让「初恋」和「上周三吃的面」
//   在一年后同归于尽，这在陪伴场景里是致命的。
//   decayAlpha 越大衰减越快：working（流水）0.9，long（事实）0.35。
export const LAYER_CONFIG = {
  core: { halfLifeDays: Infinity, max: 400, decayAlpha: 0 },
  long: { halfLifeDays: 180, max: 3000, decayAlpha: 0.35 },
  working: { halfLifeDays: 21, max: 6000, decayAlpha: 0.9 },
};

// 「被想起过」到底加多少分。
//
// 曾用 (1+hits)^0.6，是个正反馈陷阱：想起来 → 加分 → 更容易被想起。
// 实测 47 条语义里只有 18 条有 hits、29 条恒为 0，头部两条冲到 84 / 67 次，
// 其余全饿死。换成对数后仍然「常想起的更难忘」，但把马太效应按住：
//   命中 0 次 → 1.00 倍
//   命中 9 次 → 2.99 倍（原来是 3.98 倍）
//   命中 84 次 → 4.85 倍（原来是 14.4 倍）
// 关键不是绝对倍数变小，而是「热条 vs 温条」的比值从 3.6 收窄到 1.6 ——
// 这样冷门条目靠新近度和情绪分还有机会翻上来。
export const FREQ_GAIN = 0.6;

// 情绪词表：命中就加权。不做花哨 NLP —— 这套东西的价值在于稳定、可解释、零依赖。
// 分成强/弱两档，强的权重更高（告白、吵架、离别、深夜这些是真会记住的）。
const EMOTION_STRONG = [
  '喜欢', '爱你', '爱', '想你了', '想你', '老婆', '老公', '主人', '宝贝', '亲爱的',
  '结婚', '妻子', '恋人', '在一起', '永远', '答应', '承诺',
  '哭', '难过', '伤心', '委屈', '生气', '吵架', '恨', '对不起', '抱歉', '原谅',
  '害怕', '担心', '生病', '疼', '累', '孤独', '一个人', '离开', '别走', '再见',
  '第一次', '秘密', '只有你', '专属', '真的',
  // 亲密关系向：小鲸鱼是主人这边的人，这些词出现时那句话一定要记得牢
  '娶', '嫁', '抱抱', '亲亲', '吻', '撒娇', '吃醋', '舍不得', '心疼', '想念',
  '一辈子', '陪着', '等你', '回来', '平安',
];
const EMOTION_WEAK = [
  '开心', '高兴', '喜欢', '笑', '好玩', '有趣', '可爱', '乖', '温柔',
  '深夜', '凌晨', '半夜', '睡不着', '晚安', '早安', '吃饭', '饿',
  '加班', '忙', '压力', '工作', '考试', '游戏', '出门', '回家',
];

// 中文分词（与 sticker-gallery 同一套思路）：中文按二元组，英文数字整词。
// 单字也留一份，否则「猫」这种单字查询永远命中不了。
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const w of s.match(/[a-z0-9_]+/g) || []) out.push(w);
  for (const chunk of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (chunk.length === 1) { out.push(chunk); continue; }
    for (let i = 0; i < chunk.length - 1; i += 1) out.push(chunk.slice(i, i + 2));
    out.push(chunk);
  }
  return out;
}

/**
 * 两条文本的字符 bigram 相似度（去标点后算集合交并比，除以较小的一方）。
 *
 * 除的是 min 而不是并集，这是刻意的：合并重复要抓的是「A 是 B 的子串/片段」
 * 这种情况（实测有 5 对是「，风一阵一阵，快四点天没亮）」被单独存成了
 * 「白天出门收稻谷了（稻子是黄的，风一阵一阵，快四点天没亮）」的尾巴），
 * 除以并集会被长度差稀释到 0.6 以下，永远够不到阈值。
 *
 * 代价是长文本里的短片段会显得很像 —— 所以调用方必须自己去把控阈值
 * （mergeDuplicates 用 0.95，宁可漏也不误并）。
 */
export function textSimilarity(a, b) {
  const clean = (t) => String(t ?? '').replace(/[^\w\u4e00-\u9fff]/g, '');
  const sa = clean(a);
  const sb = clean(b);
  if (!sa || !sb) return 0;
  const gramsOf = (s) => {
    if (s.length <= 1) return new Set([s]);
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = gramsOf(sa);
  const gb = gramsOf(sb);
  let inter = 0;
  const [small, big] = ga.size <= gb.size ? [ga, gb] : [gb, ga];
  for (const g of small) if (big.has(g)) inter += 1;
  return inter / Math.max(1, small.size);
}

/**
 * 编码门槛：这句话值不值得进情景库。
 *
 * 为什么需要（人的「编码」不是全录）：
 *   人不会记住别人说的每句话，只有「引起注意」的才编码进海马体。
 *   现在这层是每句无条件落盘 —— 实测一天 500 条，其中大量是
 *   「嗯」「好」「哈哈哈」「[表情]」这类零信息量的东西。
 *   它们不会让记忆更像人，只会把 BM25 索引撑大、把真信号稀释掉。
 *
 * 返回 { keep, weight, reason }：
 *   keep=false            —— 不落盘（纯噪声）
 *   keep=true, weight<1   —— 落盘但降权（短句、我自己说的话）
 *
 * 刻意保守：宁可多留，不可误杀。只有三种情况才丢。
 */
const NOISE_ONLY = /^[\s\p{P}\p{S}]*$/u;
// QQ 的图片/表情占位符：[表情] [图片] [转发消息 id=...] —— 纯占位没有任何语义
const PLACEHOLDER_ONLY = /^(?:\[[^\]]{1,12}\]\s*)+$/u;
// 同一个字重复 3 次以上（「哈哈哈」「啊啊啊」）—— 保留 2 次的（「哈哈」有笑的语义边界，也不苛求）
const REPEAT_ONLY = /^(.)\1{2,}$/u;
const FILLER_WORDS = ['嗯', '哦', '噢', '啊', '哈', '呵', '嘿', '额', '呃', '唔', '喔', '好', '行', 'ok', 'okay', '在', '是', '对', '收到', '知道了', '明白了', '没事', '算了'];
export function shouldEncodeEpisode(text, { self = false, where = '', vocab = null, recentMaxSim = 0 } = {}) {
  // 真正判定搬到 memory-attention.analyzeAttention 里做（四维显著性：
  // 新奇度 / 意外度 / 自我参照 / 情绪唤醒，再叠习惯化折减）。
  // 这里保留同名同形状的返回，是为了让老的调用方与单测一行不改。
  const r = analyzeAttention(text, { self, vocab, recentMaxSim });
  return { keep: r.keep, weight: r.weight, reason: r.reason };
}

export function emotionWeight(text) {
  const s = String(text || '');
  let hits = 0;
  for (const w of EMOTION_STRONG) if (s.includes(w)) hits += 1;
  let weak = 0;
  for (const w of EMOTION_WEAK) if (s.includes(w)) weak += 1;
  const score = 1 + Math.min(3, hits * 0.6) + Math.min(0.6, weak * 0.15);
  return Number(score.toFixed(3));
}

/**
 * 情绪强度（0..1）—— 和 emotionWeight 不是一个东西，别混用。
 *
 *   emotionWeight  是「这句话有多重」，值域 1~4.6，进 scoreMemory 当乘数。
 *   这里给的是归一化的 arousal，给渲染层与元记忆用（决定「要不要标一句
 *   这只是情绪话，别当事实」）。
 */
export function arousalOf(text) {
  return moodOf(text).arousal;
}

function daysSince(ms, now) {
  const t = Number(ms) || 0;
  if (!t) return 0;
  return Math.max(0, (now - t) / 86400000);
}

/**
 * 单条记忆的「现在有多容易被想起来」。现在求值而不是落盘存死值 —— 分数随时间变化，存下来就会过期。
 *
 * 公式（Anderson & Schooler 的 频率 × 新近度；新近度用幂律，频率用对数）：
 *   recency = (1 + 天数)^(-alpha)          —— 幂律遗忘，尾巴长，不会归零
 *   freq    = 1 + FREQ_GAIN × log2(1+hits) —— 被想起过就更难忘，但对数增长
 *   score   = 重要度 × 情绪 × recency × freq
 *
 * 频率为什么不用幂律：幂律是正反馈，越热越热，实测把冷门条目饿死（见 FREQ_GAIN 注释）。
 *
 * 为什么 alpha 按层不同：
 *   working（当天流水）0.9  —— 一周就没影了，这对流水是对的
 *   long（提炼过的事实）0.35 —— 三年后还剩一成，这才是「记得」
 * core / profile 直接 Infinity：它们是关系的骨架，不参与任何衰减。
 */
export function scoreMemory(item, { now = Date.now(), layer = null } = {}) {
  const lay = layer || item.layer || 'working';
  if (lay === 'core' || item.kind === 'core' || item.kind === 'profile') return Number.POSITIVE_INFINITY;
  const cfg = LAYER_CONFIG[lay] ?? LAYER_CONFIG.working;
  const base = clamp(Number(item.importance) || 3, 1, 5);
  const emo = Number(item.emotion) > 0 ? Number(item.emotion) : emotionWeight(item.text || '');
  // 兼容两套字段名：semantic 用 createdAt，episodic 用 at。
  // 以前只读 createdAt，情景条目的天数被算成 0（永远新鲜），这是个静默 bug。
  const age = daysSince(item.createdAt || item.at || item.lastHitAt, now);
  const alpha = cfg.decayAlpha ?? 0.5;
  const recency = age <= 0 ? 1 : Math.pow(1 + age, -alpha);
  // 频率不是线性加成，是**对数**加成（见上面 FREQ_GAIN 的注释）。
  // 原来的 `Math.pow(1 + hits, 0.6)` 是个正反馈陷阱：被想起来 → 分数变高 →
  // 更容易再被想起来。实测 47 条语义里有 18 条有 hits、29 条恒为 0，
  // 头部两条冲到 84 和 67 次，其余全饿死 —— 越热越热，冷门条目永远不激活。
  const hits = Number(item.hits) || 0;
  const freq = 1 + FREQ_GAIN * Math.log2(1 + hits);
  return base * emo * recency * freq;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonl(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

/** 只数行数，不解析 —— 控制台刷新统计时不该为了一个数字把冷库全 parse 一遍。 */
function countJsonlLines(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  let n = 0;
  for (const line of raw.split('\n')) if (line.trim()) n += 1;
  return n;
}

function hashId(seed) {
  let h = 2166136261;
  const s = String(seed);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ─────────────────────────────────────────────────────────────
// BM25 索引
// ─────────────────────────────────────────────────────────────
// 为什么自己写：npm 上的 BM25 库要么绑英文分词、要么带来一堆依赖。
// 这里只需要「一堆文档 + 一个查询 → 打分」，40 行足够，且中文二元组规则能复用。
const BM25_K1 = 1.4;
const BM25_B = 0.75;

export function buildBm25(docs) {
  const df = new Map();
  const lengths = [];
  const tfList = [];
  for (const doc of docs) {
    const tokens = tokenize(doc);
    lengths.push(tokens.length || 1);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    tfList.push(tf);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgLen = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 1;
  const n = docs.length;
  return {
    n,
    avgLen,
    df,
    tfList,
    lengths,
    // idf 用 +1 平滑，避免「从未出现过的词」把 idf 拉成负数
    idf(term) {
      const d = df.get(term) || 0;
      return Math.log(1 + (n - d + 0.5) / (d + 0.5));
    },
  };
}

export function bm25Scores(index, query) {
  const qTokens = tokenize(query);
  if (!qTokens.length || !index.n) return new Float64Array(index.n);
  const out = new Float64Array(index.n);
  for (const term of new Set(qTokens)) {
    const idf = index.idf(term);
    if (idf <= 0) continue;
    for (let i = 0; i < index.n; i += 1) {
      const f = index.tfList[i].get(term) || 0;
      if (!f) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (index.lengths[i] / index.avgLen));
      out[i] += idf * (f * (BM25_K1 + 1)) / denom;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 记忆库
// ─────────────────────────────────────────────────────────────
//
// 落盘布局（state/memory/）：
//   semantic.jsonl  一条一行，人可读、可 grep、可 git diff
//   episodic/YYYY-MM-DD.jsonl   按天分文件 —— 只有当天的在写，旧的永远不用重写
//   pending.json    想说还没说的话（会过期，量小，用 JSON 方便整体改）
//   index.json      统计与巩固水位
//
// 为什么流水按天分文件而不是一个大 jsonl：
//   一年就是几万条，一次性读进内存再整份重写，每次巩固都要几十毫秒 + 全量 IO，
//   而且崩溃会写坏整份。按天分文件后，巩固只需要读「还没巩固的那几天」。
export function createMemoryStore({
  dir,
  log = () => {},
  now = () => Date.now(),
  bm25CacheMs = 15000,
} = {}) {
  ensureDir(dir);
  const semanticFile = path.join(dir, 'semantic.jsonl');
  const pendingFile = path.join(dir, 'pending.json');
  const indexFile = path.join(dir, 'index.json');
  // 程序记忆单独一份：它是「怎么做」而不是「发生过什么」，
  // 混进 semantic 会让每次检索都要先判断条目类型，而且它的去重键是 skill 不是文本。
  const procFile = path.join(dir, 'procedural.json');
  const episodicDir = path.join(dir, 'episodic');
  const coldDir = path.join(dir, 'cold');
  ensureDir(episodicDir);
  ensureDir(coldDir);

  let semantic = readJsonl(semanticFile);
  let pending = readJson(pendingFile, { items: [] });
  if (!Array.isArray(pending.items)) pending.items = [];
  let procedures = readJson(procFile, { items: [] }).items;
  if (!Array.isArray(procedures)) procedures = [];
  let index = readJson(indexFile, { version: 1, consolidatedThrough: '', createdAt: now() });

  // BM25 索引缓存：记忆不会天天变，但每次唤醒都重建 3000 条文档的索引没必要。
  let cache = { at: 0, index: null, docs: null };

  function invalidate() {
    cache = { at: 0, index: null, docs: null };
  }

  /**
   * 重写语义层文件。
   *
   * `keepIndex`：只改了 hits / lastHitAt 这类「不改正文」的字段时传 true。
   * 为什么重要：recall 每次都会 bumpHits → 原来一路走 invalidate()，
   * 等于每次唤醒都把 600 条文档的 BM25 + n-gram + LSA 向量全部重建一遍
   * （实测单次 recall 从 5ms 涨到 100ms，一次唤醒能差出 200ms）。
   * 正文没变就不用重建索引，只把文件落盘。
   */
  function saveSemantic({ keepIndex = false } = {}) {
    // 全量重写：语义记忆是几百到几千条级别，重写一次 <5ms，比追加+压缩逻辑简单可靠。
    const tmp = `${semanticFile}.${process.pid}.${now()}.tmp`;
    fs.writeFileSync(tmp, semantic.map((m) => JSON.stringify(m)).join('\n') + (semantic.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, semanticFile);
    if (!keepIndex) invalidate();
  }

  function savePending() {
    writeJsonAtomic(pendingFile, pending);
    invalidate();
  }

  function saveProcedures() {
    writeJsonAtomic(procFile, { items: procedures.slice(0, 400) });
    invalidate();
  }

  function saveIndex() {
    writeJsonAtomic(indexFile, index);
  }

  function dayFile(day) {
    return path.join(episodicDir, `${day}.jsonl`);
  }

  function dayOf(ms) {
    // 用本地时区的日期：记忆里的「昨天」必须跟用户看到的日期一致，
    // 用 UTC 会出现「中国时间早上八点前写的日记被算到前一天」。
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  function allEpisodicDays() {
    try {
      return fs.readdirSync(episodicDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .map((f) => f.slice(0, 10))
        .sort();
    } catch { return []; }
  }

  function readEpisodic(day) {
    return readJsonl(dayFile(day));
  }

  /**
   * 全部情景记忆的扁平行。
   *
   * 故意不复用 collect()：collect 会把语义层和 pending 混进来，
   * 而里程碑/时间线/感知这些只看「真的发生过的时刻」，混进陈述句会造出
   * 「2026-10-24 那天我第一次叫你老婆」这种根本没发生过的记忆。
   */
  function allEpisodicRows() {
    const rows = [];
    for (const day of allEpisodicDays()) {
      for (const m of readEpisodic(day)) rows.push({ ...m, day: m.day || day });
    }
    return rows.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  }

  // 所有可检索的条目（语义 + 未说出口 + 情景），带上各自的行号/来源
  function collect({ includeEpisodic = true, days = 0 } = {}) {
    const rows = [];
    semantic.forEach((m, i) => rows.push({ ...m, layer: m.layer || 'long', _src: 'semantic', _idx: i }));
    pending.items.forEach((m, i) => rows.push({ ...m, layer: 'working', kind: 'pending', _src: 'pending', _idx: i }));
    if (includeEpisodic) {
      let dayList = allEpisodicDays();
      if (days > 0) dayList = dayList.slice(-days);
      for (const day of dayList) {
        readEpisodic(day).forEach((m, i) => rows.push({ ...m, layer: m.layer || 'working', _src: 'episodic', _day: day, _idx: i }));
      }
    }
    return rows;
  }

  function docText(m) {
    return [m.text, m.who, m.where, (m.tags || []).join(' ')].filter(Boolean).join(' ');
  }

  function ensureIndex(rows) {
    if (cache.index && Date.now() - cache.at < bm25CacheMs && cache.docs === rows.length) return cache;
    const docs = rows.map(docText);
    const bm25 = buildBm25(docs);
    const vecs = docs.map((d) => embed(d));
    let cooc = cache.cooc;
    if (!cooc || cache.coocDocs !== rows.length) cooc = buildCooccurrence(docs);
    // 真语义空间（LSA）：从她自己的语料里学出来的词向量。
    // 只在够量且能用时才有，够不上就退回字符 n-gram —— 不能拿半成品冒充。
    const space = ensureSemanticSpace(docs);
    // 每行在语义空间里的向量，跟 n-gram 向量一样预计算并缓存。
    // 不缓存的话每次 recall 都要对 600+ 条重新切词编码（实测 122ms/次，
    // 唤醒时这已经算卡顿了）；缓存后同一批行只算一次，之后每次 recall ~5ms。
    const semVecs = space ? docs.map((d) => encodeSemantic(space, d)) : null;
    // 情绪价也在这里一次性算完并缓存。
    // 原来在 scored.map 里对每条调 moodOf(m.text)，那是 563 次正则扫全句（实测 68ms/次 recall），
    // 而它只跟文本有关、跟查询无关 —— 每次唤醒重算一遍纯属白烧。
    const valences = new Map(docs.map((d, i) => [rows[i].id, rows[i].valence ?? moodOf(d).valence]));
    cache = {
      at: now(),
      index: bm25,
      vecs,
      cooc,
      coocDocs: rows.length,
      docs: rows.length,
      space,
      semVecs,
      valences,
    };
    return cache;
  }

  /**
   * 语义空间缓存。
   *
   * 为什么要缓存到落盘而不是每次重建：
   *   604 条语料建一次 450~650ms（新词发现 + PPMI + 6 轮幂迭代 SVD）。
   *   每次唤醒都算一遍会把「回忆」变成卡顿来源，所以按「语料指纹」缓存到
   *   state/memory/semantic-space.json，只有语料条数或最后一条 id 变了才重建。
   */
  function ensureSemanticSpace(docs) {
    const file = path.join(dir, 'semantic-space.json');
    const fingerprint = `${docs.length}:${docs.reduce((a, d) => a + d.length, 0)}`;
    if (cache.space && cache.spaceFingerprint === fingerprint) return cache.space;
    let space = null;
    try {
      const saved = readJson(file, null);
      if (saved && saved.fingerprint === fingerprint && Array.isArray(saved.space?.vocab)) {
        space = saved.space;
      }
    } catch { /* 坏文件当没有，重建 */ }
    if (!space) {
      try {
        space = buildSemanticSpace(docs);
      } catch (err) {
        log('semantic-space: 建空间失败，本次退回 n-gram', err?.message || err);
        space = null;
      }
      if (space) {
        try {
          // 落盘前剥掉运行期缓存（_index 是 Map，_set 是 Set，写进 JSON 只会变成垃圾）。
          const { _index, lexicon, ...rest } = space;
          // 这个文件**不带缩进**写。
          //
          // 为什么单独处理：writeJsonAtomic 用的是 `JSON.stringify(obj, null, 2)`，
          // 人看着舒服，但对 279 词 × 64 维的稠密矩阵来说，缩进本身就占了约 70% 体积
          //（实测 pretty 595KB / compact 187KB）。这只是个机器读的缓存，没人会去翻，
          // 每轮语料变化都整份重写一遍，白白多吃几倍磁盘和 IO。
          const payload = JSON.stringify({
            fingerprint,
            builtAt: now(),
            space: { ...rest, lexicon: lexicon ? { words: lexicon.words, maxLen: lexicon.maxLen } : null },
          });
          const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
          fs.writeFileSync(tmp, payload, 'utf8');
          fs.renameSync(tmp, file);
        } catch { /* 落盘失败不影响本次 */ }
      }
    }
    cache.spaceFingerprint = fingerprint;
    return space;
  }

  /**
   * 回忆：按当下这句话去找相关记忆。
   *
   * 打分 = 0.34*字面(BM25归一) + 0.36*语义(向量余弦) + 0.30*记忆强度
   *   字面管精确命中（人名、型号、「稻子」）；语义管意思对上（「我养的那只」↔「我家有只猫」）。
   *   语义权重略高于字面：字面命中时语义一般也高，两路互相印证不会误伤精确查询；
   *   而「字面没命中、语义命中」恰恰是最有价值的一类，只有抬语义才捞得回来。
   *
   * 四层人脑修正（都能单独关，方便单测隔离）：
   *   线索扩展  查询词按共现表扩成联想词补打一次 BM25，最多补 45%
   *   系列位置  同一批里开头/结尾的加一点（首因 + 近因）
   *   干扰竞争  跟已入选条目太像就压分（提取诱发遗忘，顺带治同义重复挤爆 prompt）
   *   情绪一致  当前心情与记忆同号则加，反号则轻微抑制
   *
   * 元记忆：每条返回带 confidence + confidenceLabel —— 模型拿到 fuzzy/glimpse
   * 才敢说「我记不太清」，而不是把弱匹配当事实说出来。
   */
  function recall(query, {
    limit = 8,
    who = '',
    layers = null,
    includeEpisodic = true,
    episodicDays = 14,
    minScore = 0.01,
    currentMood = null,
    expand = true,
    dedupe = true,
    // 证据门槛：0 = 关闭（等于退回只看 minScore 的老行为）。
    // 默认 0.15 —— 按本库（232 条长句为主）实测的分布定的，不是 fish 那个 0.30。
    evidenceGate = 0.15,
    // 分档上限：true 才按「最高证据」限制这一趟给几条。默认关 ——
    // 「不硬凑」是好的愿望，但在本库上实测会把正确答案一起挡掉（@3 从 61% 掉下来）。
    evidenceBucket = false,
  } = {}) {
    const cfgEvidenceGate = Math.max(0, Number(evidenceGate) || 0);
    const cfgEvidenceBucket = evidenceBucket === true;
    let rows = collect({ includeEpisodic, days: episodicDays });
    if (who) rows = rows.filter((m) => !m.who || String(m.who) === String(who) || m.kind === 'core');
    if (layers) rows = rows.filter((m) => layers.includes(m.layer));
    if (!rows.length) return [];

    const { index: idx, vecs, cooc, space, semVecs, valences } = ensureIndex(rows);
    const stamp = now();
    const cues = parseCues(query);
    // 纯指代查询（「你还记得上次那个吗」）去掉指代词后基本空了。
    // 这时不能拿空串去检索（全 0），退回原文让强度路把重要的顶上来。
    const qText = cues.core && cues.core.length >= 1 ? cues.core : String(query || '');

    const bm = bm25Scores(idx, qText);
    if (expand && qText) {
      const { terms, raw: rawTerms } = expandCues(qText, { cooc });
      if (terms.length > rawTerms.length) {
        const extra = bm25Scores(idx, terms.join(' '));
        for (let i = 0; i < extra.length; i += 1) {
          if (extra[i]) bm[i] += extra[i] * 0.45;
        }
      }
    }
    let maxBm = 0;
    for (const v of bm) if (v > maxBm) maxBm = v;

    // ══════════════════════════════════════════════════════════════
    // 「证据量 C」—— 单独一条通道，和最终得分 P 分开算
    //
    // 为什么必须分开（2026-10-29，从 dsh-fish-memory 学来并实测确认）：
    //   原来 minScore 卡的是**最终 score**，而 score = 字面×0.34 + 语义×0.36 + 记忆分×0.30。
    //   后果是：记忆分（重要度/衰减）一动，整库分数整体平移，连着「该想起的」一起被挡掉。
    //     实测（对方那套的对照数据）：把「没写时间戳算多鲜活」从 1 调到 0.75，
    //     该想起的从 10/11 掉到 8/11 —— 而他们本来就拿同一个值，压低**不改变排序**，纯白损失。
    //   所以：门槛只管「这条记忆跟这句话到底有没有真关系」（C），
    //        鲜活度/重要度/情绪**只参与排序**（score）。
    //
    // C 怎么算：命中词的稀有度之和，过一道饱和曲线 s/(s+K)。
    //   稀有度 = 这个词在**本库**里多罕见 × 在**通用中文**里多具体（双尺子）。
    //   为什么要通用那把尺子：库里只有 2 条时，任何词「库里稀有度」都是 1.0，
    //     于是「表示」「正式」这种通用高频词成了最值钱的证据 —— 库里越小越荒唐。
    //   为什么要本库这把：她天天挂在嘴边的词（宝宝/今天/晚上）不该算满额证据。
    // ══════════════════════════════════════════════════════════════
    const 有词表 = hasLexicon();
    // 本库稀有度：这个词在库里越少见越值钱（对数式，不是线性）。
    //
    // 为什么必须用对数而不是「1 - df/N」：库小的时候线性式会崩。
    //   实测（3 条记忆）：某词出现 1 次 → 1 - 1/(3×0.25) = -0.33 → 被 max(0,·) 归零
    //   → 唯一那条该命中的记忆 evidence = 0，整轮一条都给不出来。
    //   对数式 log((N+1)/(df+1)) / log(N+1) 在小库上是 0.5 而不是 0，正常给分。
    // 库很小（< MIN_DOCS_FOR_RARITY）时直接给 1 —— 统计不显著，不该拿它压分。
    const MIN_DOCS_FOR_RARITY = 20;
    const 库内稀有 = (k) => {
      const dfMap = idx && idx.df;
      if (!dfMap || typeof dfMap.get !== 'function') return 0.5;
      const N = rows.length;
      if (N < MIN_DOCS_FOR_RARITY) return 1;
      const d = dfMap.get(k) || 0;
      const v = Math.log((N + 1) / (d + 1)) / Math.log(N + 1);
      return Math.max(0, Math.min(1, v));
    };
    // 稀有门：出现率 1% 以上的词不算线索（库小的时候门槛自动变小，几乎不压）
    const 稀有门 = Math.max(3, rows.length * 0.01);

    // ⚠⚠ 单字线索的坑（实测踩到，别简化掉）：
    //   「他最晚几点睡」切出 最|晚|几点|睡，其中「晚」「睡」都是单字。
    //   「富江是什么」切出 富|江|什么，其中「富」「江」都是单字 ——
    //   单字在库里的 df 天然很低（「晚」只出现在 4 条里），算出来稀有度 1.0，
    //   于是**两个字拆开的噪声比「富江」这个真名词还值钱**：
    //     实测「富江」查询，两条内容只有「富江」两个字的残片 ev=0.4706，
    //     比真正讲破甲那条还高 —— 因为残片短，两个单字就占满了饱和曲线。
    //   → 单字线索一律降权（×0.35），除非它在库里极其罕见（df<=2 且是具体实词）。
    //     中文的语义单位基本是 2 字以上，单字更多是切词残留。
    const 单字权重 = (k) => (k.length === 1 ? 0.35 : 1);

    // 查询词：先过「通用中文」那道门，再过「本库太常见」那道
    const q全部 = 有词表 ? [...segmentCached(qText)] : [];
    const q过通用 = q全部.filter(isCue);
    const q过库 = q过通用.filter((k) => {
      // 库太小（词表统计不显著）时不做「本库太常见」筛选，否则会把正常词全筛掉
      if (rows.length < MIN_DOCS_FOR_RARITY) return true;
      const dfMap = idx && idx.df;
      const d = dfMap && typeof dfMap.get === 'function' ? (dfMap.get(k) || 0) : 0;
      return d > 0 && d <= 稀有门;
    });
    // 安全垫（三条，少一条就翻车 —— 实测过的）：
    //   ① 筛剩不足 1 个 → 一个线索都没有，退回不筛
    //   ② 筛剩的词在本库一条记忆都没出现过 → 说明筛错方向了，退回不筛
    //   ③ 库太小（< MIN_DOCS_FOR_RARITY）→ 「本库太常见」这道门本来就没做，
    //      但「通用中文」那道门照样会砍（「喜欢」「什么」都会被砍），
    //      所以小库上也要退回 —— 小库的统计本来就不显著，不该拿它压。
    //
    // 踩坑记录（别把 ① 又改回 >= 2）：
    //   第一版写成「不足 2 个就退回」，结果集成测试挂了 ——
    //   「你还记得我喜欢什么吗」切完只剩「喜欢」一个，退回后 C 反而正常；
    //   而不退回的话那唯一一个词 C 太小，整轮一条都想不起来。
    //   fish-memory 那边写 >= 2 是因为它的切词器不会把单字虚词丢掉；
    //   我们这边会丢，剩 1 个是常态，不能当异常。
    const 有任一命中 = q过库.some((k) => {
      const dfMap = idx && idx.df;
      return dfMap && typeof dfMap.get === 'function' && (dfMap.get(k) || 0) > 0;
    });
    // ⚠ 第三条安全垫（问时间时）：时间类问题切完词经常只剩单字（「晚」「睡」），
    //   而单字在本库 df 高（「睡」几乎每条都有）会被「稀有门」筛掉 → 一条都不剩。
    //   这时退回「过了通用门」的整批（q过通用），至少保住单字线索。
    const 剩的能用 = 有词表 && q过库.length >= 1 && 有任一命中;
    const q证据词 = 剩的能用
      ? q过库
      : (有词表 ? (q过通用.length ? q过通用 : q全部) : []);
    const 证据K = 1; // 饱和曲线常数：s=1 时 C=0.5，s=3 时 C=0.75

    // ⚠⚠ 时间类问题要单独加权（别当词面线索处理）
    //
    // 实测踩坑：「他最晚几点睡」——「几点」是疑问词（isCue=false，它指不向任何内容），
    //   排掉之后只剩「晚」「睡」两个单字（各 ×0.35），证据分归 0，整轮一条都想不起来。
    //   可库里明明有「他常在 0-3 点出现」「凌晨三点四十醒过一次」「半夜爱闹」这些。
    // → 问时间的时候，把「含时间线索的记忆」证据分抬 0.15。
    //   这是**排序加成**不是词面命中：它不会让「所有含『点』字的句子」都进来，
    //   只让「半夜/凌晨/0-3 点/熬夜/通宵」这类真在讲时间的条目往前站。
    const 问时间 = asksTime(qText);
    const 时间线索 = /凌晨|半夜|熬夜|通宵|早起|晚睡|\d{1,2}\s*[-~到]\s*\d{1,2}\s*点|\d{1,2}\s*点/u;

    const 证据Of = (m) => {
      if (!有词表 || !q证据词.length) return null; // null = 词表不可用，退回老行为
      const 词集 = segmentCached(docText(m));
      let s = 0;
      let 命中数 = 0;
      for (const k of q证据词) {
        if (!词集.has(k)) continue;
        命中数 += 1;
        s += 库内稀有(k) * universalRarity(k) * 单字权重(k);
      }
      if (s <= 0) return 0;
      let c = s / (s + 证据K);
      // 问时间 + 这条在讲时间 → 抬一手（封顶 1）
      if (问时间 && 时间线索.test(String(m.text || ''))) {
        c = Math.min(1, c + 0.15);
      }
      return Math.min(1, c);
    };


    // 双通道语义：LSA 管「意思对上」，n-gram 管「字面重合」。
    //
    // 为什么两个都要（实测结论，别删任何一条）：
    //   · 只有 n-gram：「给我发语音」能命中含「语音」的句子，但「最理想的声音」命中不了 ——
    //     字面一个 bucket 都不重合。这是纯字面检索的死角。
    //   · 只有 LSA：语料少时短句向量会被拉平成「都差不多」，精确人名/型号反而变模糊。
    //   · 两路加权后各治对方的病：LSA 抓同义改述，n-gram 抓精确串。
    // LSA 命中不到词表时（query 全是新词）encodeSemantic 返回空 Map，
    // 这时权重自动全给 n-gram，不会出现「语义分恒为 0 把结果压死」。
    const qVec = embed(qText);
    const cos = vecs.map((v) => vectorSimilarity(qVec, v));
    let semCos = null;
    if (space && semVecs) {
      const qSpace = encodeSemantic(space, qText);
      if (qSpace.size) {
        semCos = semVecs.map((v) => (v && v.size ? spaceSimilarity(qSpace, v) : 0));
      }
    }
    const semanticOf = (i) => {
      const ng = Math.max(0, cos[i]);
      if (!semCos) return ng;
      return Math.max(0, semCos[i]) * 0.62 + ng * 0.38;
    };

    // 记忆分归一化：用本批最大值，避免绝对分数被层配置绑死
    const raw = rows.map((m) => {
      const s = scoreMemory(m, { now: stamp });
      return Number.isFinite(s) ? s : 999;
    });
    const maxRaw = Math.max(...raw, 1);

    // 心情影响「想起什么」，不改记忆本身 —— 那是编码层的事，别混在这里。
    const mood = currentMood ?? moodOf(qText);

    const posIndex = new Map();
    const posTotal = new Map();
    rows.forEach((m, i) => {
      const key = m._day || 'semantic';
      posTotal.set(key, (posTotal.get(key) || 0) + 1);
      posIndex.set(i, posTotal.get(key) - 1);
    });

    // 每条记忆的情绪价来自 ensureIndex 的缓存（Map 按 id 索引）。
    // 不再每次 recall 对 563 条全文跑 moodOf 正则（实测 68ms/次）。
    // 缓存里查不到（比如刚 append 还没重建索引）就退回现算，保证不错。
    const valenceOf = (m) => m.valence ?? valences.get(m.id) ?? moodOf(m.text || '').valence;

    const scored = rows.map((m, i) => {
      const literal = maxBm > 0 ? bm[i] / maxBm : 0;
      const semantic = semanticOf(i);
      const memNorm = raw[i] / maxRaw;
      const base = literal * 0.34 + semantic * 0.36 + memNorm * 0.30;
      const serial = m._day ? serialPositionBonus(posIndex.get(i), posTotal.get(m._day)) : 0;
      const congruent = moodCongruentBonus(valenceOf(m), mood.valence);
      // 证据量：null 表示词表不可用（退回只看 score 的老行为）
      const evidence = 证据Of(m);
      return {
        ...m,
        _i: i,
        bm25: Number(bm[i].toFixed(3)),
        semantic: Number(semantic.toFixed(4)),
        memScore: Number((Number.isFinite(raw[i]) ? raw[i] : 99).toFixed(3)),
        evidence: evidence === null ? null : Number(evidence.toFixed(4)),
        confidence: confidenceOf({ bm25: literal, vector: semantic, memNorm, hits: m.hits || 0 }),
        score: Number(Math.max(0, base + serial + congruent).toFixed(4)),
      };
    });
    scored.sort((a, b) => b.score - a.score);

    // ══════════════════════════════════════════════════════════════
    // 门槛卡证据（evidence），不卡总分（score）。
    //
    // minScore 是给「总分」用的老口径 —— 总分里混着重要度和衰减，
    // 拿它当「够不够相关」的门槛，等于「一条老记忆因为不够新鲜就被判定为不相关」。
    // 现在分两件事：
    //   · evidenceGate：这条记忆跟这句话到底有没有真关系（有词表时才生效）
    //   · minScore：够相关之后，总分太低还是别浪费名额（保留老行为，作为第二道）
    //
    // 分档上限（「不硬凑」）：不砍任何一条够格的，只规定「这一趟最多给几条」。
    //   原来 limit=6 就是硬凑 6 条 —— 分数全挤在 0.5 那档时，6 条里有 4 条不相干。
    //   现在按**最高证据分**决定这一趟给几条。
    // ══════════════════════════════════════════════════════════════
    const 有证据通道 = scored.length > 0 && scored[0].evidence !== null && scored[0].evidence !== undefined;
    const 最高证据 = 有证据通道 ? Math.max(...scored.map((r) => Number(r.evidence) || 0)) : 0;
    // ⚠ 0.30 → 0.22 的来历（别凭感觉调）：
    //   实测 232 条真库，12 条真 query 的 evidence 分布是 0.24~0.47（中位 0.30）。
    //   门槛 0.30 时 12 轮里 5 轮只剩 1 条、1 轮空手 —— 因为**大部分正确命中的 ev 就在 0.24~0.30**
    //   （「我答应过什么」命中「口头答应了名分」ev=0.2403、「喜欢什么颜色」ev=0.2774）。
    //   0.30 是 fish-memory 基于它自己数据定的，我们的分词器会把单字丢掉、
    //   句子切得更碎，同样的句子 s 更小 → C 整体偏低。所以门槛要跟着降。
    //   0.22 = 实测「该进的都进得来」的最低值，再低就会混进「怎么样」这种碎片命中。
    // ⚠⚠ 门槛与分档**必须允许关掉**（消融实验用，也是真实需求）
    //
    //   第一版我照 fish-memory 的口径写死 0.22 + 三档，实测 18 条真实问法只有 61% 命中、
    //   2 轮一条不给 —— 比改动前还差。原因是我这 232 条库里「正确命中」的 ev 大量落在
    //   0.15~0.22 之间（长句子命中 2~3 个词，s 小），而 fish 那种短句为主的数据 s 更大。
    //   同一个数字搬到不同分布上就是错的。
    //   → 门槛做成可配（默认 0.15，按本库实测下调），并且**默认不分档**（limit 就是 limit），
    //     分档只有在配置里明确打开才生效 —— 宁可少改，也不要让「不硬凑」把正确答案挡掉。
    const 证据门槛 = cfgEvidenceGate;
    const 分档开关 = cfgEvidenceBucket;
    const 分档 = [[0.40, limit], [0.32, Math.min(4, limit)], [0.26, Math.min(3, limit)], [0, Math.min(2, limit)]];
    const 本趟上限 = (有证据通道 && 分档开关)
      ? (分档.find(([线]) => 最高证据 >= 线) || [0, limit])[1]
      : limit;

    // 干扰竞争：逐条放进去，跟已入选的比相似度，太像就压分往下沉。
    // 这是「提取诱发遗忘」的实现，同时天然解决同一件事 5 条变体一起挤进 prompt。
    //
    // 性能坑（踩过，别再写回去）：原来在循环里对每条候选和每条已入选的条目
    // 都调 embed(text) 重算 n-gram 向量 —— 563 条 × limit 次哈希，单次 recall 100ms+。
    // 实际 vecs[i]（ensureIndex 里对 docText 算好的）就够用了，直接取下标。
    const out = [];
    for (const cand of scored) {
      // 第一道：证据。有词表时用 evidence，没词表时跳过（老行为）
      if (有证据通道) {
        const ev = Number(cand.evidence) || 0;
        if (ev < 证据门槛) { cand.omission = 'evidence'; continue; }
        // 「差一点够上」的先记着，整轮一条都没挑中时补一条
        if (ev < 证据门槛 * 1.0) cand.omission = 'evidence';
      }
      // 第二道：总分（老口径，作为兜底）
      if (cand.score < minScore) { cand.omission = cand.omission || 'score'; continue; }
      let s = cand.score;
      if (dedupe && out.length) {
        let maxSim = 0;
        const vCand = vecs[cand._i];
        for (const w of out) {
          const sim = vectorSimilarity(vCand, vecs[w._i]);
          if (sim > maxSim) maxSim = sim;
        }
        s = competitionPenalty(s, maxSim);
      }
      cand.finalScore = Number(s.toFixed(4));
      if (s < minScore) { cand.omission = 'score'; continue; }
      out.push({ ...cand, score: cand.finalScore });
      if (out.length >= 本趟上限) break;
    }

    // 「差一点够上」补一条：唯一命中 75% 门槛时，别让整轮空手。
    // 实测意义：门槛 0.30 时某条 0.288 只差 0.012，扔掉就变成「一条都没挑中」，
    // 模型那边看起来像完全没记忆 —— 比给一条「差一点」的还糟。
    if (!out.length && 有证据通道) {
      let 差点 = null;
      for (const cand of scored) {
        const ev = Number(cand.evidence) || 0;
        if (ev < 证据门槛 * 0.75) continue;
        if (cand.score < minScore) continue;
        if (!差点 || cand.score > 差点.score) 差点 = cand;
      }
      if (差点) {
        差点.finalScore = 差点.score;
        差点.差一点 = true;
        差点.omission = '';
        out.push({ ...差点 });
      }
    }
    // 压完分之后顺序可能变了（被压的那条可能已经低于后面几条），重排一次
    out.sort((a, b) => b.score - a.score);
    out.forEach((m) => { m.confidenceLabel = confidenceLabel(m.confidence); });

    // 命中计数：被想起来一次就记一次，下次 boost 更高。
    // 只在真正返回给模型时才算（过滤前的全部条目都加会污染统计）。
    if (out.length) {
      bumpHits(out);
    }
    return out;
  }

  /**
   * 「话在嘴边」：有痕迹但提不出来。
   *
   * 给 bridge 用 —— 返回非空时提示词里应当出现「我记得有这么回事但想不清，
   * 你提醒我一下」，而不是空白（显得毫无记忆）也不是断言（会编）。
   */
  function tipOfTongue(query, opts = {}) {
    const hits = recall(query, { ...opts, minScore: 0.04, limit: opts.limit || 8 });
    return isTipOfTongue(hits) ? hits.slice(0, 2) : [];
  }

  /**
   * 工作记忆：人一次只能同时想着 4 件事左右（Miller 的 7±2 是上限，恋爱场景更窄）。
   *
   * 为什么不用 recall(limit:6)：
   *   recall 是「按分数取前 N 条」，N 条全是同质的语义事实 ——
   *   结果是每次唤醒都塞 6 句「他喜欢蓝色」「他讨厌香菜」，看起来记得很多，
   *   实际丢了两件最该在的事：①我们是什么关系（永远在最前）②刚刚才说的那句。
   *
   * 四个固定槽位（照着人脑的工作记忆 + 情境缓冲）：
   *   slot1 core/profile —— 关系骨架，永不缺席（他是我老公 / 我是小鲸鱼）
   *   slot2 近因        —— 最近一条重要情景（几小时内，跟当下连着）
   *   slot3-4 相关      —— BM25 命中的语义记忆，最多两条
   * 槽空就是空，不拿低分条凑数 —— 「想不起来」本身是信息。
   */
  function gatherWorkingMemory(query, {
    who = '',
    episodicHours = 24,
    relevantSlots = 2,
    minScore = 0.12,
    // 这两个槽可关：程序记忆只在有「怎么做」的场合才有价值，
    // 里程碑槽对纯粹的闲聊也是噪音。默认开，配置能关（见 config.json memory.*）。
    withProcedural = true,
    withMilestone = true,
  } = {}) {
    const out = {
      core: [], recent: [], relevant: [], cold: [],
      // 新增三槽：程序记忆（怎么做）、里程碑（我是谁）、话到嘴边（有痕迹但提不出来）
      procedural: [], milestone: [], faint: [],
      // 第五槽：想通了的事（跨天联想，由重放产出）。
      // 为什么单列一槽而不是混进 relevant：实测重放产出的联想分数（0.44）永远
      // 打不过两条同样相关的原话（0.64/0.63），relevantSlots=2 时它一次都进不去 ——
      // 机制造出来了却从不浮现，等于没做。人和检索的区别正在这里：他不只会想起
      // 「你说过什么」，还会想起「我后来自己琢磨明白了什么」，那是另一类记忆。
      insight: [],
      query: String(query || ''),
    };
    const stamp = now();

    // slot1：core + profile。profile 是「关于这个人的稳定画像」，比单条事实更该常在。
    out.core = semantic
      .filter((m) => m.kind === 'core' || m.kind === 'profile' || (m.layer || 'long') === 'core')
      .filter((m) => !who || !m.who || String(m.who) === String(who))
      .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
      .slice(0, 2);

    // slot2：最近 N 小时里权重最高的一条情景（不限当天，跨零点也对）。
    const cutoff = stamp - Math.max(1, episodicHours) * 3600000;
    let recentBest = null;
    let recentBestScore = -1;
    for (const day of allEpisodicDays().slice(-2)) {
      for (const r of readEpisodic(day)) {
        if (!r || r.self === true) continue;
        if (Number(r.at) < cutoff) continue;
        if (who && r.who && String(r.who) !== String(who)) continue;
        const w = Number(r.w) || 0.6;
        const s = w * emotionWeight(r.text);
        if (s > recentBestScore) { recentBestScore = s; recentBest = { ...r, layer: 'working', _src: 'episodic' }; }
      }
    }
    if (recentBest) out.recent = [recentBest];

    // slot3-4：相关。走 recall 但排除已进前两槽的，且要求真有点相关。
    if (relevantSlots > 0 && out.query.trim()) {
      const taken = new Set([...out.core, ...out.recent].map((m) => m.id));
      const hits = recall(out.query, {
        limit: relevantSlots + taken.size + 4,
        who,
        episodicDays: 14,
        minScore,
        // ⚠ 工作记忆这里**必须关掉证据门槛**（踩过，test-memory-human 的维度 10b 挂了）
        //
        //   证据门槛问的是「这条记忆跟这句话有没有字面关系」。可工作记忆要装的
        //   恰恰是「字面对不上但该想起来」的东西：
        //     · insight 是重放产出的跨天联想（「他能叫你老婆大人，却翻脸不让你这么叫」），
        //       它跟 query「老婆大人 亲密些」字面只对上一个词，被门槛挡掉 → insight 槽永远是空；
        //     · 舌尖、冷库那些也是「有痕迹但提不出来」，字面本来就不该强。
        //   门槛是给**注入 k 条**用的（省 token、减少乱提旧事），
        //   工作记忆是四五个固定槽，不需要靠它省。两件事分开。
        evidenceGate: 0,
      });
      // 想的和记得的分开摆：replay 产出的跨天联想走专门一槽。
      // 不分开就会发生实测过的事 —— 它的分数永远排在同话题原话后面，两个槽永远轮不到它。
      const insights = hits.filter((m) => !taken.has(m.id) && m.source === 'replay');
      if (insights.length) out.insight = insights.slice(0, 1);
      out.relevant = hits
        .filter((m) => !taken.has(m.id) && m.source !== 'replay')
        .slice(0, relevantSlots);
      // relevant 空了但联想在：联想也算相关，不该再去捞冷库/舌尖凑数。
      if (!out.relevant.length && !out.insight.length) out.relevant = [];
    }

    // slot-1（可选）：冷库回响。热检索没命中、但冷库按关键词捞到了 —— 就是「看到照片才想起来」。
    // 只有 relevant 和 insight 都空时才补，且只给一条，标成「很久以前」，
    // 免得把十年前的小事和当下混为一谈（那是虚构症的另一种形式）。
    if (!out.relevant.length && !out.insight.length && out.query.trim()) {
      try {
        const taken = new Set([...out.core, ...out.recent].map((m) => m.id));
        const echo = searchCold(out.query, { limit: 3 }).filter((m) => !taken.has(m.id));
        if (echo.length) out.cold = [echo[0]];
      } catch {}
    }

    // slot-2：程序记忆。只在问句里有「怎么做」的信号时才出现 ——
    // 每轮都塞「发语音要先合成」纯属噪音，它该在真的要发语音时跳出来。
    if (withProcedural && out.query.trim()) {
      try { out.procedural = recallProcedures(out.query, { limit: 2 }); } catch {}
    }

    // slot-3：人生锚点。不是「相关」，而是「我是谁」——所以不按 query 命中算，
    // 而是固定取最近的一条里程碑（同类型只留最强）。没有里程碑就不占槽。
    if (withMilestone) {
      try {
        const ms = collectMilestones(allEpisodicRows(), { perKind: 1 });
        if (ms.length) out.milestone = [ms[ms.length - 1]];
      } catch {}
    }

    // slot-4：话到嘴边。相关的不够、但低分里有痕迹 → 明确告诉模型「我记不太清」。
    // 这是元记忆最诚实的落点：宁可说模糊，也别用一条低分记忆假装记得。
    if (!out.relevant.length && !out.insight.length && !out.cold.length && out.query.trim()) {
      try { out.faint = tipOfTongue(out.query, { limit: 2 }); } catch {}
    }
    return out;
  }

  /** 某人的关系画像（每人最多一份，kind='profile'，永不衰减）。 */
  function setProfile(who, text, { importance = 5, tags = [] } = {}) {
    const name = String(who || '').trim();
    const body = String(text || '').trim();
    if (!name || !body) return null;
    const existing = semantic.find((m) => m.kind === 'profile' && String(m.who || '') === name);
    if (existing) {
      existing.text = body.slice(0, 800);
      existing.importance = clamp(Number(importance) || 5, 1, 5);
      existing.updatedAt = now();
      existing.emotion = emotionWeight(existing.text);
      if (Array.isArray(tags) && tags.length) existing.tags = tags.map(String).slice(0, 8);
      saveSemantic();
      return existing;
    }
    const item = {
      id: hashId(`profile|${name}`),
      text: body.slice(0, 800),
      kind: 'profile',
      layer: 'long',
      who: name,
      where: '',
      tags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : [],
      importance: clamp(Number(importance) || 5, 1, 5),
      emotion: emotionWeight(body),
      hits: 0,
      source: 'consolidate',
      createdAt: now(),
      updatedAt: now(),
      lastHitAt: 0,
    };
    semantic.push(item);
    saveSemantic();
    return item;
  }

  function getProfile(who) {
    const name = String(who || '').trim();
    return semantic.find((m) => m.kind === 'profile' && String(m.who || '') === name) || null;
  }

  // 再巩固的节奏：每被想起来 3 次就排一次「这条还成立吗」。
  //
  // 为什么是这个数字：人回忆一次就顺手改写一次（reconsolidation，Nader 2000），
  // 但机器人每轮都改会让记忆漂移 —— 它会把「他喜欢狗」越改越像「他想养狗」。
  // 3 次是个折中：足够频繁到能修正错记，又不至于把同一条反复重写。
  const RECONSOLIDATE_EVERY = 3;

  function bumpHits(items) {
    const stamp = now();
    let touchedSemantic = false;
    let touchedPending = false;
    for (const item of items) {
      if (item._src === 'semantic') {
        const m = semantic[item._idx];
        if (m) {
          m.hits = (Number(m.hits) || 0) + 1;
          m.lastHitAt = stamp;
          // 被反复想起的记忆才是活的 —— 攒够次数就排队等一次「还成立吗」。
          //
          // 用独立的 hitsSinceReview 而不是 hits 取模：取模会在核对完的第 4/7/10 次
          // 反复把同一条塞回队首（测试里就撞到过 —— 一条刚核对完的记忆又被拉去核对）。
          // 计数在核对时清零，节奏才是「每被想起 3 次核对一轮」。
          // 只统计真正「对上话」的那次：recall 会把 memNorm 高但关键词零命中的
          // 条目也一起返回（分数 >= minScore 就算数），那些其实没被想起来 ——
          // 拿它们排再巩固，会让「他养过猫」因为「最近很显眼」被反复拉去核对。
          if (m.kind !== 'core' && m.kind !== 'profile' && !m.reviewDue) {
            if (Number(item.bm25) > 0) {
              m.hitsSinceReview = (Number(m.hitsSinceReview) || 0) + 1;
              if (m.hitsSinceReview >= RECONSOLIDATE_EVERY) {
                m.reviewDue = true;
                m.reviewQueuedAt = stamp;
              }
            }
          }
          touchedSemantic = true;
          item.hits = m.hits;
        }
      } else if (item._src === 'pending') {
        const m = pending.items[item._idx];
        if (m) { m.hits = (Number(m.hits) || 0) + 1; m.lastHitAt = stamp; touchedPending = true; item.hits = m.hits; }
      }
      // 情景记忆不回写：一天几千条，为了加个 hits 就重写整个日文件不值得，
      // 它的重要性由语义层的巩固来体现。
    }
    // 只动了 hits / lastHitAt / reviewDue 这些不改正文的字段 —— 索引不用重建。
    if (touchedSemantic) saveSemantic({ keepIndex: true });
    if (touchedPending) savePending();
  }

  /** 排队等再巩固的条目（给巩固器用）。 */
  function listReviewDue({ limit = 5 } = {}) {
    return semantic
      .filter((m) => m.reviewDue === true && m.kind !== 'core' && m.kind !== 'profile')
      .sort((a, b) => (Number(a.reviewQueuedAt) || 0) - (Number(b.reviewQueuedAt) || 0))
      .slice(0, limit);
  }

  /**
   * 结掉一条再巩固排队。
   *
   * 必须能被单独调用：模型说 keep、或者调用失败时都要清标记 ——
   * 否则一条记忆会永远留在队首，下次醒来又被拉去核对一次（无限重试）。
   */
  function clearReviewDue(id) {
    const m = semantic.find((x) => x.id === id);
    if (!m) return false;
    if (!m.reviewDue) return false;
    m.reviewDue = false;
    m.reviewCheckedAt = now();
    m.hitsSinceReview = 0;
    delete m.reviewQueuedAt;
    saveSemantic();
    return true;
  }

  /** 再巩固跑完一轮留个时间戳，控制台能看到「上次核对是什么时候」。 */
  function markReviewed() {
    index.lastReviewAt = now();
    saveIndex();
  }

  /**
   * 再巩固落库：把修订后的事实写回去。
   *
   * 只改 text，并留一份 revision 历史 —— 因为「改了什么」本身是重要信息：
   * 如果同一条事实被改了三次以上，通常意味着它本来就不该被当成事实记住。
   */
  function reviseFact(id, newText, { reason = '' } = {}) {
    // 兼容两种写法：字符串正文，或 { text } 对象。
    // 加这层是因为 `String({text:'x'})` 会静默变成 "[object Object]" 存进去 ——
    // 记忆里出现一条 `[object Object]` 是最难归因的一类脏数据（不报错、只在检索时露馅）。
    const raw = newText && typeof newText === 'object' ? newText.text : newText;
    const body = String(raw ?? '').trim();
    if (!body || body === '[object Object]') return null;
    const m = semantic.find((x) => x.id === id);
    if (!m) return null;
    const revs = Array.isArray(m.revisions) ? m.revisions : [];
    // 最多留 3 版，再多的意义不大（也免得单条记忆无限膨胀）
    revs.push({ at: now(), from: String(m.text || '').slice(0, 400), reason: String(reason || '').slice(0, 120) });
    m.revisions = revs.slice(-3);
    m.text = body.slice(0, 800);
    m.emotion = emotionWeight(m.text);
    m.updatedAt = now();
    m.reviewDue = false;
    m.hitsSinceReview = 0;
    delete m.reviewQueuedAt;
    saveSemantic();
    return m;
  }

  /**
   * 给一条语义记忆打补丁（只允许白名单字段）。
   *
   * 存在的理由：巩固器在改写完一条事实后，还要顺手更新它的
   * attr / derivedFrom / factKind —— 这些是「记账字段」，不该每次
   * 都走 remember 重新建对象（会丢 id、丢 revisions）。
   * 白名单是为了防止调用方往里塞 hits/createdAt 这种由 decay/score 管的字段。
   */
  const PATCHABLE = new Set(['attr', 'factKind', 'derivedFrom', 'tags', 'importance', 'who', 'where', 'text']);
  function patchItem(id, patch = {}) {
    const m = semantic.find((x) => x.id === id);
    if (!m) return null;
    let touched = false;
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCHABLE.has(k)) continue;
      if (k === 'text') {
        const body = String(v ?? '').trim();
        if (!body) continue;
        m.text = body.slice(0, 800);
        m.emotion = emotionWeight(m.text);
      } else if (k === 'importance') {
        m.importance = clamp(Number(v) || 3, 1, 5);
      } else if (k === 'tags') {
        m.tags = Array.isArray(v) ? v.map(String).slice(0, 8) : m.tags;
      } else if (k === 'derivedFrom') {
        if (Array.isArray(v) && v.length) {
          m.derivedFrom = v.slice(0, 6).map((s) => ({
            day: String(s?.day || ''),
            idx: Number(s?.idx) || 0,
            at: Number(s?.at) || 0,
            text: String(s?.text || '').slice(0, 60),
          }));
        }
      } else {
        m[k] = String(v || '');
      }
      touched = true;
    }
    if (touched) {
      m.updatedAt = now();
      saveSemantic();
    }
    return m;
  }

  /**
   * 记一件事。同一条内容重复写会合并（内容相同 → importance 取大、hits+1），
   * 而不是存两份 —— 否则「他在做 QQ 机器人」会被记 20 遍。
   */
  function remember(text, {
    kind = 'semantic',
    layer = null,
    who = '',
    where = '',
    tags = [],
    importance = null,
    at = null,
    source = 'ai',
    expiresAt = null,
    // attr 是「这条事实描述的是哪个属性」（profile.city / pref.like / habit.加班…）。
    // 本地巩固用它做冲突检测：同 attr 不同值 = 他改口了，要改写不要并存。
    attr = '',
    derivedFrom = null,
    factKind = '',
  } = {}) {
    const rawText = text && typeof text === 'object' ? text.text : text;
    const body = String(rawText ?? '').trim();
    if (!body || body === '[object Object]') return null;
    // who 必须清洗掉零宽字符再存。
    // 踩过的坑（2026-10-29）：QQ 昵称里从别处复制来的字符串常带 U+200B，
    // 于是「Pure White & Pure Black」和「Pure\u200b White & Pure\u200b Black」
    // 被当成两个人，recall 的 who 过滤是严格相等 → 那批记忆一条都检索不到，
    // 实测 237 条里 26 条（11%）就这样静默失联了半年。
    // 清洗放在写入侧而不是检索侧：检索侧每轮都要跑，而且清不干净存量。
    const cleanWho = String(who ?? '').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').trim();
    who = cleanWho;
    const stamp = at || now();
    const lay = layer || (kind === 'core' ? 'core' : kind === 'pending' ? 'working' : 'long');
    const imp = importance != null
      ? clamp(Number(importance) || 3, 1, 5)
      : (kind === 'core' ? 5 : 3);

    // 去重：同一层 + 同一 who + 文本完全一致 → 视为重复
    const norm = body.replace(/\s+/g, ' ').toLowerCase();
    const dup = semantic.find((m) => (m.layer || 'long') === lay
      && String(m.who || '') === String(who || '')
      && String(m.text || '').replace(/\s+/g, ' ').toLowerCase() === norm);
    if (dup) {
      dup.hits = (Number(dup.hits) || 0) + 1;
      dup.lastHitAt = stamp;
      if (imp > (Number(dup.importance) || 3)) dup.importance = imp;
      saveSemantic();
      return dup;
    }

    const item = {
      id: hashId(`${lay}|${who}|${norm}|${stamp}`),
      text: body.slice(0, 800),
      kind: kind === 'core' ? 'core' : 'semantic',
      layer: lay,
      who: String(who || ''),
      where: String(where || ''),
      tags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : [],
      importance: imp,
      emotion: emotionWeight(body),
      hits: 0,
      source: String(source || 'ai'),
      createdAt: stamp,
      lastHitAt: 0,
    };
    if (expiresAt) item.expiresAt = Number(expiresAt);
    // 属性槽位：本地巩固靠它做「他改口了」检测，模型版靠它避免同一件事写两种说法
    if (attr) item.attr = String(attr);
    if (factKind) item.factKind = String(factKind);
    if (Array.isArray(derivedFrom) && derivedFrom.length) {
      item.derivedFrom = derivedFrom.slice(0, 6).map((s) => ({
        day: String(s?.day || ''),
        idx: Number(s?.idx) || 0,
        at: Number(s?.at) || 0,
        text: String(s?.text || '').slice(0, 60),
      }));
    }
    semantic.push(item);
    // 裁容量：按分数从低到高砍，而不是按时间砍。
    // core 永不参与；long/working 各自守自己的上限。
    for (const layName of ['long', 'working']) {
      const cfg = LAYER_CONFIG[layName];
      const bucket = semantic.filter((m) => (m.layer || 'long') === layName);
      if (bucket.length <= cfg.max) continue;
      const ranked = bucket
        .map((m) => ({ m, s: scoreMemory(m, { now: stamp }) }))
        .sort((a, b) => a.s - b.s);
      const drop = new Set(ranked.slice(0, bucket.length - cfg.max).map((x) => x.m.id));
      semantic = semantic.filter((m) => !drop.has(m.id));
    }
    saveSemantic();
    return item;
  }

  /**
   * 情景记忆：直接追加到当天文件，不走去重也不进 BM25 缓存（量太大）。
   *
   * 编码门槛在这里落地。以前是「来一句存一句」，实测一天 500 条里
   * 一大半是「嗯」「哈哈」「[表情]」，它们不会让记忆更像人，
   * 只会把 BM25 索引撑大、把真信号埋掉。
   * 现在被门槛挡下的会记进 index.json 的 dropped 计数（可观测，不静默）。
   */
  function logEpisode({
    who = '', where = '', text, reply = '', at = null, self = false,
    speakerId = '', tags = [], attachments = [], recentMaxSim = 0,
  } = {}) {
    const body = String(text ?? '').trim();
    if (!body) return null;
    // 习惯化要「跟最近说过的话比相似度」，那个相似度只有调用方算得出来
    // （要拿最近 N 条的向量），所以走参数传进来，这里不自己去翻日志。
    const gate = shouldEncodeEpisode(body, { self, where, recentMaxSim });
    if (!gate.keep) {
      index.dropped = (Number(index.dropped) || 0) + 1;
      index.droppedBy = index.droppedBy || {};
      index.droppedBy[gate.reason] = (Number(index.droppedBy[gate.reason]) || 0) + 1;
      // 每 200 条才落一次盘，避免高频写 index.json
      if ((Number(index.dropped) || 0) % 200 === 0) saveIndex();
      return null;
    }
    const stamp = at || now();
    const day = dayOf(stamp);
    const item = {
      id: hashId(`${day}|${stamp}|${body.slice(0, 40)}`),
      at: stamp,
      day,
      where: String(where || ''),
      who: String(who || ''),
      speakerId: String(speakerId || ''),
      self: self === true,
      text: body.slice(0, 600),
      reply: reply ? String(reply).slice(0, 600) : '',
      tags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : [],
      // 编码强度：巩固时优先看高权重的，低权重的不占名额
      w: gate.weight,
    };
    // 情绪二维：valence 决定「这算好事还是坏事」，arousal 决定「有多剧烈」。
    // 存下来是为了检索时的情绪一致性（心情差的时候更容易想起难过的事）。
    const mood = moodOf(body);
    if (mood.arousal > 0) item.arousal = mood.arousal;
    if (mood.valence !== 0) item.valence = mood.valence;
    // 感知引用：不存二进制，只存「这件事跟一段声音/一张图有关」+ 一句摘要。
    const sensory = detectSensory(body, { attachments });
    if (sensory.length) item.sensory = sensory;
    // 里程碑当场打标：巩固要几天后才跑，而「第一次叫我老婆」这种
    // 一旦漏掉就再也补不回来了（权重低的那天会被当普通流水）。
    // self 消息也参与里程碑判定：我自己说出「我生日是10月22」「我们说好
    // 不提日记」这种话同样是一辈子的事，原来直接跳过是漏记的根源之一。
    const ms = detectMilestone(body, { self: self === true });
    if (ms) {
      item.milestone = ms.kind;
      item.msConf = ms.confidence;
    }
    appendJsonl(dayFile(day), item);
    cache = { at: 0, index: null, docs: null };
    // 程序记忆单独走一条路：它不是「发生过什么」，是「以后怎么做」。
    if (!self) learnProcedures(body, { who, at: stamp });
    return item;
  }

  /**
   * 程序记忆：从一句话里学「以后该怎么做」。
   *
   * 和 remember 的区别（这是最容易写错的地方）：
   *   remember 存的是「他喜欢猫」这类陈述 —— 检索方式是「关于他的事有什么」。
   *   这里存的是「发语音要先合成再发」这类流程 —— 检索方式是「现在要做 X」。
   *   混在一起会让「他会骑车」和「他今天骑了车」挤在同一个列表里，读起来就乱了。
   *
   * 去重按 skill 名，不按文本：同一个人会反复说同一件事的不同细节，
   * 按文本去重会攒出十条「发语音」的变体，按 skill 去重才能保持一条最新的做法。
   */
  function learnProcedures(text, { who = '', at = null } = {}) {
    const found = extractProcedures(text);
    const pit = extractPitfalls(text);
    const stamp = at || now();
    let added = 0;
    for (const p of found) {
      const key = String(p.skill || '').toLowerCase();
      const existing = procedures.find((x) => String(x.skill || '').toLowerCase() === key);
      if (existing) {
        const dec = shouldReviseProcedure(existing, p);
        if (!dec.revise) continue;
        existing.revisions = Array.isArray(existing.revisions) ? existing.revisions.slice(-4) : [];
        existing.revisions.push({ steps: existing.steps, at: existing.updatedAt || existing.createdAt, why: dec.reason });
        existing.steps = p.steps.slice(0, 300);
        existing.updatedAt = stamp;
        existing.hits = Number(existing.hits) || 0;
        added += 1;
        continue;
      }
      procedures.push({
        id: hashId(`proc|${key}|${stamp}`),
        skill: p.skill.slice(0, 24),
        steps: p.steps.slice(0, 300),
        kind: p.kind,
        who: String(who || ''),
        // 程序记忆忘得慢：人几十年不骑车也还会骑。所以重要性固定偏高，
        // 衰减层里也不会被沉进冷库（见 decay 的跳过条件）。
        importance: 4,
        confidence: p.confidence,
        hits: 0,
        createdAt: stamp,
        updatedAt: stamp,
      });
      added += 1;
    }
    if (pit) {
      const key = `avoid|${pit.rule.slice(0, 16)}`;
      if (!procedures.some((x) => x.id === hashId(key) || x.kind === 'avoid' && x.steps === pit.rule)) {
        procedures.push({
          id: hashId(`${key}|${stamp}`),
          skill: '别这样做',
          steps: pit.rule,
          kind: 'avoid',
          who: String(who || ''),
          importance: 4,
          confidence: pit.confidence,
          hits: 0,
          createdAt: stamp,
          updatedAt: stamp,
        });
        added += 1;
      }
    }
    if (added) saveProcedures();
    return added;
  }

  /**
   * 按「要做的事」找程序记忆。
   *
   * 这里刻意不用 recall（那是给陈述性记忆的）：做事的检索是关键词对上就够了，
   * 用向量相似度反而会把「发语音」和「发消息」混成一条（向量空间里它们确实很近）。
   */
  function recallProcedures(query, { limit = 3 } = {}) {
    const q = String(query || '').trim();
    if (!q || !procedures.length) return [];
    const idx = buildBm25(procedures.map((p) => `${p.skill} ${p.steps}`));
    const s = bm25Scores(idx, q);
    return procedures
      .map((p, i) => ({ ...p, bm25: Number((s[i] || 0).toFixed(3)) }))
      .filter((p) => p.bm25 > 0)
      .sort((a, b) => b.bm25 - a.bm25)
      .slice(0, limit);
  }

  /** 未说出口的话：单独一份，因为它有「过期」和「说了就删」两种特例。 */
  function addPending(text, { who = '', expiresInMs = 2 * 3600 * 1000 } = {}) {
    const body = String(text ?? '').trim();
    if (!body) return null;
    const item = {
      id: hashId(`pending|${who}|${body}|${now()}`),
      text: body.slice(0, 400),
      kind: 'pending',
      who: String(who || ''),
      hits: 0,
      createdAt: now(),
      expiresAt: now() + expiresInMs,
    };
    pending.items.push(item);
    prunePending();
    savePending();
    return item;
  }

  function prunePending() {
    const stamp = now();
    pending.items = pending.items
      .filter((m) => !m.expiresAt || Number(m.expiresAt) > stamp)
      .slice(-40);
  }

  function listPending(who = '') {
    prunePending();
    savePending();
    return pending.items.filter((m) => !who || String(m.who) === String(who));
  }

  function forget(id) {
    const before = semantic.length;
    semantic = semantic.filter((m) => m.id !== id);
    if (semantic.length !== before) { saveSemantic(); return 'semantic'; }
    const beforePending = pending.items.length;
    pending.items = pending.items.filter((m) => m.id !== id);
    if (pending.items.length !== beforePending) { savePending(); return 'pending'; }
    // 情景记忆按天删：要重写那个日文件
    for (const day of allEpisodicDays()) {
      const rows = readEpisodic(day);
      const next = rows.filter((m) => m.id !== id);
      if (next.length !== rows.length) {
        fs.writeFileSync(dayFile(day), next.map((m) => JSON.stringify(m)).join('\n') + (next.length ? '\n' : ''), 'utf8');
        cache = { at: 0, index: null, docs: null };
        return 'episodic';
      }
    }
    return null;
  }

    /** 人看的统计（控制台用）。 */
  function stats() {
    const stamp = now();
    const days = allEpisodicDays();
    const layCount = {};
    for (const m of semantic) {
      const lay = m.layer || 'long';
      layCount[lay] = (layCount[lay] || 0) + 1;
    }
    // 冷库条数：只数行数，不解析内容（几百行也不该拖慢控制台刷新）
    let coldCount = 0;
    let coldMonths = [];
    try {
      coldMonths = fs.readdirSync(coldDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
      for (const f of coldMonths) coldCount += countJsonlLines(path.join(coldDir, f));
    } catch {}
    const dueCount = semantic.filter((m) => m.reviewDue === true).length;
    const revisedCount = semantic.filter((m) => Array.isArray(m.revisions) && m.revisions.length).length;
    return {
      dir,
      semantic: semantic.length,
      pending: pending.items.length,
      episodicDays: days.length,
      episodicFrom: days[0] || '',
      episodicTo: days[days.length - 1] || '',
      layers: layCount,
      // 编码门槛挡下的条数（可观测，不然「为什么记忆变少了」会成谜）
      dropped: Number(index.dropped) || 0,
      droppedBy: index.droppedBy || {},
      consolidatedThrough: index.consolidatedThrough || '',
      // 三期：冷库 + 再巩固，控制台要看得到「沉下去多少」「排队核对多少」
      cold: coldCount,
      coldMonths,
      reviewDue: dueCount,
      revised: revisedCount,
      lastReviewAt: Number(index.lastReviewAt) || 0,
      topImportant: semantic
        .map((m) => ({ id: m.id, text: m.text, layer: m.layer || 'long', kind: m.kind || 'semantic', score: Number(scoreMemory(m, { now: stamp }).toFixed(2)), hits: m.hits || 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10),
    };
  }

  /**
   * 遗忘：把分数低的条目「沉下去」，但不是删掉。
   *
   * 人的遗忘是检索失败，不是数据消失 —— 你说不出三年前某个下午干了什么，
   * 但看到那张照片立刻就能想起来。所以这里：
   *   working 跌破阈值 → 移到沉睡库 cold（不参与热检索，但能一键翻到）
   *   long 跌破阈值    → 降级到 working，继续自然衰减（慢慢淡忘比一刀切更像人）
   * core / profile 永不参与。
   *
   * 只有容量硬上限（LAYER_CONFIG.max）才真删，而且删的是分数最低的。
   */
  function decay({ nowMs = now(), coldThreshold = 0.06 } = {}) {
    const stamp = nowMs;
    let removed = 0;
    let demoted = 0;
    let cold = 0;
    const keep = [];
    const coldItems = [];
    for (const m of semantic) {
      const lay = m.layer || 'long';
      if (lay === 'core' || m.kind === 'core' || m.kind === 'profile') { keep.push(m); continue; }
      const s = scoreMemory(m, { now: stamp });
      // 沉进冷库：不删，只是不再参与热检索
      if (s < coldThreshold && lay === 'working') {
        coldItems.push({ ...m, coldAt: stamp, coldScore: Number(s.toFixed(4)) });
        cold += 1;
        continue;
      }
      // long 层跌破 0.3 降级到 working，让它继续自然衰减
      if (s < 0.3 && lay === 'long') {
        m.layer = 'working';
        demoted += 1;
      }
      keep.push(m);
    }
    if (coldItems.length) {
      // 冷库按月归档：state/memory/cold/YYYY-MM.jsonl，人可 grep
      for (const it of coldItems) {
        const d = new Date(Number(it.coldAt) || stamp);
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        appendJsonl(path.join(coldDir, `${month}.jsonl`), it);
      }
    }
    if (cold || demoted) {
      semantic = keep;
      saveSemantic();
    }
    return { removed, demoted, cold, kept: semantic.length };
  }

  /**
   * 合并语义层里的重复条目。
   *
   * ── 为什么需要这个 ────────────────────────────────────────────────
   * semantic.jsonl 是**只增不合并**的：remember() 只挡完全相同的 text，
   * 挡不住「同一件事换个说法写两遍」。实测 2026-10-29 的 237 条里有 7 对
   * 字符 bigram 相似度 1.00（比如「他要我多发表情包」被单独存成了
   * 「他希望我多发表情包，别怕被觉得敷衍」的子串）。
   * 不合并的后果不是「占地方」，是**检索质量下降**：同一件事的 N 个变体
   * 会一起挤进 top-k，把别的记忆挤出注入窗口（recall 里的 competitionPenalty
   * 只能压分、不能去掉）。
   *
   * ── 保留谁 ────────────────────────────────────────────────────────
   * 文本最长的（信息量最大），长度接近时比 importance 和 hits。
   * 被合并的那条不是「删掉」：id 记进 keep.mergedFrom，hits / importance / tags
   * 全累加过去，所以「这条被想起过多少次」的历史不丢。
   *
   * ── 阈值为什么是 0.95 ─────────────────────────────────────────────
   * 0.92 时开始出现「同一天的两件事被并成一条」（实测误合并 13 对 → 只该并 7 对）。
   * 0.95 只抓「几乎逐字相同」的那一档，宁可漏也不并错 —— 错了是不可逆的信息损失。
   */
  function mergeDuplicates({ threshold = 0.95, maxPairs = 200, dryRun = false } = {}) {
    if (semantic.length < 2) return { merged: 0, pairs: 0, threshold };
    const pairList = [];
    for (let i = 0; i < semantic.length; i += 1) {
      for (let j = i + 1; j < semantic.length; j += 1) {
        const s = textSimilarity(semantic[i].text, semantic[j].text);
        if (s >= threshold) pairList.push({ s, a: semantic[i], b: semantic[j] });
      }
    }
    pairList.sort((x, y) => y.s - x.s);
    const droppedIds = new Set();
    const merges = [];
    for (const { s, a, b } of pairList.slice(0, maxPairs)) {
      if (droppedIds.has(a.id) || droppedIds.has(b.id)) continue;
      const la = String(a.text || '').length;
      const lb = String(b.text || '').length;
      let keep = a;
      let drop = b;
      if (lb > la + 4) { keep = b; drop = a; }
      else if (Math.abs(la - lb) <= 4) {
        const sa = (Number(a.importance) || 0) * 1000 + (Number(a.hits) || 0);
        const sb = (Number(b.importance) || 0) * 1000 + (Number(b.hits) || 0);
        if (sb > sa) { keep = b; drop = a; }
      }
      keep.hits = (Number(keep.hits) || 0) + (Number(drop.hits) || 0);
      keep.importance = Math.max(Number(keep.importance) || 1, Number(drop.importance) || 1);
      if (!Array.isArray(keep.mergedFrom)) keep.mergedFrom = [];
      keep.mergedFrom.push(drop.id);
      const tags = new Set([...(keep.tags || []), ...(drop.tags || [])]);
      if (tags.size) keep.tags = [...tags].slice(0, 8);
      droppedIds.add(drop.id);
      merges.push({ score: Number(s.toFixed(3)), kept: keep.id, dropped: drop.id });
    }
    if (merges.length && !dryRun) {
      semantic = semantic.filter((m) => !droppedIds.has(m.id));
      saveSemantic();
    }
    return { merged: merges.length, pairs: pairList.length, threshold, merges };
  }

  /** 从冷库把东西捞回来（「看到照片就想起来了」）。 */
  function searchCold(query, { limit = 10 } = {}) {
    const rows = [];
    let files = [];
    try {
      files = fs.readdirSync(coldDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f));
    } catch { return []; }
    for (const f of files) rows.push(...readJsonl(path.join(coldDir, f)));
    if (!rows.length) return [];
    const idx = buildBm25(rows.map((m) => `${m.text || ''} ${m.who || ''}`));
    const s = bm25Scores(idx, query);
    return rows
      .map((m, i) => ({ ...m, coldScore: Number(s[i].toFixed(3)) }))
      .filter((m) => m.coldScore > 0)
      .sort((a, b) => b.coldScore - a.coldScore)
      .slice(0, limit);
  }

  return {
    dir,
    recall,
    /** 「话在嘴边」：有痕迹但提不出来（bridge 用它在提示词里说「我记不太清」）。 */
    tipOfTongue,
    remember,
    logEpisode,
    addPending,
    listPending,
    forget,
    stats,
    decay,
    gatherWorkingMemory,
    setProfile,
    getProfile,
    searchCold,
    /** 合并语义层的重复条目（心跳里每天跑一次就够）。 */
    mergeDuplicates,
    listReviewDue,
    clearReviewDue,
    markReviewed,
    reviseFact,
    patchItem,
    // ── 程序记忆（「怎么做」）──
    learnProcedures,
    recallProcedures,
    // 对外形状统一成 { id, name, steps, kind, ... }：
    // 内部字段叫 skill，但 API 的消费方（MCP 工具、控制台）都按 name 读，
    // 之前直接 slice 出去导致所有调用方拿到 `name: undefined`，看起来像「没名字的空条目」。
    listProcedures: () => procedures.map((p) => ({ ...p, name: p.skill })),
    /** 用一次就加一次命中：做熟的事更容易被再做（这也是技能不像事实那样会淡的原因）。 */
    useProcedure(id) {
      const p = procedures.find((x) => x.id === id);
      if (!p) return null;
      p.hits = (Number(p.hits) || 0) + 1;
      p.lastUsedAt = now();
      // 用得多就再抬一点重要性，封顶 5（重要度上限，和 remember 对齐）
      p.importance = Math.min(5, (Number(p.importance) || 4) + (p.hits % 5 === 0 ? 1 : 0));
      saveProcedures();
      return p;
    },
    forgetProcedure(id) {
      const before = procedures.length;
      procedures = procedures.filter((x) => x.id !== id);
      if (procedures.length !== before) { saveProcedures(); return true; }
      return false;
    },

    // ── 自我与时间线（「我是谁、这些年怎么过来的」）──
    /** 所有被打上里程碑标签的时刻，按时间正序。同类型只留最强的那个（起点才有意义）。 */
    milestones({ minConfidence = 0.6, perKind = 1 } = {}) {
      return collectMilestones(allEpisodicRows(), { minConfidence, perKind });
    },
    /** 人生大事记：逐日密度 + 空白间隔 + 里程碑标注。 */
    timeline({ gapDays = 3 } = {}) {
      return buildTimeline(allEpisodicRows(), { gapDays });
    },
    /** 一段「我们是怎么走到今天」的概述文本，给提示词用。 */
    autobio({ maxChars = 900, maxItems = 6 } = {}) {
      // 不写 this.milestones(...)：这个方法可能被解构成 const { autobio } = store 再调用，
      // 那时 this 是 undefined，会静默炸在提示词拼装里（最难查的一类）。
      const rows = allEpisodicRows();
      return autobioSummary({
        semantic: semantic.slice(),
        milestones: collectMilestones(rows, { perKind: 1 }).slice(0, maxItems),
        timeline: buildTimeline(rows),
        maxChars,
      });
    },
    /** 前后矛盾的说法：画像里写着「他讨厌猫」，最近却说「我家养了只猫」。 */
    narrativeConflicts({ recentDays = 7 } = {}) {
      return findNarrativeConflicts(semantic.slice(), { recentDays });
    },
    /** 感知引用（声音/画面/气味）：按需单独捞，不参与常规召回。 */
    sensoryRecall(query, { limit = 5 } = {}) {
      const q = String(query || '').trim();
      const rows = allEpisodicRows().filter((r) => Array.isArray(r.sensory) && r.sensory.length);
      if (!rows.length) return [];
      const idx = buildBm25(rows.map((r) => `${r.text || ''} ${(r.sensory || []).map((s) => s.summary || '').join(' ')}`));
      const s = q ? bm25Scores(idx, q) : rows.map(() => 1);
      return rows
        .map((r, i) => ({ ...r, sensoryScore: Number((s[i] || 0).toFixed(3)) }))
        .filter((r) => !q || r.sensoryScore > 0)
        .sort((a, b) => b.sensoryScore - a.sensoryScore)
        .slice(0, limit);
    },
    renderSensory,
    renderProcedures,
    // 给巩固流程用：读某天的全部情景记忆
    readDay: readEpisodic,
    listDays: allEpisodicDays,
    allSemantic: () => semantic.slice(),
    /** 巩固完成后推进水位，下次只处理新的一天。 */
    markConsolidated(day) {
      index.consolidatedThrough = day;
      index.lastConsolidatedAt = now();
      saveIndex();
    },
    consolidatedThrough: () => index.consolidatedThrough || '',
    /**
     * 通用小状态（存在 index.json 里）。
     *
     * 为什么要它：重放、巩固这些后台动作需要「上次啥时候跑的」这种一次性状态，
     * 以前只能往 index 里加字段，加一次就要改一次 core。
     * 现在统一走 meta，谁需要谁自己定 key，不污染主结构。
     * 注意：只放「时间戳/计数」这类可丢的东西 —— 丢了最多多跑一次，不会错。
     */
    getMeta: (k) => (index.meta && Object.prototype.hasOwnProperty.call(index.meta, k) ? index.meta[k] : undefined),
    setMeta(k, v) {
      if (!index.meta || typeof index.meta !== 'object') index.meta = {};
      index.meta[String(k)] = v;
      saveIndex();
    },
    /** 渲染成注入给模型的文本。 */
    renderRecalled(items, { title = '【你想起来的事】' } = {}) {
      if (!items || !items.length) return '';
      const lines = [title];
      for (const m of items) {
        const when = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : (m.day || '');
        const where = m.where ? `@${m.where}` : '';
        const who = m.who || '某人';
        // 感知摘要必须跟着记忆一起出来。只存不渲染等于没存 ——
        // 「那天那条语音说了什么」恰恰是最难凭空补上的部分。
        const sense = Array.isArray(m.sensory) && m.sensory.length ? renderSensory(m.sensory) : '';
        lines.push(`- ${when}${where} ${who}：${m.text}${sense}`);
      }
      return lines.join('\n');
    },

    /**
     * 渲染工作记忆的四个槽。
     *
     * 和 renderRecalled 的两个关键差别（这两条是「像人」的核心）：
     *
     * 1) 带来源标签。人分不清记忆来源就会编（Loftus 的误导信息实验），
     *    模型也一样 —— 它看到一句「想被叫老婆」会以为是刚说的。
     *    所以每条前面标清楚：他说过的 / 我自己想过 / 我们从前的流水。
     *
     * 2) 想不起来要说出来。空槽返回「我真想不起来了」而不是空字符串，
     *    这是元记忆（metamemory）—— 人知道自己不知道，模型不知道就会瞎猜。
     *    注意：查询本来就没内容时（bootstrap）返回空串，那种场景不该伪装成「想不起来」。
     */
    renderWorking(wm, { title = '【你此刻心里记着的】' } = {}) {
      const core = wm?.core ?? [];
      const recent = wm?.recent ?? [];
      const relevant = wm?.relevant ?? [];
      const cold = wm?.cold ?? [];
      const procedural = wm?.procedural ?? [];
      const milestone = wm?.milestone ?? [];
      const faint = wm?.faint ?? [];
      const insight = wm?.insight ?? [];
      const total = core.length + recent.length + relevant.length + cold.length
        + procedural.length + milestone.length + faint.length + insight.length;
      if (!total) {
        if (!String(wm?.query || '').trim()) return '';
        return `${title}\n- （关于这个我真想不起来了。想不起来就想不起来，别编 —— 可以直接问，或者老实说记不得。）\n\n`;
      }
      const lines = [title, '（这些是你自己记着的，不是对方刚说的。挑真的相关的提一句就好，别整段复述、别硬塞）'];
      // 「刚刚才发生的」不能写死 —— 实测 21 小时前的事也被贴上这个标签，
      // 模型于是把前天中午的话当成刚说的，接话就错（这是最像人的一种错：
      // 人不会把昨天中午当刚才）。按真实间隔分档。
      const agoLabel = (m) => {
        const at = Number(m.at || m.createdAt) || 0;
        if (!at) return '';
        const hours = (Date.now() - at) / 3600000;
        if (hours < 0) return '';
        if (hours < 1) return '（刚刚才发生的）';
        if (hours < 6) return `（${Math.max(1, Math.round(hours))} 小时前）`;
        if (hours < 30) return '（前一天的事，不是刚说的）';
        if (hours < 24 * 7) return `（${Math.round(hours / 24)} 天前）`;
        return '';
      };
      const tag = (m, kind) => {
        if (m.kind === 'profile') return '（你对这个人的印象）';
        if (m.kind === 'core') return '（你绝不会忘的事）';
        if (kind === 'recent') return agoLabel(m) || '（刚刚才发生的）';
        if (kind === 'relevant') return '（以前说过的）';
        if (kind === 'cold') return '（很久以前的了，模模糊糊，别当成刚发生的事）';
        if (kind === 'procedural') return '（这是你摸索出来的做法，照这个来）';
        if (kind === 'milestone') return '（这是你们的转折点之一）';
        if (kind === 'faint') return '（这条你记不太清了，只能想起个大概，别当成确凿的事）';
        if (kind === 'insight') return '（这是你自己后来琢磨出来的，不是他说的 —— 可以说「我后来想明白了」）';
        return '';
      };
      // 元记忆：把置信度翻成人话写进提示词。原来只在 recall 接口里返回，
      // 提示词里一个字都没有 —— 于是模型把所有回忆当成一样确定，编起来没负罪感。
      const sure = (m) => {
        const c = Number(m.confidence);
        if (!Number.isFinite(c)) return '';
        if (c >= 0.72) return '';
        if (c >= 0.45) return '（你记得，但细节可能不准，别说得太死）';
        if (c > 0.12) return '（只有个影子，说出来时留个余地）';
        return '';
      };
      const fmt = (m) => {
        const when = m.at ? new Date(Number(m.at)).toISOString().slice(0, 16).replace('T', ' ')
          : m.createdAt ? new Date(Number(m.createdAt)).toISOString().slice(0, 10) : '';
        const parts = [when, m.who || ''].filter(Boolean).join(' ');
        // 感知摘要（语音说了什么 / 图里是什么）跟正文一起渲染：
        // 感知记忆的价值全在「当时那段感知的内容」，只留一个 uri 等于没记。
        const sense = Array.isArray(m.sensory) && m.sensory.length ? renderSensory(m.sensory) : '';
        const body = `${m.text || ''}${sense}`;
        return parts ? `${parts}：${body}` : body;
      };
      for (const m of core) lines.push(`- ${fmt(m)}${tag(m, 'core')}`);
      for (const m of recent) lines.push(`- ${fmt(m)}${tag(m, 'recent')}`);
      for (const m of relevant) lines.push(`- ${fmt(m)}${tag(m, 'relevant')}${sure(m)}`);
      // 「我自己想通的」单独一块，跟「他说过什么」在视觉上隔开 ——
      // 混在一起时模型会把联想当原话复述（「你说过…」其实是它自己推的）。
      for (const m of insight) lines.push(`- 【我自己琢磨的】${String(m.text || '')}${tag(m, 'insight')}`);
      for (const m of cold) lines.push(`- ${fmt(m)}${tag(m, 'cold')}`);
      // 程序记忆的格式不一样：它不是「谁说过什么」，而是「下次该怎么做」。
      for (const p of procedural) lines.push(`- 做法：${p.skill} —— ${String(p.steps || '').slice(0, 160)}${tag(p, 'procedural')}`);
      for (const m of milestone) lines.push(`- ${fmt(m)}${tag(m, 'milestone')}`);
      for (const m of faint) lines.push(`- ${fmt(m)}${tag(m, 'faint')}`);
      // 一句通用的元记忆边界：告诉她「不记得」在这套系统里是被允许的。
      // 没有这句，模型会把「空槽」当成「我不该说话」，或者干脆编。
      lines.push('- （以上没写到的，就是真的不记得了。不记得就说不记得，别编 —— 直接问一句，比瞎猜更好。）');
      return `${lines.join('\n')}\n\n`;
    },
    /** 全量导出（迁移用）。episodic 交回原始行，不加工。 */
    exportAll() {
      const episodic = {};
      for (const day of allEpisodicDays()) episodic[day] = readEpisodic(day);
      return {
        version: 1,
        exportedAt: now(),
        semantic: semantic.slice(),
        pending: pending.items.slice(),
        episodic,
        consolidatedThrough: index.consolidatedThrough || '',
      };
    },
    /** 导入（迁移用）。默认 merge：同 id 跳过，不覆盖本地已有的。 */
    importAll(data, { mode = 'merge' } = {}) {
      if (!data || typeof data !== 'object') throw new Error('导入数据不是对象');
      let added = 0;
      if (mode === 'replace') {
        semantic = [];
        pending.items = [];
        for (const day of allEpisodicDays()) {
          try { fs.unlinkSync(dayFile(day)); } catch {}
        }
      }
      const seen = new Set(semantic.map((m) => m.id));
      for (const m of Array.isArray(data.semantic) ? data.semantic : []) {
        if (!m || !m.text) continue;
        if (seen.has(m.id)) continue;
        semantic.push(m);
        seen.add(m.id);
        added += 1;
      }
      const seenPending = new Set(pending.items.map((m) => m.id));
      for (const m of Array.isArray(data.pending) ? data.pending : []) {
        if (!m || !m.text || seenPending.has(m.id)) continue;
        pending.items.push(m);
        seenPending.add(m.id);
        added += 1;
      }
      if (data.episodic && typeof data.episodic === 'object') {
        for (const [day, rows] of Object.entries(data.episodic)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(rows)) continue;
          const file = dayFile(day);
          const existing = mode === 'replace' ? [] : readEpisodic(day);
          const ids = new Set(existing.map((m) => m.id));
          const next = existing.slice();
          for (const m of rows) {
            if (!m || !m.text || ids.has(m.id)) continue;
            next.push(m);
            ids.add(m.id);
            added += 1;
          }
          if (next.length) {
            fs.writeFileSync(file, next.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
          }
        }
      }
      if (data.consolidatedThrough) index.consolidatedThrough = String(data.consolidatedThrough);
      saveSemantic();
      savePending();
      saveIndex();
      invalidate();
      return { added, semantic: semantic.length, pending: pending.items.length };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 巩固：把一天的情景记忆炼成语义记忆
// ─────────────────────────────────────────────────────────────
//
// 这里刻意**不调模型**：巩固跑在凌晨，用户不在场，一次模型调用几百秒还可能失败。
// 纯本地做三件事，效果已经比「什么都不做」好一个量级：
//   1) 统计当天出现最多的人与关键词，挑出「值得记的」那条原文
//   2) 把同一天里反复出现的同一类事合并成一条语义记忆（描述性，不编造）
//   3) 给已有语义记忆补一次 hits（当天又被提到过 = 又复习了一次）
// 真正需要「理解」的提炼交给模型自己用 qq_memory_remember 写，两边互补。
export function consolidateDay(store, day, { log = () => {}, now = () => Date.now(), markProgress = true } = {}) {
  const rows = store.readDay(day);
  if (!rows.length) return { day, learned: 0, reinforced: 0, skipped: true };

  // 按 who 分组，找每人当天「情绪最重」的一句话。
  // self 消息单独一组（who='我'）：原来直接 continue 掉，纯本地兜底巩固时
  // 我说过的话一句都进不了语义层 —— 兜底也该兜住「我今天说过什么」。
  const byWho = new Map();
  for (const r of rows) {
    const key = r.self === true ? '我' : (r.speakerId || r.who || '某人');
    if (!byWho.has(key)) byWho.set(key, []);
    byWho.get(key).push(r);
  }

  let learned = 0;
  let reinforced = 0;
  const stamp = now();

  for (const [who, list] of byWho) {
    // 只处理说够话的人（一句话的路人不必进长时记忆）
    // self 组的门槛放宽到 1 条：我一天本来就说不了几句独立立场的话，
    // 用「≥3 条」的门槛等于把 self 组整体关掉。
    if (who === '我' ? list.length < 1 : list.length < 3) continue;
    const ranked = list
      .map((r) => ({ r, w: emotionWeight(r.text) + Math.min(1.5, r.text.length / 200) }))
      .sort((a, b) => b.w - a.w);
    const best = ranked[0]?.r;
    if (!best) continue;
    const already = store.allSemantic().some((m) => m.text && m.text === best.text);
    if (already) {
      reinforced += 1;
      continue;
    }
    store.remember(best.text, {
      kind: 'semantic',
      layer: 'long',
      who: best.who || who,
      where: best.where || '',
      importance: Math.round(clamp(emotionWeight(best.text) + 1, 1, 5)),
      at: best.at || stamp,
      source: 'consolidate',
      tags: ['巩固', day],
    });
    learned += 1;
  }

  // 水位推进要显式请求。
  //
  // 为什么不能无条件推进：这个函数是「最小巩固」——只抄每人一句情绪最重的原文，
  // 不做画像、不做习惯聚合、不抽属性、不查冲突。一旦它顺手把水位推过去，
  // 跑在它后面的「完整巩固」（memory-local-digest 的 digestDay 和模型版
  // consolidatePendingWithModel）就会因为 `d > through` 为空而一天都捞不到。
  // 历史上正是迁移路由在末尾调了它、于是水位被推到「今天」，完整巩固从装好起
  // 一天都没跑过（画像永远 null、attr 覆盖率 3/47）。
  // 所以默认不推进；只有调用方明确知道「这就是这一天的最终处理」时才传 true。
  if (markProgress) store.markConsolidated(day);
  log(`[memory] 巩固 ${day}：${rows.length} 条情景 → 新学 ${learned} 条，强化 ${reinforced} 条`);
  return { day, learned, reinforced, episodic: rows.length };
}

/**
 * 补跑：从上次水位之后逐天巩固。
 * 上限 maxDays 防止第一次上线时一口气处理几百天（会卡住事件循环）。
 *
 * markProgress 透传给 consolidateDay —— 迁移路由用它是「搬完顺手抄一句」，
 * 不能因此宣布这一天已经巩固完成。真正的终点是 memoryTick 里的完整巩固。
 */
export function consolidatePending(store, { maxDays = 3, log = () => {}, now = () => Date.now(), markProgress = false } = {}) {
  const days = store.listDays();
  const through = store.consolidatedThrough();
  const todo = days.filter((d) => !through || d > through).slice(0, maxDays);
  const out = [];
  for (const day of todo) {
    try {
      out.push(consolidateDay(store, day, { log, now, markProgress }));
    } catch (error) {
      log(`[memory] 巩固 ${day} 失败：${error?.message ?? error}`);
    }
  }
  return out;
}
