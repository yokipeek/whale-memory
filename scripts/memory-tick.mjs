#!/usr/bin/env node
// 定时整理脚本：跑一次，做完就退。
//
// 为什么单独一个脚本，而不是写在机器人进程里：
//   ① 机器人挂了不代表记忆不用整理 —— cron 照跑
//   ② 整理是 CPU/IO 活，跟聊天请求抢事件循环会让回复变慢
//   ③ 出问题好单独排查，不用动整个机器人
//
// 用法：
//   node scripts/memory-tick.mjs                      # 用默认 ./data/memory
//   node scripts/memory-tick.mjs --dir ./my-memory    # 指定目录
//   node scripts/memory-tick.mjs --dry-run            # 只报告不写盘
//
// 挂法（Linux/macOS）：
//   */30 * * * * cd /path/to/bot && node scripts/memory-tick.mjs >> logs/memory.log 2>&1

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DRY = args.includes('--dry-run');
const DIR = path.resolve(getArg('--dir', path.join(process.cwd(), 'data', 'memory')));
const MAX_DAYS = Number(getArg('--max-days', '3'));

const { createMemoryStore } = await import(new URL('../src/memory-core.js', import.meta.url));
const { digestPending } = await import(new URL('../src/memory-local-digest.js', import.meta.url));

if (!fs.existsSync(DIR)) {
  console.error(`✗ 数据目录不存在：${DIR}`);
  console.error('  先用 createMemoryStore({ dir }) 建一次库，或者用 --dir 指定正确路径。');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

try {
  if (DRY) {
    // dry-run 也不能手改库：只读统计 + 干跑合并
    const mem = createMemoryStore({ dir: DIR });
    const s = mem.stats();
    log('现状:', {
      semantic: s.semantic,
      episodicDays: s.episodicDays,
      consolidatedThrough: s.consolidatedThrough || '(空)',
      cold: s.cold,
    });
    const wouldMerge = mem.mergeDuplicates({ threshold: 0.95, dryRun: true });
    log('干跑合并:', wouldMerge);
    process.exit(0);
  }

  const mem = createMemoryStore({ dir: DIR });
  const before = mem.stats();

  // ①a 本地规则抽取 —— 先跑。
  //    markProgress 先设 false：水位交给后面的工序推进，
  //    否则这里就把水位推过去了，模型段一天都捞不到。
  const local = digestPending(mem, { maxDays: MAX_DAYS, log, markProgress: false });
  const useful = local.filter((d) => d.mode === 'local-full');
  if (useful.length) log('本地抽取:', useful.map((d) => ({ day: d.day, learned: d.learned, revised: d.revised })));

  // ①b 模型巩固 —— 这里没有接模型，所以直接把水位推进。
  //    如果你接了模型，把下面这行的 markProgress 交给模型那段做。
  const lastDay = local.length ? local[local.length - 1].day : '';
  if (lastDay) mem.markConsolidated(lastDay);

  // ② 衰减 + 冷库归档
  const decay = mem.decay({ coldThreshold: 0.06 });
  if (decay.cold || decay.demoted || decay.removed) log('衰减:', decay);

  // ②b 合并重复
  const merged = mem.mergeDuplicates({ threshold: 0.95 });
  if (merged && merged.merged) log('合并:', { merged: merged.merged });

  const after = mem.stats();
  log('完成:', {
    semantic: `${before.semantic} → ${after.semantic}`,
    巩固到: after.consolidatedThrough || '(空)',
    冷库: after.cold,
  });
} catch (error) {
  // 异常必须吞掉并 exit 0 —— 定时任务里非零退出会被反复告警，
  // 而记忆整理失败一次不影响主业务，下一轮再试即可。
  console.error(new Date().toISOString(), '✗ tick 失败:', error?.message ?? error);
  if (process.env.DEBUG) console.error(error);
  process.exit(0);
}
