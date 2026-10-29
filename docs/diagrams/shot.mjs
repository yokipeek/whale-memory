// 把 archify 生成的 HTML 截成 PNG，给 README 用
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pw = await import('file:///C:/Users/Yoki/.dsh/profiles/tauri/node_modules/playwright/index.mjs');
const chromium = pw.chromium || pw.default?.chromium;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(HERE, 'whale-memory-architecture.html');
const out = path.join(HERE, 'whale-memory-architecture.png');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
await page.goto('file:///' + html.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// 尝试关掉主题浮层 / 工具栏（不影响主体）
try {
  await page.evaluate(() => {
    for (const sel of ['.toolbar', '.controls', 'header button', '.theme-toggle', 'nav']) {
      document.querySelectorAll(sel).forEach((e) => { e.style.display = 'none'; });
    }
  });
} catch {}

// 找主 SVG / 主容器，只截它
const target = await page.$('svg') || await page.$('main') || await page.$('body');
const box = await target.boundingBox();
console.log('目标尺寸:', box);

await target.screenshot({ path: out });
console.log('已截图:', out);

await browser.close();
