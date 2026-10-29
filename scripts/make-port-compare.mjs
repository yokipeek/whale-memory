// 把「HTTP API」和「WS 服务端」两页合成一张对比图。
//
// 为什么需要这个：两张原图版式几乎一样（都是节点配置页，只差 tab 高亮、
// 卡片标题、监听端口三处），并排放进文档里人眼会当成同一张复制了两遍 ——
// 而这两页恰恰是 config.json 填错的第一大来源。合成一张、红框圈端口、
// 下面用大字写清「填到哪个字段」，才真的不会看错。
//
// 用法：node scripts/make-port-compare.mjs
// 依赖 playwright（可选，同 shoot-*.mjs 的解析顺序）；输出
// docs/diagrams/screens/07-port-compare.png
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

const DIR = 'docs/diagrams/screens';
const OUT = path.join(DIR, '07-port-compare.png');

const b64 = (f) => fs.readFileSync(path.join(DIR, f)).toString('base64');
const httpImg = b64('05-snowluma-onebot.png');
const wsImg = b64('06-snowluma-ws.png');

// 原图 1280x720，有效区域（tab 行 + 端点卡片）大致在 x 355→1250、y 145→340
const CROP = { left: 355, top: 145, right: 1250, bottom: 340 };
const CW = CROP.right - CROP.left; // 895
const CH = CROP.bottom - CROP.top; // 195
const SCALE = 1050 / CW; // 显示宽度 1050

// 红框只圈「监听地址」那一行 —— 那才是要抄进 config.json 的东西。
// 原图坐标：端口文字在 x 380→560、y 268→294 附近（1280x720 原图）。
const RING = { left: 368, top: 264, right: 572, bottom: 296 };
const ringStyle = `left:${(RING.left - CROP.left) * SCALE}px;top:${(RING.top - CROP.top) * SCALE}px;width:${(RING.right - RING.left) * SCALE}px;height:${(RING.bottom - RING.top) * SCALE}px`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; }
body {
  width: 1120px; padding: 28px 32px 24px;
  background: #f6f7f9;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #14161a;
}
h1 { font-size: 25px; letter-spacing: .3px; }
h1 small { display: block; font-size: 14px; font-weight: 400; color: #6b7280; margin-top: 7px; }
.block {
  margin-top: 20px; background: #fff; border-radius: 12px;
  border: 1px solid #e3e6eb; overflow: hidden;
}
.tag {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 14px; font-size: 15px; font-weight: 600;
  background: #f0f4ff; color: #1d4ed8; border-bottom: 1px solid #e3e6eb;
}
.tag .dot { width: 9px; height: 9px; border-radius: 50%; background: #1d4ed8; }
.crop { position: relative; overflow: hidden; height: ${CH * SCALE}px; }
.crop img {
  position: absolute;
  width: ${1280 * SCALE}px;
  left: ${-CROP.left * SCALE}px;
  top: ${-CROP.top * SCALE}px;
  max-width: none;
}
/* 红框圈住「监听地址」那一行 —— 那才是要抄进 config.json 的东西 */
.ring {
  position: absolute;
  border: 2.5px solid #e11d48; border-radius: 6px;
  background: rgba(225, 29, 72, .05);
  pointer-events: none;
}
.result {
  padding: 11px 14px 12px; border-top: 1px dashed #e3e6eb;
  font-family: ui-monospace, Consolas, monospace; font-size: 16px;
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
}
.result .k { color: #7c3aed; font-weight: 700; }
.result .v { color: #0f766e; font-weight: 700; }
.result .note { font-family: inherit; font-size: 13px; color: #6b7280; }
.warn {
  margin-top: 18px; padding: 12px 15px; border-radius: 9px;
  background: #fff1f2; border: 1px solid #fecdd3; color: #9f1239;
  font-size: 14px; line-height: 1.65;
}
.warn b { color: #be123c; }
code { font-family: ui-monospace, Consolas, monospace; background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 4px; }
</style></head>
<body>
  <h1>这两个字段，别看反了
    <small>SnowLuma「节点配置」页里两个 tab，各自对应 config.json 里不同的键</small>
  </h1>

  <div class="block">
    <div class="tag"><span class="dot"></span>tab「HTTP API」→ 卡片叫 http-default</div>
    <div class="crop">
      <img src="data:image/png;base64,${httpImg}">
      <div class="ring" style="${ringStyle}"></div>
    </div>
    <div class="result">
      <span class="k">snowluma.httpUrl</span> =
      <span class="v">"http://127.0.0.1:3000"</span>
      <span class="note">← 抄这个，端口 3000</span>
    </div>
  </div>

  <div class="block">
    <div class="tag" style="background:#f5f0ff;color:#7c3aed;border-color:#e3e6eb">
      <span class="dot" style="background:#7c3aed"></span>tab「WS 服务端」→ 卡片叫 ws-default
    </div>
    <div class="crop">
      <img src="data:image/png;base64,${wsImg}">
      <div class="ring" style="${ringStyle}"></div>
    </div>
    <div class="result">
      <span class="k">snowluma.wsUrl</span> =
      <span class="v">"ws://127.0.0.1:3001"</span>
      <span class="note">← 抄这个，端口 3001</span>
    </div>
  </div>

  <div class="warn">
    <b>最常见的错法</b>：把两个都填成 <code>3001</code>（或者都填 3000）。
    填成同一个<b>不会报错</b>，桥照样启动、日志照样正常，只是 MCP 工具一调用就返回
    <code>HTTP 426</code>。看到 426 就去查这两个字段。
  </div>
</body></html>`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ locale: 'zh-CN' });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForTimeout(400);
const el = await page.$('body');
await el.screenshot({ path: OUT });
await browser.close();

console.log(`  → ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB）`);
