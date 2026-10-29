// 通用中文词表 + 词频：分词器和「稀有度」双尺子用。
//
// ── 为什么要它（2026-10-29，从 dsh-fish-memory 学来的）─────────────────
//   小鲸鱼原来是字符 n-gram + LSA 语义空间。问题在**查询词的权重**：
//     「你还记得我答应过什么吗」→ n-gram 切出 你还/还记/记得/得我/我答/答应…
//     「上次说的那个猫的事情」  → 上次/次说/说的/的那/那个/个猫/猫的/的事/事情
//   一半是跨词碎片（次说、的那、个猫），它们在库里天生罕见，
//   于是被当成「稀有线索」给了高分 —— 这正是 fish-memory 注释里说的
//   「五个弱证据攒起来，看着像强证据」。
//
// ── 它提供两把尺子 ─────────────────────────────────────────────────
//   ① 分词：10.9 万词的 jieba 词表，最长匹配。切出来的是真词，没有跨词碎片。
//   ② 词频：通用中文里这个词有多常见。0 = 最常用，99 = 很具体。
//      一个词「在你自己库里罕见」还不够 —— 可能它在通用中文里也常见
//      （「表示」在你库里只出现 2 次，但它在中文里排 376 名，不是线索）。
//      两道都过才算证据。
//
// ── 读不到文件就自动退化 ────────────────────────────────────────────
//   词表缺失 → 分词退回老的 n-gram；词频缺失 → 通用稀有度恒为 1（等于不压）。
//   绝不因为文件没了就让检索崩掉。
//
// 数据来源：jieba 的 extra_dict/dict.txt.small（MIT），见 data/jieba-来源.txt

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, '..', 'data');
const DICT_PATH = path.join(DATA_DIR, 'jieba-dict.txt');
const FREQ_PATH = path.join(DATA_DIR, 'jieba-freq.txt');
// 自学习词表：从她自己的语料里挖出来的词（大肥鱼/小鲸鱼/伊蕾娜/满穗…）。
// 跟通用词表**合并**读，不是覆盖 —— 原词表不动，删掉这个文件就回到纯通用词表。
// 生成方式：node scripts/learn-lexicon.mjs --apply
const LEARNED_PATH = path.join(DATA_DIR, 'jieba-learned.txt');

let 词表 = null; // null = 还没装；空 Set = 装失败
let 词表最长 = 8;
let 词频表 = null;
let 学习词数 = 0;

function 装词表() {
  if (词表) return 词表;
  词表 = new Set();
  try {
    for (const l of fs.readFileSync(DICT_PATH, 'utf8').split('\n')) {
      const w = l.trim();
      if (w) 词表.add(w);
    }
  } catch {
    词表 = new Set(); // 读不到 → 当没有 → 调用方自动退回 n-gram
  }
  // 合并自学习词。读不到就当没有（不影响通用词表）。
  学习词数 = 0;
  try {
    for (const l of fs.readFileSync(LEARNED_PATH, 'utf8').split('\n')) {
      const w = l.trim();
      if (w && !词表.has(w)) { 词表.add(w); 学习词数 += 1; }
    }
  } catch {
    学习词数 = 0;
  }
  if (词表.size) {
    词表最长 = 2;
    for (const w of 词表) if (w.length > 词表最长) 词表最长 = w.length;
    if (词表最长 > 12) 词表最长 = 12; // 别让一条超长词条把窗口撑爆
  }
  return 词表;
}

function 装词频() {
  if (词频表) return 词频表;
  词频表 = new Map();
  try {
    for (const l of fs.readFileSync(FREQ_PATH, 'utf8').split('\n')) {
      const p = l.trim().split(/\s+/);
      if (p.length < 2) continue;
      const v = Number(p[1]);
      if (p[0] && Number.isFinite(v)) 词频表.set(p[0], v);
    }
  } catch {
    词频表 = new Map();
  }
  return 词频表;
}

/** 词表是否可用（读不到时调用方该退回 n-gram）。 */
export function hasLexicon() {
  return 装词表().size > 0;
}

/** 通用中文稀有度 0~1：1 = 很具体（少见），0 = 最常用。不在表里 = 很具体。 */
export function universalRarity(word) {
  const m = 装词频();
  if (!m.size) return 1;
  const v = m.get(String(word));
  if (v === undefined) return 1;
  return v / 99;
}

/** 通用中文里最常用的那批词不算检索线索。
 *
 * ⚠ 0.40 → 0.34 的来历（实测踩到，别凭感觉调回去）：
 *   0.40 那道线把「喜欢」(0.38) 挡在外面 —— 而「喜欢」在陪伴场景里**是最核心的线索词**。
 *   实测后果：测试里「你还记得我喜欢什么吗」切完只剩「记得」一个（「喜欢」「什么」都被挡），
 *   而记忆「他喜欢蓝色小鲸鱼」的「喜欢」也不算线索，两边对不上 → 集成测试直接挂。
 *   「表示」「正式」「比较」是 0.34~0.39 那档，必须挡；
 *   「喜欢」是 0.38，必须留。两者数值几乎重叠，说明**光靠词频表分不开**。
 *   → 门槛放到 0.34，再用下面的「情感意图词白名单」把「喜欢/讨厌」这类显式捞回来。
 *     宁可多留几个通用词（它们在本库 df 高，还有「库内稀有度」那把尺子兜着）。
 */
const 通用门槛 = 0.34;

// 情感/偏好类词：即使词频偏高也必须算线索。
// 理由：陪伴场景里「喜欢」「讨厌」「想要」问的就是偏好本身，
// 它们被挡掉等于「问喜好时查不到喜好」。
const 意图词 = new Set([
  '喜欢', '讨厌', '想要', '希望', '害怕', '在意', '烦', '爱',
  '答应', '承诺', '约定', '说好', '要求', '生气', '难过', '开心',
]);

// ── 疑问词 / 指示词 / 空壳词：永远不算线索 ────────────────────────────
//
// 为什么单独列这张表，而不是靠词频表自动挡掉：
//   「怎么样」在 jieba 词频里排 0.48 —— **过了 0.4 那道门**，因为它是三字词、
//   比「什么」(0.27) 罕见。可它一点信息量都没有。
//   实测后果：查「外面天气怎么样」，一条内容就是「怎么样」三个字的残片拿到
//   ev=0.3069 排第一 —— 它命中了 3 个线索词里的 1 个，而饱和曲线只看绝对量。
//   「什么」「怎么」因为词频低早就被挡了，只有「怎么样/为什么/什么样」这几个
//   三字疑问词会漏过去。
//
// 判据不是「词频」，是「这个词能不能指向任何具体内容」。不能的，一律不算。
const 疑问词 = new Set([
  // 三字以上、词频又不够低的（就是它们漏网）
  '怎么样', '为什么', '什么样', '是不是', '有没有', '能不能', '可不可以',
  '什么时候', '什么地方', '什么事情', '怎么回事', '怎么办', '怎么说',
  // 两字的（大部分已被词频挡掉，列上是为了不依赖词表版本）
  '怎么', '什么', '如何', '怎样', '哪些', '哪个', '哪里', '哪儿',
  '多少', '几点', '多久', '几次', '是否', '干嘛',
  // 纯指示 / 空壳
  '这个', '那个', '这些', '那些', '这种', '那种', '这样', '那样',
  '东西', '事情', '时候', '样子', '情况',
]);

// ── 时间词：单独一张表，不靠词频判断 ──────────────────────────────
//
// 为什么「几点」「什么时候」既不算线索、又要单独留着：
//   它们本身指不向任何内容（所以 isCue=false），但**问的是时间**这件事是真线索。
//   实测：「他最晚几点睡」把「几点」当疑问词排掉后，只剩「晚」「睡」两个单字
//   （各 ×0.35 降权），证据分直接归 0 —— 整轮一条记忆都想不起来。
//   而库里明明有「他常在 0-3 点出现」「凌晨三点四十醒过一次」这些。
//   → 时间词单独抽出来，交给检索层当「时间意图」用（加权时间近的条目），
//     而不是当词面线索（那会命中所有含「点」字的句子）。
export const 时间词 = /几点|什么时候|什么时候|多久|多长时间|哪天|哪一天|几号|星期几|熬夜|通宵|半夜|凌晨|早起|晚睡|睡多久|睡几个小时/u;

/** 这句话是不是在问时间（问「什么时候」而不是问「什么事」）。 */
export function asksTime(text) {
  return 时间词.test(String(text ?? ''));
}

/** 只留够格当线索的词。 */
export function isCue(word) {
  const w = String(word);
  if (疑问词.has(w)) return false;
  if (意图词.has(w)) return true; // 偏好/情感类白名单，不受词频门槛限制
  return universalRarity(w) >= 通用门槛;
}

const EN_STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'i', 'you', 'my', 'your', 'it', 'and', 'or', 'to', 'of', 'what', 'where', 'do', 'did', 'does']);

// 单字虚词：词表兜底切出单字时，这些不算线索
const 单字虚词 = new Set([...'的了着我你他她它们这那哪吗呢吧啊呀哦噢很就都也还在有是被把和与及或个只件请得地']);

/**
 * 按词表切词（最长匹配）。切出来的是真词，一个字都不丢。
 *
 * 为什么「一个字都不丢」很关键：老切法会把「她的胃」丢成「胃不好」，
 * 于是查「她的胃」只剩单字「胃」，而记忆那边切出「胃不」—— 按词比根本对不上。
 * 现在兜底单字，两边都拿得到「胃」。
 */
export function segment(text) {
  const 表 = 装词表();
  const out = new Set();
  const clean = String(text ?? '').normalize('NFKC').toLowerCase();
  for (const m of clean.matchAll(/[a-z0-9]{2,}/g)) {
    if (!EN_STOP.has(m[0])) out.add(m[0]);
  }
  if (!表.size) {
    // 退化：字符 bigram（老行为），保证没有词表时也能工作
    for (const run of clean.match(/[\u4e00-\u9fa5]+/g) || []) {
      if (run.length === 1) { out.add(run); continue; }
      for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
    }
    return out;
  }
  for (const run of clean.match(/[\u4e00-\u9fa5]+/g) || []) {
    let i = 0;
    while (i < run.length) {
      let 长 = 0;
      const 上限 = Math.min(词表最长, run.length - i);
      for (let n = 上限; n >= 1; n -= 1) {
        if (表.has(run.slice(i, i + n))) { 长 = n; break; }
      }
      const w = 长 === 0 ? run[i] : run.slice(i, i + 长);
      if (!(w.length === 1 && 单字虚词.has(w))) out.add(w);
      i += 长 === 0 ? 1 : 长;
    }
  }
  return out;
}

// 切词缓存：同一句每轮都要切，缓存之后第二次起几乎不花时间
const 缓存 = new Map();
const 缓存上限 = 4000;

export function segmentCached(text) {
  const 原文 = String(text ?? '');
  const 有 = 缓存.get(原文);
  if (有 !== undefined) return 有;
  const out = segment(原文);
  if (缓存.size >= 缓存上限) 缓存.clear();
  缓存.set(原文, out);
  return out;
}

/** 只留够格当线索的词。 */
export function cueWords(text) {
  return [...segmentCached(text)].filter(isCue);
}

/** 诊断用：词表/词频表装上了没。 */
export function lexiconStats() {
  装词表();
  return { dictWords: 词表.size, freqWords: 装词频().size, maxWordLen: 词表最长, learned: 学习词数 };
}
