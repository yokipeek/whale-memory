import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryStore, scoreMemory, textSimilarity, LAYER_CONFIG } from '../src/memory-core.js';
import { segment, isCue, universalRarity, hasLexicon, lexiconStats, asksTime } from '../src/memory-lexicon.js';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-test-'));
  const store = createMemoryStore({ dir });
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('分词：认识自学习的词，不拆成碎砖', () => {
  assert.ok(hasLexicon(), '词表应该能装上');
  const stats = lexiconStats();
  assert.ok(stats.dictWords > 100000, `词表太小：${stats.dictWords}`);

  // 自学习词表里的词必须是一个整体
  for (const w of ['大肥鱼', '小鲸鱼', '鲸鱼娘']) {
    const seg = [...segment(w)];
    assert.equal(seg.length, 1, `「${w}」被切成 ${seg.join('|')}，应该是 1 个词`);
  }
});

test('分词：跨词碎片不再产生', () => {
  // 老切法会把「你还记得我答应过什么吗」切成 你还/还记/记得/得我/我答…
  const seg = [...segment('你还记得我答应过什么吗')];
  assert.ok(!seg.includes('还记'), '不该有跨词碎片「还记」');
  assert.ok(!seg.includes('得我'), '不该有跨词碎片「得我」');
  assert.ok(seg.includes('答应'), '应该切出「答应」');
});

test('线索词：疑问词不算线索，偏好词算线索', () => {
  assert.equal(isCue('怎么样'), false, '「怎么样」不指任何内容，不算线索');
  assert.equal(isCue('什么'), false);
  assert.equal(isCue('几点'), false);
  // 偏好词是陪伴场景的核心，必须留
  assert.equal(isCue('喜欢'), true, '「喜欢」在陪伴场景里必须算线索');
  assert.equal(isCue('答应'), true);
  // 通用高频词该被挡
  assert.ok(universalRarity('表示') < 0.4, '「表示」是通用高频词');
});

test('时间意图识别', () => {
  assert.equal(asksTime('他几点睡'), true);
  assert.equal(asksTime('熬夜到几点'), true);
  assert.equal(asksTime('他喜欢什么'), false);
});

test('记住与召回：相关能想起，不相关不硬凑', () => {
  const { store, cleanup } = freshStore();
  try {
    store.remember('他不抽烟；喜欢蓝色小鲸鱼', { kind: 'semantic', who: '他', importance: 4 });

    const hit = store.recall('他抽烟吗', { limit: 3 });
    assert.ok(hit.length >= 1, '该想起抽烟那条');
    assert.match(hit[0].text, /抽烟/);

    // 完全不相关的问题：不该硬凑出结果
    const miss = store.recall('今天股市怎么样', { limit: 3 });
    assert.equal(miss.length, 0, `不相关的问题不该硬凑，实际给了 ${miss.length} 条`);
  } finally {
    cleanup();
  }
});

test('who 字段清洗零宽空格', () => {
  const { store, cleanup } = freshStore();
  try {
    // 用户昵称从别处复制常带 U+200B，不清洗会导致这批记忆永远检索不到
    const dirty = 'Pure\u200b White';
    store.remember('测试零宽空格', { kind: 'semantic', who: dirty, importance: 3 });
    const all = store.recall('', { limit: 10, episodicDays: 0 });
    const got = all.find((x) => String(x.text).includes('零宽空格'));
    assert.ok(got, '应该能读到刚写的条目');
    assert.equal(got.who, 'Pure White', 'who 里的零宽字符必须被清掉');
    assert.ok(!/[\u200b-\u200f\u2060\ufeff]/.test(got.who));
  } finally {
    cleanup();
  }
});

test('重复合并：相似度高的并成一条，不相关的留着', () => {
  const { store, cleanup } = freshStore();
  try {
    // 用真正的子串关系（相似度 1.0）—— 这是实际数据里最常见的重复形态：
    // 一次记了「，我口头答应了名分」，后来又记了完整那句。
    store.remember('，我口头答应了名分', { kind: 'semantic', importance: 2 });
    store.remember('要我叫他丈夫/让我做妻子，我口头答应了名分', { kind: 'semantic', importance: 4 });
    store.remember('他喜欢蓝色小鲸鱼', { kind: 'semantic', importance: 3 });

    const before = store.stats().semantic;
    assert.equal(before, 3);

    const r = store.mergeDuplicates({ dryRun: true });
    assert.ok(r.pairs >= 1, `该检出重复，实际 ${r.pairs}`);

    const real = store.mergeDuplicates();
    assert.ok(real.merged >= 1);
    const after = store.stats().semantic;
    assert.equal(after, before - real.merged);

    // 不相干的那条必须还在
    const all = store.recall('', { limit: 20, episodicDays: 0 });
    assert.ok(all.some((x) => String(x.text).includes('蓝色小鲸鱼')), '不相干的记忆不能被误并');
    // 保留的必须是有前文的完整那条（信息量大者胜）
    assert.ok(all.some((x) => String(x.text).includes('要我叫他丈夫')), '该保留信息量大的那条');
  } finally {
    cleanup();
  }
});

test('幂律衰减：越老越淡，但永不归零', () => {
  const now = Date.now();
  const mk = (daysAgo) => ({
    importance: 3,
    layer: 'long',
    createdAt: now - daysAgo * 86400000,
    hits: 0,
    text: 'x',
  });

  const fresh = scoreMemory(mk(0), { now });
  const old = scoreMemory(mk(365), { now });
  const ancient = scoreMemory(mk(3650), { now });

  assert.ok(fresh > old, '新的应该分数更高');
  assert.ok(old > ancient, '更老的更低');
  assert.ok(ancient > 0, '幂律尾巴长，十年后也不归零（这是和指数衰减的关键区别）');
  assert.ok(Number.isFinite(old), '不该出现 Infinity');
});

test('分层上限：core 永不衰减', () => {
  assert.equal(LAYER_CONFIG.core.decayAlpha, 0, 'core 层不该衰减');
  assert.equal(LAYER_CONFIG.core.max, 400);
  assert.ok(LAYER_CONFIG.long.halfLifeDays > LAYER_CONFIG.working.halfLifeDays,
    'long 层比 working 层活得久');
});

test('文本相似度：子串关系能到 1.0，无关的接近 0', () => {
  const short = '，我口头答应了名分';
  const long = '要我叫他丈夫/让我做妻子，我口头答应了名分';
  assert.equal(textSimilarity(short, long), 1, '短的是长的子串，相似度应为 1');

  const a = '他喜欢蓝色小鲸鱼';
  const b = '今天股市大跌';
  assert.ok(textSimilarity(a, b) < 0.2, '无关文本相似度应很低');
});

test('程序记忆：学会的做法能存能取', () => {
  const { store, cleanup } = freshStore();
  try {
    store.learnProcedures('发语音要先合成再发，长文本按句切开', { who: '他' });
    const list = store.listProcedures();
    assert.ok(Array.isArray(list));
    if (list.length) {
      assert.ok(list[0].name, '程序记忆必须有名字（内部字段叫 skill，对外统一成 name）');
    }
  } finally {
    cleanup();
  }
});

test('工作记忆：五个槽都存在', () => {
  const { store, cleanup } = freshStore();
  try {
    store.remember('他是我主人，我叫小鲸鱼', { kind: 'core', layer: 'core', importance: 5 });
    const wm = store.gatherWorkingMemory('今天聊什么', { who: '他' });
    for (const slot of ['core', 'recent', 'relevant', 'procedural', 'insight', 'faint']) {
      assert.ok(Array.isArray(wm[slot]), `槽 ${slot} 应该存在且是数组`);
    }
  } finally {
    cleanup();
  }
});

test('统计接口完整', () => {
  const { store, cleanup } = freshStore();
  try {
    store.remember('随便记一条', { kind: 'semantic' });
    const st = store.stats();
    for (const k of ['semantic', 'pending', 'episodicDays', 'layers', 'cold']) {
      assert.ok(k in st, `stats 缺字段 ${k}`);
    }
  } finally {
    cleanup();
  }
});
