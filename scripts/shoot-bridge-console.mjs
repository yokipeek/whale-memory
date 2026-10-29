// 抓桥的控制台「运行总览」——「装好之后长的什么样」。
// 用法：BRIDGE_CONSOLE_TOKEN=你的控制台令牌 node scripts/shoot-bridge-console.mjs
//      BRIDGE_CONSOLE_PORT=3100 可覆盖端口。
//
// 为什么不用 3999 那个模拟桥截图：模拟桥的 SnowLuma 那格永远是「未连接」，
// 放进文档会让人以为装坏了。这张图要证明「四格全绿」。
//
// 坑：
//   1. 真桥控制台挂着 SSE 长连接，waitUntil:'networkidle' 永远等不到 → domcontentloaded
//   2. 跑之前把 QQ 号 / 群号 / 头像 / token 打码，图要进公开仓库
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CANDIDATES = [
  process.env.PLAYWRIGHT_PATH,
  path.join(os.homedir(), '.dsh/profiles/tauri/node_modules/playwright/index.mjs'),
].filter(Boolean);

let chromium = null;
for (const p of CANDIDATES) {
  try {
    ({ chromium } = await import(
      p.startsWith('file:') ? p : pathToFileURL(path.resolve(p)).href
    ));
    if (chromium) break;
  } catch {
    /* 试下一个 */
  }
}
if (!chromium) {
  console.error('找不到 playwright。设 PLAYWRIGHT_PATH 指向 playwright/index.mjs');
  process.exit(1);
}

const OUT = 'docs/diagrams/screens';
fs.mkdirSync(OUT, { recursive: true });

const TOKEN = process.env.BRIDGE_CONSOLE_TOKEN || '';
const PORT = process.env.BRIDGE_CONSOLE_PORT || '3100';
if (!TOKEN) {
  console.error('缺 BRIDGE_CONSOLE_TOKEN（在 qq-bridge/config.json 的 consoleToken）');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();

await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`, {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForSelector('text=运行总览', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(4000);

await page
  .getByText('运行总览', { exact: true })
  .first()
  .click({ timeout: 6000 })
  .catch(() => {});
await page.waitForTimeout(2000);

await page
  .evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const a = [];
    while (w.nextNode()) if (/\d{6,}/.test(w.currentNode.nodeValue || '')) a.push(w.currentNode);
    a.forEach((n) => {
      n.nodeValue = (n.nodeValue || '').replace(
        /\d{6,}/g,
        (m) => m.slice(0, 3) + '****' + m.slice(-2)
      );
    });
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const b = [];
    while (w2.nextNode()) {
      if (/[A-Za-z0-9_-]{32,}/.test(w2.currentNode.nodeValue || '')) b.push(w2.currentNode);
    }
    b.forEach((n) => {
      n.nodeValue = (n.nodeValue || '').replace(/[A-Za-z0-9_-]{32,}/g, '••••••••••••••••');
    });
    document.querySelectorAll('img').forEach((img) => {
      const r = img.getBoundingClientRect();
      if (r.width > 0 && r.width < 90) img.style.filter = 'grayscale(1) blur(6px)';
    });
  })
  .catch(() => {});

await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, '01-bridge-console.png') });
console.log(
  '  → 01-bridge-console.png（' +
    (fs.statSync(path.join(OUT, '01-bridge-console.png')).size / 1024).toFixed(0) +
    ' KB）'
);

await browser.close();
