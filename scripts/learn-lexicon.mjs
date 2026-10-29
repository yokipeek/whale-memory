#!/usr/bin/env node
// 从她自己的语料里挖出「新词」，补进词表副本。
//
// ── 为什么需要这个 ────────────────────────────────────────────────
//   jieba 词表是通用中文的，不认识「大肥鱼」「小鲸鱼」「富江破甲」这类
//   你们自己长出来的词。最长匹配切下去会变成单字：
//       大肥鱼 → 大 | 肥 | 鱼      （三个都是虚词/常用字，isCue 全 false）
//       富江破甲 → 富 | 江 | 破 | 甲
//   后果：问「大肥鱼是什么」一个线索词都剩不下 → 检索 0 条。
//   调阈值救不回来（这是切词错了，不是打分错了），只能把词补进词表。
//
// ── 算法（矩阵67 那套，无监督、零依赖）───────────────────────────
//   候选 n-gram（2~5 字），三个条件都要过：
//     ① 频次 ≥ MIN_FREQ        —— 没见过几次的当噪声
//     ② 凝聚度 PMI ≥ MIN_PMI   —— 这几个字总黏在一起，不是偶然共现
//     ③ 自由度 min(左熵,右熵) ≥ MIN_ENTROPY
//        —— 它左边右边能接各种字（说明它自身是个完整单位）
//           反例：「肥鱼」左边永远接「大」→ 左熵 0 → 它只是「大肥鱼」的尾巴，不是独立词
//
//   熵高 = 邻居杂乱 = 真词；熵低 = 邻居固定 = 某词的一部分。
//   这条能自动去掉「肥鱼」「鲸鱼」这种被更长真词包住的尾段。
//
// ── 不覆盖原词表 ──────────────────────────────────────────────────
//   挖出来的词写到 data/jieba-learned.txt，读取时跟原词表**合并**。
//   原词表（920KB）不动，随时可以删掉学习文件回到通用词表。
//
// 用法：
//   node scripts/learn-lexicon.mjs            # 只报告
//   node scripts/learn-lexicon.mjs --apply    # 写入 data/jieba-learned.txt

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const MEM_DIR = path.join(ROOT, 'state', 'memory');
const OUT = path.join(ROOT, 'data', 'jieba-learned.txt');
const APPLY = process.argv.includes('--apply');

// ── 参数（都按本库实测调的，注释里写了理由）──
const MIN_FREQ = 3;        // 出现不到 3 次的不算词：3 次以下基本是笔误或一次性说法
const MIN_PMI = 4.0;       // 凝聚度。2.0 太松（会把「的时」「了一」这种收进来），
                           // 5.0 太紧（「大肥鱼」只有 4.2 就被漏掉）。4.0 实测最好。
const MIN_ENTROPY = 0.9;   // 自由度。0.5 会把「肥鱼」「鲸鱼」这种尾段收进来；
                           // 1.5 会把「小鲸鱼」漏掉（它左边基本只接「是/叫/，」）。
const MIN_LEN = 2, MAX_LEN = 6;

// ── 读语料 ──
function readCorpus() {
  const chunks = [];
  const sem = path.join(MEM_DIR, 'semantic.jsonl');
  if (fs.existsSync(sem)) {
    for (const line of fs.readFileSync(sem, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.text) chunks.push(String(m.text));
        if (Array.isArray(m.tags)) chunks.push(m.tags.join(' '));
      } catch {}
    }
  }
  const epiDir = path.join(MEM_DIR, 'episodic');
  if (fs.existsSync(epiDir)) {
    for (const f of fs.readdirSync(epiDir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(epiDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.text) chunks.push(String(m.text));
        } catch {}
      }
    }
  }
  return chunks;
}

function entropy(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let h = 0;
  for (const c of Object.values(counts)) {
    const p = c / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

function main() {
  const docs = readCorpus();
  console.log(`语料：${docs.length} 段，${docs.join('').length} 字`);

  // 只取纯中文连续段（标点/数字/英文打断的地方不跨）
  const runs = [];
  for (const d of docs) {
    for (const run of d.match(/[\u4e00-\u9fa5]+/g) || []) {
      if (run.length >= MIN_LEN) runs.push(run);
    }
  }
  const joined = runs.join('\u0001'); // 段间用分隔符，避免跨段拼出假词
  const totalChars = runs.reduce((a, r) => a + r.length, 0);

  // ── ① 1~6 字候选的频次（1 字用来算 PMI）──
  const freq = new Map();
  for (let n = 1; n <= MAX_LEN; n += 1) {
    for (const run of runs) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const g = run.slice(i, i + n);
        freq.set(g, (freq.get(g) || 0) + 1);
      }
    }
  }

  // ── ② 左右邻字统计（算熵用，只对 ≥MIN_FREQ 的 2~6 字候选算）──
  const ctxL = new Map();
  const ctxR = new Map();
  for (let n = MIN_LEN; n <= MAX_LEN; n += 1) {
    for (const run of runs) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const g = run.slice(i, i + n);
        if ((freq.get(g) || 0) < MIN_FREQ) continue;
        const l = i > 0 ? run[i - 1] : '^';
        const r = i + n < run.length ? run[i + n] : '$';
        if (!ctxL.has(g)) { ctxL.set(g, {}); ctxR.set(g, {}); }
        ctxL.get(g)[l] = (ctxL.get(g)[l] || 0) + 1;
        ctxR.get(g)[r] = (ctxR.get(g)[r] || 0) + 1;
      }
    }
  }

  // ── ③ PMI + 熵，筛候选 ──
  const scored = [];
  for (let n = MIN_LEN; n <= MAX_LEN; n += 1) {
    for (const [g, c] of freq) {
      if (g.length !== n || c < MIN_FREQ) continue;
      // PMI：整段共现 vs 各字独立出现
      let pmi = Infinity;
      for (let i = 1; i < n; i += 1) {
        const left = freq.get(g.slice(0, i)) || 0;
        const right = freq.get(g.slice(i)) || 0;
        if (!left || !right) { pmi = -Infinity; break; }
        const p = c / totalChars;
        const pl = left / totalChars;
        const pr = right / totalChars;
        const v = Math.log2(p / (pl * pr));
        if (v < pmi) pmi = v;
      }
      if (!isFinite(pmi) || pmi < MIN_PMI) continue;
      const l = entropy(ctxL.get(g) || {});
      const r = entropy(ctxR.get(g) || {});
      const free = Math.min(l, r);
      if (free < MIN_ENTROPY) continue;
      scored.push({ word: g, freq: c, pmi: Number(pmi.toFixed(2)), entropy: Number(free.toFixed(2)), score: Number((pmi * free).toFixed(2)) });
    }
  }

  // 去重：如果 A 是 B 的子串且 B 的分数更高，去掉 A（「肥鱼」被「大肥鱼」压掉）
  const passed = new Set(scored.map((s) => s.word));
  const kept = scored.filter((s) => {
    for (const other of passed) {
      if (other === s.word) continue;
      if (other.length <= s.word.length) continue;
      if (!other.includes(s.word)) continue;
      const o = scored.find((x) => x.word === other);
      if (o && o.score > s.score && o.freq >= s.freq) return false;
    }
    return true;
  });

  kept.sort((a, b) => b.score - a.score);

  // 只收「原词表里没有的」—— 已有的词不用重复
  const dictPath = path.join(ROOT, 'data', 'jieba-dict.txt');
  const base = new Set();
  if (fs.existsSync(dictPath)) {
    for (const l of fs.readFileSync(dictPath, 'utf8').split('\n')) {
      const w = l.trim();
      if (w) base.add(w);
    }
  }
  const fresh = kept.filter((s) => !base.has(s.word));

  console.log(`\n候选过筛：${scored.length} → 去子串 → ${kept.length} → 词表里没有的 → ${fresh.length}`);
  console.log('\n前 40 个新词：');
  for (const s of fresh.slice(0, 40)) {
    console.log(`  ${s.word.padEnd(8)} 频${String(s.freq).padStart(3)}  PMI ${String(s.pmi).padStart(5)}  熵 ${String(s.entropy).padStart(4)}  分 ${s.score}`);
  }

  if (APPLY) {
    const lines = fresh.slice(0, 800).map((s) => s.word);
    fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
    console.log(`\n✅ 已写入 ${OUT}（${lines.length} 个词）`);
  } else {
    console.log('\n（dry-run，加 --apply 才写盘）');
  }
}

main();
