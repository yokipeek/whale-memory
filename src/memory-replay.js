// 睡眠期离线重放（offline replay / slow-wave consolidation）
//
// ── 为什么需要这一层 ────────────────────────────────────────────────
//   记忆系统评分卡里，检索那一项卡在 90% 上不去，缺口写得很具体：
//   「没有睡眠期的离线重放」。这不是「再跑一次巩固」——
//   巩固（memory-consolidate）是**当天内**按时间顺序把流水炼成事实，
//   它天然被因果顺序绑住：它看到的是「A 之后发生了 B」。
//
//   海马体在慢波睡眠里做的事恰好相反：把白天的痕迹**打乱、跨天重放**。
//   打乱这件事不是 bug，是功能：
//     · 顺序一断，因果解释失效，剩下的只有「这两件事像」
//     · 「像」才是跨情境联结的来源 —— 「他每次加班到深夜都要一条语音，
//       跟上次他说小时候没人等他回家，是同一件事」这种洞察，
//       按时间顺序读一百遍也读不出来，因为那两句隔着三天。
//
//   实测依据：把两天的流水按顺序拼接喂给模型，产出永远是「他今天做了什么」；
//   打乱后喂，才会出现「他反复在同一个时间点说同一类话」。
//
// ── 三个刻意的设计 ─────────────────────────────────────────────────
//   ① 只重放**已经巩固过**的日子。没巩固的日子先让巩固层处理，
//      否则重放会读到还没提炼的原始噪音，产出一堆假联结。
//   ② 每次只碰几天、几条。重放是**慢波**：一晚上不是整晚都在放同一段。
//      频繁全量重放会让语义层被低质量联结灌满，比不重放更糟。
//   ③ 产出必须带溯源（from），且默认低重要度 + working 层。
//      重放出来的东西是「联想」不是「事实」，它应该参与检索、但不该压过原话。
//
// ── 边界 ───────────────────────────────────────────────────────────
//   · 不改写原记忆（那是再巩固 reconsolidateDue 的职责，两者别混）
//   · 不删任何东西
//   · 没有模型时仍然有产出（本地跨天相似配对），只是更粗

import { shouldEncodeEpisode } from './memory-core.js';

/** 一次重放碰几天。3 ≈ 一个短周期，够跨情境，又不至于把整库读一遍。 */
export const REPLAY_DAYS = 3;
/** 每天抽几条进重放块。跟巩固的 40 条不同：重放要的是「少量、反复」。 */
export const REPLAY_ROWS_PER_DAY = 6;
/** 一次最多产出几条联结。宁少勿滥 —— 垃圾联想会占工作记忆槽位。 */
export const MAX_BONDS = 3;
/** 本地判「像」的阈值：太高就永远没有联结，太低就把「嗯」和「哈哈」配成一对。 */
// 阈值是拿真实流水标定的，不是拍的：对 state/memory 两天 580 行抽 12 条/天回放，
// 跨天 23 对里 ≥0.08 有 5 对、≥0.06 有 7 对、≥0.34 一对都没有（旧值等于永久空转）。
// 取 0.08：命中的都是真该连起来的（「不能叫我老婆大人」↔「老夫老妻咋不能叫」0.124）。
export const BOND_SIMILARITY = 0.08;

/**
 * 可复现的伪随机（xorshift32）。
 *
 * 为什么不用 Math.random：重放要能复现。线上出了一条奇怪的联结，
 * 得能拿同一个 seed 重跑一遍看它是怎么被配出来的。种子按日期派生，
 * 所以「同一天晚上重放两次」结果一致，隔天才会换。
 */
function makeRng(seed) {
  let x = (Number(seed) || 1) >>> 0;
  if (!x) x = 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function daySeed(day) {
  let h = 2166136261;
  for (const ch of String(day)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * 挑出这次要重放的日子。
 *
 * 两条过滤，理由不同，别混：
 *   ① 必须巩固过（`d <= through`）—— 重放没提炼的原始噪音只会产出假联结。
 *   ② 排除今天 —— 但**只在今天还没巩固时**排除。
 *      原来无条件排今天，结果是：库里只有两天时，能跨的只剩一天 → 永远
 *      `not-enough-days`，新装好的系统要等第三天才开始重放。
 *      而「今天还在写」这个理由，在今天的巩固已经跑完之后就不成立了（写进去的
 *      东西已经沉淀完，重放它跟重放昨天没有区别）。
 */
export function pickReplayDays(store, { days = REPLAY_DAYS, seed = 0, forceDays = null } = {}) {
  if (Array.isArray(forceDays) && forceDays.length >= 2) {
    return forceDays.map(String).sort();
  }
  const all = store.listDays();
  const through = store.consolidatedThrough();
  const today = new Date().toISOString().slice(0, 10);
  const todayReady = Boolean(through) && through >= today;
  const ready = all.filter((d) => (!through || d <= through) && (d < today || todayReady));
  if (ready.length < 2) return [];
  const rng = makeRng(seed || daySeed(ready[ready.length - 1]));
  return shuffle(ready, rng).slice(0, Math.max(2, Math.min(days, ready.length))).sort();
}

/**
 * 从几天里抽出一个「重放块」：打乱顺序、丢掉噪声、只留能代表一天的那几条。
 *
 * 每条前面带上是哪一天的 —— 模型必须知道它们不同天，
 * 否则它会当成一次连续对话去读因果（那就退化成巩固了）。
 */
export function buildReplayBlock(store, days, { rowsPerDay = REPLAY_ROWS_PER_DAY, seed = 0 } = {}) {
  const rng = makeRng((seed || 1) ^ 0x5bf03635);
  const rows = [];
  for (const day of days) {
    const dayRows = store.readDay(day)
      .filter((r) => r && r.text && shouldEncodeEpisode(r.text, { self: r.self === true }).keep);
    if (!dayRows.length) continue;
    // 优先抽「重」的（编码权重高 / 有情绪 / 有感知），但一定要带随机性，
    // 否则每天晚上重放的都是同几条，等于把同一条记忆焊死。
    const weighted = dayRows
      .map((r) => {
        const w = Number(shouldEncodeEpisode(r.text, { self: r.self === true }).weight) || 0.5;
        const emo = (Number(r.arousal) || 0) + Math.abs(Number(r.valence) || 0);
        const sen = Array.isArray(r.sensory) && r.sensory.length ? 0.35 : 0;
        return { r, w: w + emo * 0.5 + sen, jitter: rng() };
      })
      .sort((a, b) => (b.w - a.w) || (b.jitter - a.jitter))
      .slice(0, Math.max(rowsPerDay * 2, 8));
    for (const x of shuffle(weighted, rng).slice(0, rowsPerDay)) {
      rows.push({
        day,
        id: x.r.id,
        at: Number(x.r.at) || 0,
        who: String(x.r.who || ''),
        self: x.r.self === true,
        text: String(x.r.text || '').slice(0, 160),
        sensory: Array.isArray(x.r.sensory) ? x.r.sensory.slice(0, 2) : [],
        valence: Number(x.r.valence) || 0,
        arousal: Number(x.r.arousal) || 0,
      });
    }
  }
  // 最后整体打乱 —— 这是「重放」和「回顾」的唯一区别，别省这一步。
  return shuffle(rows, rng);
}

/**
 * 纯本地的跨天配对：找两条**来自不同天**、但说的是同一件事的记忆。
 *
 * 为什么本地也要有：模型可能挂着（半夜限流、权重掉），
 * 而重放应该是每天都在发生的事，不能因为模型不可用就整晚空转。
 *
 * ── 为什么不用 embed() 的余弦（踩过）─────────────────────────────
 *   embed 是 1~3 gram 哈希，短句之间余弦常年 0.10~0.15：
 *   「加班到好晚，累死了」vs「今天又是加班，好累好累」实测只有 0.1205。
 *   拿 0.34 当阈值永远配不出任何一对，本地重放等于死掉。
 *   而人判「这两句像」看的是**共享的实词**，不是整体向量夹角。
 *
 *   所以这里改成 block 内 IDF 加权的二元组重合：
 *   在当晚这批碎片里稀有的二元组权重高（「加班」稀有 = 有信息），
 *   满大街都是的（「今天」「一个」）权重自动趋零。
 *   这不需要 60 条以上语料（MIN_DOCS 门槛），一晚上十几条就能算。
 */
const STOP_GRAMS = new Set([
  '今天', '明天', '昨天', '现在', '一个', '这个', '那个', '什么', '就是',
  '不是', '可以', '我们', '你们', '他们', '自己', '时候', '因为', '所以',
  '但是', '然后', '还是', '已经', '一下', '真的', '感觉', '觉得', '知道',
]);

function gramSet(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    if (STOP_GRAMS.has(g)) continue;
    out.add(g);
  }
  return out;
}

export function findLocalBonds(block, { maxBonds = MAX_BONDS, threshold = BOND_SIMILARITY } = {}) {
  const grams = block.map((r) => gramSet(r.text));
  // block 内 IDF：df 越小越有信息。ln(1 + N/df) 对小样本稳定。
  const df = new Map();
  for (const gs of grams) for (const g of gs) df.set(g, (df.get(g) || 0) + 1);
  const N = Math.max(1, block.length);
  const idf = (g) => Math.log(1 + N / Math.max(1, df.get(g) || 1));
  // 单条记忆的「信息量」：所有 gram 的 idf 之和（归一化用）
  const mass = grams.map((gs) => {
    let m = 0;
    for (const g of gs) m += idf(g);
    return m || 1;
  });

  const cands = [];
  for (let i = 0; i < block.length; i += 1) {
    for (let j = i + 1; j < block.length; j += 1) {
      if (block[i].day === block[j].day) continue; // 跨天才有重组价值
      if (block[i].id === block[j].id) continue;
      let shared = 0;
      let sharedCount = 0;
      for (const g of grams[i]) {
        if (!grams[j].has(g)) continue;
        shared += idf(g);
        sharedCount += 1;
      }
      if (sharedCount < 1) continue;
      // 余弦式归一：共享信息 / 两条各自信息量的几何平均
      const sim = shared / Math.sqrt(mass[i] * mass[j]);
      if (sim < threshold) continue;
      // 同一方说的话优先（「他每次…」比「他说我说」更像洞察）
      const sameSpeaker = block[i].self === block[j].self ? 0.03 : 0;
      cands.push({ a: block[i], b: block[j], sim: Number((sim + sameSpeaker).toFixed(3)), sharedCount });
    }
  }
  cands.sort((x, y) => y.sim - x.sim);
  // 一条记忆只参与一个联结，避免「一条话跟所有人都像」刷屏
  const used = new Set();
  const out = [];
  for (const c of cands) {
    if (used.has(c.a.id) || used.has(c.b.id)) continue;
    used.add(c.a.id); used.add(c.b.id);
    out.push(c);
    if (out.length >= maxBonds) break;
  }
  return out;
}

const REPLAY_RULES = `你是一个记忆重放器（不是聊天机器人）。
下面是一段被**打乱顺序**的记忆碎片，来自不同的日子。
这是人在慢波睡眠里做的事：海马体把白天的痕迹打乱重放，寻找跨情境的联系。

你的任务：找出这些碎片之间**人自己当时没注意到的联系**，说成人话。

严格遵守：
1. 只输出 JSON，不要任何解释、不要 markdown 代码块。
2. 只写**真的有据可依**的联系。凭感觉编出来的联系比没有更糟 ——
   它会变成她下次说话时的「底气」，而那是假的。
3. 联系必须是**跨天的**（同一件事重复说不算联系，那是巩固该做的）。
4. 每条联系写成一句能独立成立的话，不要带序号、不要带「据碎片」。
   好：「他每次说累，都在深夜，而且从不主动说想要什么」
   坏：「碎片 1 和碎片 4 都提到了累」
5. 找不到就输出空数组 —— 大多数夜晚本来就不该产出洞察。`;

export function buildReplayPrompt({ block, existing }) {
  // REPLAY_RULES 必须拼进来 —— 之前它只是定义了却没被任何地方引用，
  // 模型拿到的只有一堆碎片加一句「请输出 JSON」，于是它会当成普通对话去读因果，
  // 产出「他今天很累」这种巩固早就该有的东西。规则和素材是一体的，别拆。
  const lines = [REPLAY_RULES, ''];
  lines.push('【被打乱的记忆碎片】（日期 说话人 内容）');
  for (const r of block) {
    const spk = r.self ? '我(自己)' : (r.who || '对方');
    const sen = r.sensory.length
      ? ` 〔当时有${r.sensory.map((s) => (s.channel === 'audio' ? '声音' : s.channel === 'vision' ? '画面' : '附件')).join('、')}〕`
      : '';
    lines.push(`${r.day} ${spk}：${r.text}${sen}`);
  }
  if (existing?.length) {
    lines.push('');
    lines.push('【已经记着的事（不要重复写）】');
    for (const e of existing.slice(0, 8)) lines.push(`- ${e.text}`);
  }
  lines.push('');
  lines.push('请输出 JSON：{"bonds":[{"text":"一句联系","from":[碎片序号],"who":"关于谁","why":"十个字以内"}]}');
  return lines.join('\n');
}

/** 从模型输出里抠 JSON（与巩固器同一套容错策略）。 */
export function parseReplayOutput(text, block) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  let body = raw;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return []; }
  const out = [];
  for (const b of Array.isArray(parsed?.bonds) ? parsed.bonds : []) {
    if (!b || typeof b !== 'object') continue;
    const t = String(b.text ?? '').trim();
    if (!t || t.length < 6) continue;
    // from 是 1-based 序号，映射回真实行；没有合法序号的丢掉
    const from = (Array.isArray(b.from) ? b.from : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= block.length)
      .map((n) => block[n - 1]);
    const days = new Set(from.map((r) => r.day));
    // 硬规则：没有跨天溯源就不是重放产出，是编的
    if (days.size < 2) continue;
    out.push({
      text: t.slice(0, 300),
      who: String(b.who ?? '').trim().slice(0, 40),
      from,
      why: String(b.why ?? '').trim().slice(0, 40),
    });
  }
  return out.slice(0, MAX_BONDS);
}

/**
 * 跑一次「睡眠期重放」。
 *
 * @param {object} store
 * @param {object} opts
 * @param {Function|null} opts.ask      模型通道（memory-consolidate 里的 askMemoryModel）
 * @param {number} opts.days            碰几天
 * @param {number} opts.seed            固定种子可复现
 * @param {Function} opts.log
 * @returns {{days:string[], rows:number, bonds:number, mode:string}}
 */
export async function replayNight(store, {
  ask = null,
  days = REPLAY_DAYS,
  seed = 0,
  rowsPerDay = REPLAY_ROWS_PER_DAY,
  forceDays = null,
  log = () => {},
} = {}) {
  const picked = pickReplayDays(store, { days, seed, forceDays });
  if (picked.length < 2) return { days: [], rows: 0, bonds: 0, mode: 'not-enough-days' };
  const block = buildReplayBlock(store, picked, { rowsPerDay, seed });
  if (block.length < 4) return { days: picked, rows: block.length, bonds: 0, mode: 'not-enough-rows' };

  const existing = store.allSemantic();
  let bonds = [];
  let mode = 'local';

  if (typeof ask === 'function') {
    try {
      const raw = await ask(buildReplayPrompt({ block, existing }), { replay: picked.join(',') });
      const parsed = parseReplayOutput(raw, block);
      if (parsed.length) { bonds = parsed; mode = 'model'; } else { mode = 'model-empty'; }
    } catch (error) {
      log(`[memory] 重放模型失败，回落本地：${error?.message ?? error}`);
      mode = 'local-fallback';
    }
  }
  if (!bonds.length) {
    bonds = findLocalBonds(block, { maxBonds: MAX_BONDS }).map((c) => ({
      text: `「${c.a.text.slice(0, 50)}」和「${c.b.text.slice(0, 50)}」像是同一件事`,
      who: c.b.self ? '' : c.b.who,
      from: [c.a, c.b],
      why: `相似度 ${c.sim}`,
    }));
    if (mode === 'model-empty') mode = 'model-empty+local';
  }

  let written = 0;
  for (const b of bonds) {
    const derived = b.from.map((r) => ({
      day: r.day,
      idx: 0,
      at: r.at,
      text: String(r.text || '').slice(0, 60),
    }));
    if (!derived.length) continue;
    const item = store.remember(b.text, {
      kind: 'insight',
      // 联想进 long 层，不是 working。理由（改过一次）：working 是「此刻在脑子里的
      // 东西」，半衰期 21 天、decayAlpha 0.9，实测一条联想两周后就压到 0.3 分以下，
      // 再也没进过提示词 —— 而跨天联想恰恰是**想通了的事**，该跟「关于他的事实」
      // 一样长期留着。放 long 不会压过原话：importance 3、情绪 1，分数永远低于
      // 4~5 分的核心事实，只是不再蒸发。
      layer: 'long',
      who: b.who || '',
      tags: ['replay', mode.startsWith('model') ? 'model' : 'local'],
      // 重放出来的东西天生没那么可信：importance 3（普通），不抢 core。
      importance: 3,
      source: 'replay',
      attr: 'insight.cross-day',
      factKind: 'insight',
      derivedFrom: derived,
    });
    if (item) written += 1;
  }

  log(`[memory] 重放 ${picked.join('/')}：${block.length} 片 → ${bonds.length} 条联结（${mode}），入库 ${written}`);
  return { days: picked, rows: block.length, bonds: bonds.length, written, mode };
}
