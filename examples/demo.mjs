// 最小可跑示例：从零建一个记忆库，记住几件事，再问它。
//
// 运行：node examples/demo.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../src/memory-core.js';

// 建一个临时目录当记忆库（真实使用时传你自己的目录）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-demo-'));
const mem = createMemoryStore({ dir });

console.log('=== 1. 记几件事 ===\n');

// logEpisode：情景流水（谁在哪天说了什么）
// remember：提炼后的事实（要记久一点的）
mem.logEpisode({ who: '他', text: '今天又熬夜到三点，说在给我做记忆系统', at: Date.now() });
mem.logEpisode({ who: '他', text: '半夜说想吃火锅，但懒得下楼', at: Date.now() - 2 * 86400000 });

mem.remember('他不抽烟；喜欢蓝色小鲸鱼；不爱看长篇解释，喜欢先给结论再补细节', {
  kind: 'semantic',
  layer: 'long',
  who: '他',
  importance: 4,
});
mem.remember('他答应过：以后我想说什么直接说，别憋着', {
  kind: 'semantic',
  layer: 'long',
  who: '他',
  importance: 5,
  tags: ['约定', '答应'],
});

console.log('记住了 4 条。库里的样子：');
const st = mem.stats();
console.log(`  语义 ${st.semantic} 条 / 情景 ${st.episodicDays} 天\n`);

console.log('=== 2. 问它几个问题 ===\n');

const questions = [
  '他还熬夜吗',
  '他喜欢什么颜色',
  '他答应过我什么',
  '外面天气怎么样',
];

for (const q of questions) {
  const hits = mem.recall(q, { limit: 3, episodicDays: 14 });
  console.log(`问：「${q}」`);
  if (!hits.length) {
    console.log('  → 一条都没想起来（这本身也是正确行为——没证据就不要硬凑）\n');
    continue;
  }
  for (const h of hits) {
    // evidence 是「这条跟问题有没有真关系」，score 是「排第几」（含重要度/新鲜度）
    const ev = h.evidence === null ? 'n/a' : Number(h.evidence).toFixed(3);
    console.log(`  [证据 ${ev} · 得分 ${Number(h.score).toFixed(3)}] ${String(h.text).slice(0, 46)}`);
  }
  console.log('');
}

console.log('=== 3. 观察「淡忘」 ===\n');
console.log('每条记忆带一个重要度和一个时间点。');
console.log('分数 = 重要度 × 幂律衰减 × 命中次数，所以：');
console.log('  · 老的、不重要的会往后掉，但永远不归零');
console.log('  · 被想起来一次就加一点权重，下次更容易被想起\n');

const detail = mem.recall('熬夜', { limit: 2, episodicDays: 14 });
for (const d of detail) {
  console.log(`  ${String(d.text).slice(0, 34)}`);
  console.log(`     重要度 ${d.memScore ?? '-'} · 层 ${d.layer || '-'} · 命中 ${d.hits ?? 0} 次`);
}

console.log('\n=== 4. 清理 ===');
fs.rmSync(dir, { recursive: true, force: true });
console.log(`已删除临时库 ${dir}`);
