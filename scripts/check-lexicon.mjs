// CI 用：确认词表装上了、自学习词表生效
import { lexiconStats, segment, hasLexicon, isCue } from '../src/memory-lexicon.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) fail += 1;
};

const stats = lexiconStats();
console.log('词表状态:', JSON.stringify(stats));

check(hasLexicon(), '通用词表能装上');
check(stats.dictWords >= 100000, `通用词表规模 ≥10 万（实际 ${stats.dictWords}）`);
check(stats.freqWords >= 19000, `词频表规模 ≥1.9 万（实际 ${stats.freqWords}）`);
check(stats.learned > 0, `自学习词表非空（实际 ${stats.learned} 词）`);

// 自学习词必须是一个整体
for (const w of ['大肥鱼', '小鲸鱼', '鲸鱼娘']) {
  const seg = [...segment(w)];
  check(seg.length === 1, `「${w}」是一个词（实际切成 ${seg.join('|') || '(空)'}）`);
}

// 疑问词必须被挡
for (const w of ['怎么样', '什么', '几点']) {
  check(!isCue(w), `「${w}」不算线索`);
}

// 偏好词必须留
for (const w of ['喜欢', '答应']) {
  check(isCue(w), `「${w}」算线索`);
}

if (fail) {
  console.error(`\n${fail} 项检查失败`);
  process.exit(1);
}
console.log('\n词表检查全部通过');
