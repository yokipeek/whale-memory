// CI 用：确认没有运行时依赖
//
// 为什么单独写成脚本，不写在 CI 的 shell 里：
//   原来在 CI 里写 `deps=$(node -e "...")` 然后 `[ "$deps" != "0" ]`，
//   在 Node 18/20 的 runner 上这个比较永远为真（输出被 shell 吞掉或带换行），
//   导致 6 个 job 全挂在一个本该通过的检查上。
//   让 node 自己判断、自己定 exit code，不经过 shell 字符串比较，就不会有这种问题。

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const deps = Object.keys(pkg.dependencies || {});
const peer = Object.keys(pkg.peerDependencies || {});
const optional = Object.keys(pkg.optionalDependencies || {});

console.log('dependencies:', deps.length ? deps.join(', ') : '(无)');
console.log('peerDependencies:', peer.length ? peer.join(', ') : '(无)');
console.log('optionalDependencies:', optional.length ? optional.join(', ') : '(无)');

if (deps.length) {
  console.error(`\n✗ 引入运行时依赖了（${deps.length} 个）：${deps.join(', ')}`);
  console.error('  本项目零依赖是硬约束。如果确实必要，请在 PR 里说明理由。');
  process.exit(1);
}

// peer/optional 也提醒一下，但不阻塞
if (peer.length || optional.length) {
  console.log('\n⚠ 注意：有 peer/optional 依赖。零依赖约束只针对 dependencies。');
}

console.log('\n✓ 零依赖检查通过');
