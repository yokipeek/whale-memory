#!/usr/bin/env node
/**
 * 装之前先查一遍环境，别装到一半才发现缺东西。
 *
 * 为什么需要它：qq-bridge 这条链路上有五个独立组件（Node / DSH / SnowLuma /
 * qq-bridge / 记忆层），每个都有自己「不满足就静默失败」的条件 ——
 * 白名单空着不报错、preset 没装不报错、端口填错只在日志里滚一行。
 * 新手装到第三步才发现第一步没做，是最常见的浪费。
 *
 * 这个脚本只读不写：不装依赖、不改配置、不启动任何东西。
 *
 * 用法：
 *   node scripts/check-env.mjs                    # 自动找桥
 *   node scripts/check-env.mjs --bridge D:\\qq-bridge
 *   node scripts/check-env.mjs --json             # 机器可读
 *
 * 退出码：0 = 全过（可以有 ⚠️）；1 = 有 ❌ 阻塞项。
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const bridgeArg = argv.indexOf('--bridge');

// ── 找桥（与 install-to-bridge.mjs 同一套逻辑） ──────────────────────────────
function looksLikeBridge(dir) {
  if (!fs.existsSync(path.join(dir, 'src', 'bridge.js'))) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (String(pkg.name || '').includes('qq-bridge')) return true;
  } catch {}
  return fs.existsSync(path.join(dir, 'src', 'mcp-snowluma-safe.js'));
}

function bridgeCandidates() {
  const list = [];
  if (bridgeArg >= 0 && argv[bridgeArg + 1]) list.push(path.resolve(argv[bridgeArg + 1]));
  if (process.env.QQ_BRIDGE_DIR) list.push(path.resolve(process.env.QQ_BRIDGE_DIR));
  list.push(path.resolve(REPO, '..', 'qq-bridge'));
  list.push(path.resolve(REPO, 'qq-bridge'));
  list.push(path.resolve(REPO, '..', 'qq-bridge-hub', 'qq-bridge'));
  let cur = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    list.push(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  list.push('C:\\Apps\\qq-bridge-hub\\qq-bridge');
  list.push('C:\\qq-bridge');
  list.push('D:\\qq-bridge');
  return [...new Set(list)];
}

// ── 结果收集 ──────────────────────────────────────────────────────────────────
const results = [];
// level: 'ok' | 'warn' | 'fail' | 'skip'
function add(step, name, level, detail, fix) {
  results.push({ step, name, level, detail, fix: level === 'ok' ? undefined : fix });
}

/** 探一个 TCP 端口通不通，超时 1.5 秒。 */
function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/** 从 ws://127.0.0.1:3001 这种字符串里抠出 host 和 port。 */
function parseEndpoint(url) {
  try {
    const u = new URL(url);
    const port = Number(u.port) || (u.protocol === 'wss:' || u.protocol === 'https:' ? 443 : 80);
    return { host: u.hostname, port, protocol: u.protocol };
  } catch {
    return null;
  }
}

async function httpGet(url, headers = {}, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch (error) {
    return { status: 0, text: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

// ── 检查开始 ──────────────────────────────────────────────────────────────────

// ① Node 版本。whale-memory 只要 18，但 qq-bridge 要 22.13 —— 报最高的那个要求。
{
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  const n = `${major}.${minor}`;
  if (major > 22 || (major === 22 && minor >= 13)) {
    add(1, 'Node 版本', 'ok', `${process.versions.node}（qq-bridge 要 ≥22.13，够了）`);
  } else if (major >= 18) {
    add(
      1,
      'Node 版本',
      'fail',
      `${process.versions.node}（本库只要 18，但 qq-bridge 硬检查 ≥22.13）`,
      '升级 Node 到 22.13 或更高（建议 22 LTS / 24）。qq-bridge 的 npm install 会直接拒。'
    );
  } else {
    add(1, 'Node 版本', 'fail', `${process.versions.node}（本库最低要 18）`, '升级 Node 到 22.13+。');
  }
}

// ② 找桥
const tried = bridgeCandidates();
const bridgeDir = tried.find((d) => looksLikeBridge(d));
let cfg = null;
let cfgRaw = '';

if (bridgeDir) {
  add(2, '找到 qq-bridge', 'ok', bridgeDir);
} else {
  add(
    2,
    '找到 qq-bridge',
    'fail',
    `试过 ${tried.length} 个位置都没找到`,
    '用 --bridge <路径> 指定，或设 QQ_BRIDGE_DIR 环境变量。'
  );
}

// ③ config.json
if (bridgeDir) {
  const cfgPath = path.join(bridgeDir, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    const ex = fs.existsSync(path.join(bridgeDir, 'config.example.json'));
    add(
      3,
      'config.json',
      'fail',
      '不存在',
      ex
        ? '复制模板：Windows CMD 用 copy config.example.json config.json；bash 用 cp。'
        : '仓库里也没有 config.example.json，桥可能不完整，重新 clone。'
    );
  } else {
    cfgRaw = fs.readFileSync(cfgPath, 'utf8');
    const hasBom = cfgRaw.charCodeAt(0) === 0xfeff;
    try {
      cfg = JSON.parse(cfgRaw.replace(/^\uFEFF/, ''));
      add(
        3,
        'config.json',
        hasBom ? 'warn' : 'ok',
        hasBom ? '能解析，但文件带 UTF-8 BOM' : `能解析（${cfgRaw.length} 字节）`,
        hasBom
          ? '桥自己读时会去掉 BOM，但你自己写脚本解析时容易踩坑（JSON.parse 报 Unexpected token）。建议存成「UTF-8 无 BOM」。'
          : undefined
      );
    } catch (error) {
      add(
        3,
        'config.json',
        'fail',
        `JSON 解析失败：${error.message}`,
        '常见原因是尾逗号、注释、或者复制时被编辑器改成了非 UTF-8。用 node -e 试着解析定位行号。'
      );
    }
  }
}

// ④ 白名单 —— 这是新手第一大坑
if (cfg) {
  const priv = Array.isArray(cfg.allow?.private) ? cfg.allow.private : [];
  const groups = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [];
  const allWhenEmpty = cfg.allowAllWhenEmpty === true;
  if (priv.length === 0 && groups.length === 0) {
    add(
      4,
      '白名单',
      allWhenEmpty ? 'warn' : 'fail',
      allWhenEmpty
        ? '空着，但 allowAllWhenEmpty: true —— 任何人和任何群都能触发机器人'
        : '空的，且 allowAllWhenEmpty: false —— 桥不会响应任何消息',
      allWhenEmpty
        ? '私用没问题。要是这号会被人加好友/拉群，建议关掉它并填白名单。'
        : '在 config.json 的 allow.private 填你的 QQ 号、allow.groups 填群号（数字，不加引号）。这是刻意的 fail-closed 默认值。'
    );
  } else {
    const badTypes = [...priv, ...groups].filter((x) => typeof x !== 'number' && !/^\d+$/.test(String(x)));
    if (badTypes.length) {
      add(
        4,
        '白名单',
        'warn',
        `已填 ${priv.length} 个私聊 + ${groups.length} 个群，但有 ${badTypes.length} 项不是纯数字`,
        `检查这些：${badTypes.slice(0, 5).join(', ')} —— 写成 "123" 字符串一般也能用，但混进 null / 对象就会静默失灵。`
      );
    } else {
      add(4, '白名单', 'ok', `${priv.length} 个私聊 + ${groups.length} 个群`);
    }
  }
}

// ⑤ ownerQQ
if (cfg) {
  if (cfg.ownerQQ) add(5, 'ownerQQ（管理员）', 'ok', String(cfg.ownerQQ));
  else
    add(
      5,
      'ownerQQ（管理员）',
      'warn',
      '没填',
      '审批、管理命令、封闭 agent 模式会全部不可用。私用不影响聊天，但控制台有些功能会灰掉。'
    );
}

// ⑥ DSH
{
  const baseUrl = cfg?.dsh?.baseUrl || 'http://127.0.0.1:3080';
  const ep = parseEndpoint(baseUrl);
  if (!ep) {
    add(6, 'DSH 可达', 'fail', `dsh.baseUrl 不是合法 URL：${baseUrl}`, '改成 http://127.0.0.1:3080 这样的完整地址。');
  } else {
    const alive = await probePort(ep.host, ep.port);
    if (alive) {
      add(6, 'DSH 可达', 'ok', `${baseUrl} 端口在听`);
    } else {
      add(
        6,
        'DSH 可达',
        'fail',
        `${baseUrl} 连不上`,
        '先把 DSH 启动起来。它没起来时桥能启动，但 memoryTick 会一直卡在 dsh-not-ready，记忆永远不整理。'
      );
    }
  }
}

// ⑦ DSH 端 preset 装没装
if (bridgeDir) {
  const markers = [
    path.join(bridgeDir, 'dsh', 'agent-presets'),
    path.join(bridgeDir, 'state', 'mode.json'),
  ];
  const hasPresetDir = fs.existsSync(markers[0]);
  const hasMode = fs.existsSync(markers[1]);
  if (hasPresetDir && hasMode) {
    add(7, 'DSH 端 preset', 'ok', 'agent-presets 与 state/mode.json 都在');
  } else if (hasPresetDir || hasMode) {
    add(
      7,
      'DSH 端 preset',
      'warn',
      `agent-presets ${hasPresetDir ? '有' : '缺'} / state/mode.json ${hasMode ? '有' : '缺'}`,
      '跑 node scripts/setup-dsh.mjs，然后**重启 DSH**。preset 和 MCP 只在 DSH 启动时加载一次。'
    );
  } else {
    add(
      7,
      'DSH 端 preset',
      'fail',
      '两者都没有，setup-dsh.mjs 大概没跑过',
      '跑 node scripts/setup-dsh.mjs，然后重启 DSH。跳过这步桥不会崩，但会拒绝建会话 —— 表现就是 QQ 上没反应。'
    );
  }
}

// ⑧ SnowLuma 两个端口
if (cfg) {
  const ws = cfg.snowluma?.wsUrl || '';
  const http = cfg.snowluma?.httpUrl || '';
  const wsEp = parseEndpoint(ws);
  const httpEp = parseEndpoint(http);

  if (!wsEp || !httpEp) {
    add(8, 'SnowLuma 端点', 'fail', `wsUrl=${ws || '空'} httpUrl=${http || '空'}`, '两个都要填完整 URL。');
  } else if (wsEp.port === httpEp.port) {
    add(
      8,
      'SnowLuma 端点',
      'fail',
      `wsUrl 和 httpUrl 用了同一个端口 ${wsEp.port}`,
      'wsUrl 填 OneBot WebSocket 端口（默认 3001），httpUrl 填 HTTP API 端口（默认 3000）。填成一样会让 MCP 工具报 HTTP 426。'
    );
  } else {
    const [wsAlive, httpAlive] = await Promise.all([
      probePort(wsEp.host, wsEp.port),
      probePort(httpEp.host, httpEp.port),
    ]);
    if (wsAlive && httpAlive) {
      add(8, 'SnowLuma 端点', 'ok', `WS ${wsEp.port} 与 HTTP ${httpEp.port} 都在听`);
    } else {
      const missing = [!wsAlive && `WS ${wsEp.port}`, !httpAlive && `HTTP ${httpEp.port}`].filter(Boolean);
      add(
        8,
        'SnowLuma 端点',
        'fail',
        `${missing.join(' / ')} 连不上`,
        'SnowLuma 没启动，或没在它的 WebUI 里开启 OneBot WebSocket 服务端 + HTTP API。这个我装不了 —— 它家 EULA 禁止脚本代部署，得你自己双击 launcher.bat 扫码。'
      );
    }
  }

  // ⑨ SnowLuma 是不是真登录了 QQ（能拿到 login_info 才算）
  if (httpEp) {
    const headers = {};
    const tok = cfg.snowluma?.accessToken;
    if (tok) {
      headers.Authorization = `Bearer ${tok}`;
      headers['X-Self-Token'] = tok;
    }
    const r = await httpGet(`${http.replace(/\/$/, '')}/get_login_info`, headers);
    if (r.status === 200) {
      let info = null;
      try {
        const j = JSON.parse(r.text);
        info = j?.data ?? j;
      } catch {}
      const nick = info?.nickname || info?.nick;
      add(9, 'SnowLuma 登录状态', 'ok', nick ? `已登录：${nick}（${info.user_id ?? '?'}）` : 'HTTP API 有响应');
    } else if (r.status === 401 || r.status === 403) {
      add(
        9,
        'SnowLuma 登录状态',
        'warn',
        `HTTP API 拒绝（${r.status}）`,
        'accessToken 不对或没填。桥里会一直刷「token 自愈失败（401）」，表情同步也会失败。'
      );
    } else {
      add(
        9,
        'SnowLuma 登录状态',
        'skip',
        r.status ? `HTTP API 返回 ${r.status}` : '连不上，跳过',
        '端点不通时这项查不了，先解决第 8 项。'
      );
    }
  }
}

// ⑩ 桥自己是不是已经在跑
if (cfg) {
  const port = Number(cfg.consolePort) || 3100;
  const alive = await probePort('127.0.0.1', port);
  add(
    10,
    '桥控制台端口',
    alive ? 'warn' : 'ok',
    alive ? `${port} 已在监听 —— 桥正在跑（或端口被别的程序占了）` : `${port} 空闲，可以启动`,
    alive
      ? '桥有单实例锁。要重启用 restart.bat，别直接再 npm start（会被拒）。查真实 PID 用 netstat -ano | grep :3100。'
      : undefined
  );
}

// ⑪ 控制台 token 有没有设
if (cfg) {
  const tok = String(cfg.consoleToken || '');
  if (tok.length >= 16) add(11, 'consoleToken', 'ok', `${tok.length} 字符`);
  else if (tok) add(11, 'consoleToken', 'warn', `只有 ${tok.length} 字符`, '太短容易被猜。控制台能改对话、能注入提示词。');
  else
    add(
      11,
      'consoleToken',
      'warn',
      '空的',
      '控制台没有鉴权。只用 127.0.0.1 的话影响不大，但填一个更稳（记得所有 curl 都带上 x-console-token）。'
    );
}

// ⑫ 记忆层装没装
if (bridgeDir) {
  const bridgeJs = path.join(bridgeDir, 'src', 'bridge.js');
  if (!fs.existsSync(bridgeJs)) {
    add(12, '记忆层', 'fail', 'src/bridge.js 不存在', '桥目录不完整，重新 clone。');
  } else {
    const src = fs.readFileSync(bridgeJs, 'utf8');
    const marks = (src.match(/\/\/ \[memory\]/g) || []).length;
    const coreFiles = fs
      .readdirSync(path.join(bridgeDir, 'src'))
      .filter((f) => /^memory-.*\.js$/.test(f));

    // 不能只数 [memory] 注释：把回忆拼进基础提示词那条补丁是「在既有行尾部追加
    // 两个变量」，它不插入注释块。所以用「关键符号都在不在」当判据，注释数量只
    // 做参考。这几个符号缺一个，对应的功能就是整段静默失效。
    const SIGNALS = [
      ["from './memory-core.js'", '记忆模块导入'],
      ['const memory = createMemoryStore(', '记忆实例'],
      ['async function memoryTick(', '定时整理函数'],
      ['function startMemoryLoop(', '整理循环启动'],
      ['memory.logEpisode(', '记流水调用'],
      ['memory.gatherWorkingMemory(', '检索注入'],
      ['recallText', '回忆文本变量'],
      ['startMemoryLoop();', '循环启动调用'],
    ];
    // 这几项是「有更好，没有也能跑」：老版本手装的桥里可能没这些东西。
    // 缺了不该报警 —— 报假警比不报更让人不信任这个脚本。
    const OPTIONAL = [
      ['memoryHintLine', '提示词里的工具用法说明（老版本没这一段，不影响检索）'],
      ['mergeDuplicates', '重复合并（1.0 之后才加）'],
    ];
    const missing = SIGNALS.filter(([needle]) => !src.includes(needle)).map(([, label]) => label);
    const missingOpt = OPTIONAL.filter(([needle]) => !src.includes(needle)).map(([, label]) => label);

    if (marks === 0) {
      add(
        12,
        '记忆层',
        'warn',
        '没装（bridge.js 里 0 处 [memory] 标记）',
        '跑 node scripts/install-to-bridge.mjs（先干跑看它要改什么），认对了再加 --apply。'
      );
    } else if (missing.length) {
      add(
        12,
        '记忆层',
        'warn',
        `装了但缺 ${missing.length} 处：${missing.join('、')}（${coreFiles.length} 个 memory-*.js）`,
        '上游大概改了代码让某个锚点失配。重跑安装器看哪一条报「锚点找不到」，按提示搜相近代码改 find。'
      );
    } else {
      // 配置里 memory 段开没开
      const memEnabled = cfg?.socialV2?.memory?.enabled;
      if (memEnabled === false) {
        add(12, '记忆层', 'fail', '已装齐，但 config.json 里 socialV2.memory.enabled = false', '改成 true，或者直接删掉这个键（默认就是开）。');
      } else {
        const extra = missingOpt.length ? `；可选未装：${missingOpt.join('、')}` : '';
        add(12, '记忆层', 'ok', `${coreFiles.length} 个 memory-*.js，关键符号齐全${extra}`);
      }
    }
  }
}

// ⑬ 词表
if (bridgeDir) {
  const learnPath = path.join(bridgeDir, 'data', 'jieba-learned.txt');
  const dictPath = path.join(bridgeDir, 'data', 'jieba-dict.txt');
  if (!fs.existsSync(dictPath)) {
    add(13, '词表', 'fail', 'data/jieba-dict.txt 不存在', '安装器会把词表拷进去。先跑 install-to-bridge.mjs。');
  } else if (fs.existsSync(learnPath)) {
    const n = fs.readFileSync(learnPath, 'utf8').split('\n').filter(Boolean).length;
    add(13, '词表', 'ok', `基础词表就位，自学词 ${n} 条`);
  } else {
    add(
      13,
      '词表',
      'warn',
      '基础词表就位，但还没学过自己的词',
      '聊一周后跑 node scripts/learn-lexicon.mjs 看看能挖出什么，觉得对再加 --apply。'
    );
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────────────
const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭ ' };
const fails = results.filter((r) => r.level === 'fail');
const warns = results.filter((r) => r.level === 'warn');

if (asJson) {
  console.log(JSON.stringify({ bridge: bridgeDir, results, ok: fails.length === 0 }, null, 2));
} else {
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  whale-memory 环境检查（只读，不改任何东西）');
  console.log(`  仓库：${REPO}`);
  console.log(`  目标桥：${bridgeDir || '（没找到）'}`);
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
  for (const r of results) {
    console.log(`${ICON[r.level]} ${r.name}：${r.detail}`);
    if (r.fix && r.level !== 'ok') {
      for (const line of wrap(r.fix, 76)) console.log(`     → ${line}`);
    }
  }
  console.log('');

  if (fails.length === 0 && warns.length === 0) {
    console.log('  全部正常，可以往下走了。');
  } else if (fails.length === 0) {
    console.log(`  没有阻塞项，但有 ${warns.length} 条提醒 —— 看一眼上面带 → 的说明。`);
  } else {
    console.log(`  ❌ ${fails.length} 个阻塞项要先解决：${fails.map((f) => f.name).join('、')}`);
    console.log('     解决完重新跑一遍这个脚本。');
  }
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
}

/**
 * 折行。按「词」拆而不是按字符拆 —— 先前按字符硬切，把 `:3100` 切成了
 * `:3` + `100` 两半，命令看起来像坏的。ASCII 串（数字、端口、命令）尽量完整。
 *
 * 还有一个细节：如果换行后只剩一两个字符（典型是句末的「。」），宁可不换 ——
 * 单独一行一个句号看起来像输出错乱。
 */
function wrap(text, width) {
  const tokens = String(text).match(/[A-Za-z0-9_:\/.\-|]+|\s+|./gu) || [];
  const out = [];
  let line = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const rest = tokens.slice(i).join('').length;
    const wouldOverflow = line.length + t.length > width && line.trim();
    // 剩下的内容很短就让它挤在本行，别留孤儿行（典型是句末「。」或「:3100。」）
    if (wouldOverflow && rest > 12) {
      out.push(line.trimEnd());
      line = t.trim() ? t : '';
    } else {
      line += t;
    }
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.length ? out : [''];
}

process.exit(fails.length === 0 ? 0 : 1);
