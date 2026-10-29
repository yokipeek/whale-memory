// 抓「装好之后」的三张图：SnowLuma 控制台（总览 / HTTP API / WS 服务端）。
// 这三张是文档里最容易看错的地方 —— wsUrl 填 WS 端口、httpUrl 填 HTTP 端口。
//
// 用法：
//   SNOWLUMA_PASSWORD=你的WebUI密码 node scripts/shoot-snowluma.mjs
//
// 依赖 playwright（本仓库零依赖，所以它从外部找）：
//   - 优先 PLAYWRIGHT_PATH 环境变量指向 playwright/index.mjs
//   - 否则试 DSH profile 里那份（作者本机的固定位置）
//   - 都没有就 npm i -D playwright 然后设 PLAYWRIGHT_PATH
//
// 踩过的坑（都真踩了）：
//   1. Windows 绝对路径在 ESM 里必须走 file:// URL，否则 ERR_UNSUPPORTED_ESM_URL_SCHEME
//   2. playwright-core 只导出 client/server 等内部符号，没有 chromium
//      → 必须用 playwright/index.mjs，不是 playwright-core/index.js
//   3. 侧边栏是 <a title="节点配置">，文字是「标题 + 副标题」两行，
//      getByText(..., {exact:true}) 匹配不到 → 用 a[title="..."] 选
//   4. 「登录成功 → 正在进入控制台」会重载整个 app，等 networkidle + 6 秒才到位，
//      否则抓到的是一片空白（只剩右下角一个 toast）
//   5. 清理浮层时别遍历 div 的 textContent 去 remove —— 会把 #root 一起删掉，
//      截图变成 4 KB 纯白板。只碰 a/button/span/li
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

const PASSWORD = process.env.SNOWLUMA_PASSWORD || '';
if (!PASSWORD) {
  console.error('缺 SNOWLUMA_PASSWORD 环境变量（SnowLuma WebUI 的登录密码）');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:5099', { waitUntil: 'networkidle', timeout: 30000 });
await page.locator('input[type=password], input[type=text]').first().fill(PASSWORD);
await page.getByRole('button', { name: /进入控制台/ }).click();
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);

if (!(await page.locator('a[title="节点配置"]').count())) {
  await page.waitForTimeout(6000);
}
console.log('侧边栏就绪:', (await page.locator('a[title="节点配置"]').count()) ? '是' : '否');

// 浮层清掉（只碰 a/button/span/li，不碰 div —— 见文件头第 5 条）
async function clean(p) {
  await p
    .evaluate(() => {
      document.querySelectorAll('a,button,span,li').forEach((el) => {
        if (/有新版本可用/.test(el.textContent || '') && (el.textContent || '').length < 60) {
          el.remove();
        }
      });
    })
    .catch(() => {});
}

// 截图会进公开仓库：QQ 号、头像、token 全部打码
async function redact(p) {
  await p
    .evaluate(() => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const a = [];
      while (w.nextNode()) if (/\d{7,}/.test(w.currentNode.nodeValue || '')) a.push(w.currentNode);
      a.forEach((n) => {
        n.nodeValue = (n.nodeValue || '').replace(
          /\d{7,}/g,
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
}

async function shot(name, label) {
  await clean(page);
  await redact(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, name) });
  const kb = (fs.statSync(path.join(OUT, name)).size / 1024).toFixed(0);
  console.log(`  → ${name}（${label}，${kb} KB）`);
}

await shot('04-snowluma-overview.png', '总览');

const nodeLink = page.locator('a[title="节点配置"]').first();
if ((await nodeLink.count()) > 0) {
  await nodeLink.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // 默认停在「通用设置」。切 tab 必须用 role=tab ——
  // getByText(/^HTTP API/) 会同时命中 tab 和右上角「+ 新建 HTTP API」按钮，
  // .first() 点到按钮上，切页静默失败，两次截图都是同一页（踩过）。
  const tab = (re) => page.getByRole('tab', { name: re }).first();

  async function shootTab(name, re, label) {
    const t = tab(re);
    if (!(await t.count())) {
      console.log(`  跳过 ${name}：没有匹配 ${re} 的 tab`);
      return;
    }
    await t.click({ timeout: 8000 }).catch((e) => console.log('  点击失败:', e.message));
    await page.waitForTimeout(1800);
    // 真正确认切过去了，否则截出来的是上一页
    const ok = await t.getAttribute('aria-selected');
    if (ok !== 'true') console.log(`  ⚠️ ${label} 的 tab 可能没选中（aria-selected=${ok}）`);
    await shot(name, label);
  }

  await shootTab('05-snowluma-onebot.png', /^HTTP API/, 'OneBot HTTP 端口');
  await shootTab('06-snowluma-ws.png', /^WS 服务端/, 'OneBot WS 端口');
}

await browser.close();
console.log('完成');
