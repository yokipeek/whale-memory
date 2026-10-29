#!/usr/bin/env node
/**
 * 把 whale-memory 记忆层装进一个（可能已被改过的）qq-bridge。
 *
 * 为什么需要它：记忆层不是「import 一下就能用」的库 —— 它要在桥的四个位置被调用
 * （收消息记流水 / 发消息记流水 / 拼唤醒提示词时检索 / 定时巩固衰减）。这些调用点
 * 必须长在 bridge.js 里，而 bridge.js 上游一直在更新，手改一次就再也对不上了。
 *
 * 所以这里按**语义锚点**（唯一的代码片段，不是行号）打补丁：
 *   · 幂等 —— 每个补丁都有探针字符串，已装过就跳过，重跑一百次结果一样
 *   · 抗升级 —— 上游改了行号、挪了位置，只要锚点那句还在，补丁就还能落
 *   · 可回滚 —— 改之前把原文件备份成 .memory-install.bak-<时间戳>
 *   · 不覆盖用户改动 —— 只做「插入」和「在既有行尾部追加一项」，不删任何原有代码
 *
 * 用法：
 *   node scripts/install-to-bridge.mjs                      # 干跑，只报告要做什么
 *   node scripts/install-to-bridge.mjs --apply               # 真装
 *   node scripts/install-to-bridge.mjs --bridge D:\\qq-bridge --apply
 *   node scripts/install-to-bridge.mjs --apply --force-data   # 连词表也覆盖
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const forceData = argv.includes('--force-data');
const bridgeArg = argv.indexOf('--bridge');

// ── 目标桥：怎么找 ────────────────────────────────────────────────────────────
// 新用户不知道自己在哪，所以不能只认一个写死的路径。依次试：
//   ① --bridge 参数  ② 环境变量 QQ_BRIDGE_DIR  ③ 仓库旁边的 qq-bridge
//   ④ 当前目录往上逐层（用户在桥目录里跑脚本时命中）  ⑤ 常见默认位置
// 每个候选都验一遍「是不是真的 qq-bridge」，避免把十个文件拷进一个空目录。
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

const tried = bridgeCandidates();
const found = tried.find((d) => looksLikeBridge(d));
const BRIDGE = found || tried[0];

const log = (...a) => console.log(...a);
const ok = (s) => log(`  ✅ ${s}`);
const skip = (s) => log(`  ⏭  ${s}`);
const todo = (s) => log(`  📝 ${s}`);
const bad = (s) => log(`  ❌ ${s}`);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

// ── 要拷过去的源文件 ──────────────────────────────────────────────────────────
// memory-core 依赖 attention/lexicon/procedural/self/semantic/vector；
// consolidate / local-digest / replay 依赖 core。九个文件一个都不能少。
const SRC_FILES = [
  'memory-core.js',
  'memory-attention.js',
  'memory-lexicon.js',
  'memory-procedural.js',
  'memory-self.js',
  'memory-semantic.js',
  'memory-vector.js',
  'memory-consolidate.js',
  'memory-local-digest.js',
  'memory-replay.js'
];
const DATA_FILES = ['jieba-dict.txt', 'jieba-freq.txt']; // jieba-learned.txt 单独处理：不覆盖

// ── 补丁片段 ──────────────────────────────────────────────────────────────────
// 每个片段都以 `// [memory]` 开头，方便人在 diff 里一眼看出「这段是装进去的」。
const M = '// [memory]';

const P_IMPORTS = `${M} 长时记忆层（whale-memory）。安装器插入，改逻辑请改 whale-memory 源码后重跑安装器。
import { createMemoryStore } from './memory-core.js';
import { consolidateDayWithModel, consolidatePendingWithModel, reconsolidateDue } from './memory-consolidate.js';
import { digestDay, digestPending, aggregateHabits } from './memory-local-digest.js';
import { replayNight } from './memory-replay.js';`;

const P_SESSION_FILE = `${M} 记忆整理会话的落盘位置（与 slang 学习会话同构）
const MEMORY_SESSION_FILE = path.join(STATE_DIR, 'memory-agent-session.json');`;

const P_CORE = `  ${M} ── 长时记忆层（whale-memory 安装器插入，勿手改）────────────────────────────
  // 为什么放在 main() 内、loadState() 之后：三个调用点（appendSocialV2Message 记流水、
  // buildWakePromptV2 注入回忆、memoryTick 定时巩固）全在 main 作用域里。放到
  // startConsoleServer() 里的话，另外两处根本看不见这个变量。
  const memory = createMemoryStore({ dir: path.join(STATE_DIR, 'memory'), log });

  let memoryAgentSessionId = null;
  let memoryAgentPresetUsed = '';

  function invalidateMemoryAgentSession() {
    memoryAgentSessionId = null;
    memoryAgentPresetUsed = '';
    try { fs.unlinkSync(MEMORY_SESSION_FILE); } catch {}
  }

  // 记忆整理用的后台会话：只用来「问一句、答一句」，不映射 QQ、不发送。
  // 照抄上游 ensureSlangLearnerSession 的范式（同样的 preset 校验、同样的落盘结构），
  // 因为那套逻辑已经处理过「preset 变了怎么办 / 记录无法证明权限怎么办」。
  async function ensureMemoryAgentSession() {
    if (!dshReady) throw new Error('DSH 未就绪');
    const preset = resolvePresetName(cfg.memoryAgentPreset || 'standard');
    if (!preset) throw new Error('没有可用的 memoryAgentPreset');
    const saved = readJsonSafe(MEMORY_SESSION_FILE, null);
    if (saved?.preset !== preset) invalidateMemoryAgentSession();
    if (memoryAgentSessionId && memoryAgentPresetUsed === preset) {
      learnerSessions.add(memoryAgentSessionId);
      api.events.follow(memoryAgentSessionId);
      return memoryAgentSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      memoryAgentSessionId = String(saved.sessionId);
      memoryAgentPresetUsed = preset;
      learnerSessions.add(memoryAgentSessionId);
      api.events.follow(memoryAgentSessionId);
      await ensureChatModel(memoryAgentSessionId);
      return memoryAgentSessionId;
    }
    const dir = path.join(STATE_DIR, 'memory-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'memory workspace.create');
    if (wsValue.created) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: '记忆整理' }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId, agentPreset: preset };
    const value = unwrap(await api.sessions.create(params), 'memory session.create');
    memoryAgentSessionId = value.sessionId;
    memoryAgentPresetUsed = preset;
    learnerSessions.add(memoryAgentSessionId);
    api.events.follow(memoryAgentSessionId);
    await ensureChatModel(memoryAgentSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(MEMORY_SESSION_FILE, { sessionId: memoryAgentSessionId, preset });
    log(\`[memory] 记忆整理会话已创建：\${memoryAgentSessionId}（preset \${preset}）\`);
    return memoryAgentSessionId;
  }

  // 巡检上下文压力，超阈值就退役换新。
  // 为什么必须自己管：DSH 的 compaction 对这条「create 出来只问一句」的后台会话不生效，
  // 实测会一路堆到 surfaceTokens 21 万 > contextWindow 19.2 万还不压缩 —— 之后每问一次
  // 都把二十多万 token 全量发上去，既烧钱又慢。记忆整理是一次性无上下文问答，换会话零损失。
  async function maybeRotateMemorySession(reason = 'tick') {
    const cfgMem = cfg.socialV2?.memory ?? {};
    if (cfgMem.sessionRotate === false) return false;
    const ratio = Math.max(0.3, Math.min(0.95, Number(cfgMem.sessionRotateRatio ?? 0.55) || 0.55));
    let sessionId;
    try { sessionId = await ensureMemoryAgentSession(); } catch { return false; }
    let value;
    try {
      const response = await api.callUnary('session/projections', { sessionId });
      if (!response?.result?.ok) return false;
      value = response.result.value?.values ?? response.result.value;
    } catch (error) {
      log('[memory] 会话压力巡检失败：' + (error?.message ?? error));
      return false;
    }
    const pressure = value?.contextPressure;
    const used = Number(pressure?.surfaceTokens ?? pressure?.sampledSurfaceTokens ?? 0);
    const window = Number(pressure?.contextWindow ?? 0);
    if (!used || !window) return false;
    const fraction = used / window;
    if (fraction < ratio) return false;
    log(\`[memory] 记忆整理会话 \${sessionId} 用量 \${used}/\${window}（\${(fraction * 100).toFixed(0)}%）超阈值，退役换新（\${reason}）\`);
    invalidateMemoryAgentSession();
    return true;
  }

  // 问一次模型（一次性、无上下文）。超时给 90 秒：巩固是后台任务，慢没关系，卡死才要命。
  // 失败一律抛出去，由调用方决定降级 —— 这一层不许自己吞错。
  async function askMemoryModel(promptText, { timeoutMs = 90000 } = {}) {
    try { await maybeRotateMemorySession('before-ask'); }
    catch (error) { log('[memory] 巡检异常（继续用旧会话）：' + (error?.message ?? error)); }
    const sessionId = await ensureMemoryAgentSession();
    const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
    if (!accepted.result.ok) throw new Error(\`记忆整理 prompt 被拒：\${accepted.result.error.code}\`);
    return waitLearnerTurn(sessionId, timeoutMs);
  }

  let memoryLoopTimer = null;
  const memoryTickBusy = { value: false };

  /**
   * 一轮记忆整理。五段，每段独立 try/catch：一段崩了不许拖垮其余四段。
   *
   * ①a 本地巩固（不需要模型，抽事实/习惯）
   * ①b 模型巩固（写成「事实」而不是流水）
   * ②  衰减（久不用的往下沉，沉到底进冷库）
   * ②b 合并重复（同一件事说三遍别存三条）
   * ③  再巩固（跟今天新发生的事对一遍，改口了要修正）
   * ④  睡眠重放（把这几天的碎片放一起，找跨天的联系）
   *
   * ①a 必须传 markProgress:false：那会把「已巩固到哪天」的水位推到最新，
   * 于是 ①b 的模型段永远捞不到当天数据 —— 顺序和这个参数是整个 tick 最容易错的地方。
   */
  async function memoryTick(reason = 'timer') {
    if (memoryTickBusy.value) return { skipped: 'busy' };
    if (cfg.socialV2?.memory?.enabled === false) return { skipped: 'disabled' };
    if (!dshReady) return { skipped: 'dsh-not-ready' };
    memoryTickBusy.value = true;
    const out = { reason };
    try {
      const cfgMem = cfg.socialV2?.memory ?? {};
      const maxDays = Math.max(1, Number(cfgMem.consolidateDays) || 3);
      // ①a
      try {
        const r = digestPending(memory, { maxDays, log, markProgress: false });
        out.localDigest = r;
      } catch (error) { out.localDigestError = String(error?.message ?? error); log('[memory] 本地巩固失败：' + out.localDigestError); }
      // ①b
      try {
        const r = await consolidatePendingWithModel(memory, { maxDays, ask: askMemoryModel, who: '', log });
        out.consolidate = r;
      } catch (error) { out.consolidateError = String(error?.message ?? error); log('[memory] 模型巩固失败：' + out.consolidateError); }
      // ②
      try {
        const r = memory.decay({ coldThreshold: Number(cfgMem.coldThreshold ?? 0.06) });
        out.decay = r;
      } catch (error) { out.decayError = String(error?.message ?? error); log('[memory] 衰减失败：' + out.decayError); }
      // ②b
      if (cfgMem.mergeDuplicates !== false) {
        try {
          const r = memory.mergeDuplicates({ threshold: Number(cfgMem.mergeDuplicateThreshold ?? 0.95) });
          out.merge = r;
        } catch (error) { out.mergeError = String(error?.message ?? error); log('[memory] 合并失败：' + out.mergeError); }
      }
      // ③
      try {
        const r = await reconsolidateDue(memory, { ask: askMemoryModel, limit: Math.max(1, Number(cfgMem.reviewPerTick) || 3), log });
        if (Array.isArray(r?.reviewedIds) && r.reviewedIds.length && typeof memory.markReviewed === 'function') memory.markReviewed(r.reviewedIds);
        out.review = r;
      } catch (error) { out.reviewError = String(error?.message ?? error); log('[memory] 再巩固失败：' + out.reviewError); }
      // ④
      try {
        const everyMs = Math.max(60_000, Number(cfgMem.replay?.everyMs) || 3600000);
        const lastAt = Number(memory.getMeta?.('lastReplayAt') || 0);
        const due = reason === 'manual' || !lastAt || (Date.now() - lastAt) >= everyMs;
        if (cfgMem.replay?.enabled !== false && due) {
          const r = await replayNight(memory, {
            ask: askMemoryModel,
            days: Number(cfgMem.replay?.days) || 3,
            rowsPerDay: Number(cfgMem.replay?.rowsPerDay) || 6,
            seed: Number(cfgMem.replay?.seed) || 0,
            log
          });
          memory.setMeta?.('lastReplayAt', Date.now());
          out.replay = r;
        } else out.replay = { skipped: 'not-due' };
      } catch (error) { out.replayError = String(error?.message ?? error); log('[memory] 睡眠重放失败：' + out.replayError); }
      return out;
    } catch (error) {
      out.error = String(error?.message ?? error);
      log('[memory] 整理轮次异常：' + out.error);
      return out;
    } finally {
      memoryTickBusy.value = false;
    }
  }

  function startMemoryLoop() {
    if (memoryLoopTimer) clearInterval(memoryLoopTimer);
    const everyMs = Math.max(60_000, Number(cfg.socialV2?.memory?.tickMs) || 30 * 60 * 1000);
    memoryLoopTimer = setInterval(() => { void memoryTick('timer'); }, everyMs);
    memoryLoopTimer.unref?.();
    // 启动后 3 分钟补跑一次：DSH 起来要时间，立刻跑必然 dsh-not-ready。
    setTimeout(() => { void memoryTick('startup'); }, 3 * 60 * 1000).unref?.();
    log(\`[memory] 记忆整理循环已启动（每 \${Math.round(everyMs / 60000)} 分钟一轮）\`);
  }
  if (cfg.socialV2?.memory?.enabled !== false) startMemoryLoop();`;

// 探针不能跨行 —— 跨行的探针在 CRLF 文件里永远匹配不上（真实踩过：装到一半
// 「收消息记流水」这条永远报锚点找不到，因为文件是 CRLF 而片段写的是 LF）。
const P_LOG_IN = `    ${M} 记进长时记忆的流水（失败不影响主流程）
    try {
      // 习惯化要「跟最近说过的话比相似度」，这个相似度只有在这里算得出来：
      // 手里正好有最近几条 + msg，丢给 memory-core 去算就变成每轮翻一遍日志。
      let recentMaxSim = 0;
      try {
        const body = String(msg.plain || msg.text || '');
        if (body) {
          const today = new Date().toISOString().slice(0, 10);
          const rows = memory.readDay(today).slice(-6);
          const grams = (s) => {
            const out2 = new Set();
            for (let i = 0; i < s.length - 1; i += 1) out2.add(s.slice(i, i + 2));
            return out2;
          };
          for (const r of rows) {
            if (!r || r.self === true || r.speakerId !== msg.userId) continue;
            const prev = String(r.text || '');
            if (!prev) continue;
            const a = grams(body);
            const b = grams(prev);
            if (!a.size || !b.size) continue;
            let inter = 0;
            for (const g of a) if (b.has(g)) inter += 1;
            const sim = inter / (a.size + b.size - inter);
            if (sim > recentMaxSim) recentMaxSim = sim;
          }
        }
      } catch {}
      memory.logEpisode({
        where: key,
        speakerId: msg.userId,
        who: msg.sender,
        text: msg.plain || msg.text || '',
        at: msg.time,
        // 附件字段必须叫 attachments，源字段是 msg.media（不是 msg.images）。
        // 写错名字不会报错，只会让「视觉/听觉记忆」永远为空 —— 最难发现的那种静默失效。
        attachments: Array.isArray(msg.media) ? msg.media : [],
        recentMaxSim
      });
    } catch (error) { log('[memory] 记流水失败：' + (error?.message ?? error)); }
`;

const P_LOG_OUT = `      ${M} 自己说的话也要记：否则「我说过什么」永远想不起来
      try { memory.logEpisode({ where: key, self: true, who: '我', text, at: now + i * 1000 }); } catch {}`;

const P_RECALL = `    ${M} 唤醒时按「最近在聊什么 + 为什么醒」去记忆里翻一遍。
    // query 拼的是最近三条别人说的话加唤醒原因 —— 单用唤醒原因（可能只是 atMention）
    // 检索不到话题；单用最近消息又丢了「他刚 @ 我」这个当下语境。
    const recallText = (() => {
      try {
        const cfgMem = cfg.socialV2?.memory ?? {};
        if (cfgMem.enabled === false) return '';
        const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
          .filter((m) => m && m.isSelf !== true).slice(-3)
          .map((m) => String(m.plain || m.text || '')).join(' ');
        const query = \`\${recent} \${reason}\`.trim();
        // 安装器版拿不到私聊对象名字（上游没有 people 名册），who 一律留空 = 全库检索。
        // 代价是多场合的记忆会互相串味；换来的是「装完就能用」，不用先补一套人名字典。
        const wm = memory.gatherWorkingMemory(query, {
          who: '',
          episodicHours: Number(cfgMem.recentHours) || 24,
          relevantSlots: cfgMem.relevantSlots ?? 2,
          withProcedural: cfgMem.proceduralInPrompt !== false,
          withMilestone: cfgMem.autobioInPrompt !== false
        });
        return memory.renderWorking(wm);
      } catch (error) {
        log('[memory] 检索失败：' + (error?.message ?? error));
        return '';
      }
    })();
    ${M} 工具说明：不写进提示词，模型就不知道自己有记忆可查、更不会去写。
    const memoryHintLine = recallText
      ? '【你自己能记住的东西】\\n'
        + '- 想起什么用 qq_memory_recall（大白话 query 就行）；真学到新东西（他的喜好、明确说过的事实、你们之间的一件事）用 qq_memory_remember 记一条，importance 1..5 决定它多久不会忘。别每轮都写，一天记两三条够了。\\n'
        + '- 记错了用 qq_memory_forget 删；qq_memory_stats 看整体状况。前后说法对不上（以前说讨厌猫、现在说家里养了猫）就把新说法记下来，别两条并存。\\n\\n'
      : '';`;

const P_ROUTES = `        ${M} ── 长时记忆层接口（安装器插入）────────────────────────────────────
        // 两条通道：带 x-agent-token（AI 的 qq_memory_* 工具）走会话白名单 + 工具开关；
        // 不带（控制台面板）只需 console token，key 可空、who 空 = 全库检索。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-recall') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim();
          const limit = Number(url.searchParams.get('limit')) || 8;
          const agentCall = Boolean(req.headers['x-agent-token']);
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('memoryRecall')) { sendJson({ ok: false, error: '工具未启用：qq_memory_recall' }, 403); return; }
          let items = [];
          try {
            // q 为空时 recall 没有 BM25 信号，只会按记忆分吐最重要的几条 —— 那也有意义
            // （=「把你还记得最重要的事列出来」），所以不拦。
            items = memory.recall(q, { limit: Math.min(30, Math.max(1, limit)), who: '' });
          } catch (error) {
            sendJson({ ok: false, error: \`检索失败：\${error?.message ?? error}\` }, 500); return;
          }
          sendJson({
            ok: true,
            key,
            query: q,
            matched: items.length,
            text: memory.renderRecalled(items) || '（没想起相关的事）',
            items: items.map((m) => ({
              id: m.id,
              text: m.text,
              layer: m.layer,
              kind: m.kind,
              who: m.who,
              score: m.score,
              createdAt: m.createdAt || null,
              day: m.day || null,
              // 元记忆：这条有多可信。不告诉模型，它就会把所有回忆当成一样确定，编起来也没负担。
              confidence: m.confidence ?? null,
              confidenceLabel: m.confidenceLabel ?? null
            })),
            timeline: (() => {
              try {
                const t = memory.timeline({ gapDays: 3 });
                const days = Array.isArray(t.days) ? t.days : [];
                return { totalDays: Number(t.totalDays) || days.length, span: String(t.span || ''), firstDay: days[0] ?? null, lastDay: days[days.length - 1] ?? null };
              } catch { return null; }
            })(),
            conflicts: (() => { try { return memory.narrativeConflicts({ recentDays: 7 }).slice(0, 3); } catch { return []; } })(),
            sensory: (() => { try { return memory.sensoryRecall(q || '', { limit: 3 }); } catch { return []; } })()
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remember') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const text = String(body.text ?? '').trim();
          if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memoryRemember')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remember' }, 403); return; }
          const clean = redactSensitiveText(text).slice(0, 800);
          let item = null;
          try {
            const rawLayer = String(body.layer ?? '').trim();
            const layer = ['core', 'long', 'working'].includes(rawLayer) ? rawLayer : undefined;
            item = memory.remember(clean, {
              layer,
              who: String(body.who ?? '').trim(),
              where: key,
              importance: body.importance != null ? Number(body.importance) : null,
              tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 8) : [],
              source: 'ai'
            });
          } catch (error) {
            sendJson({ ok: false, error: \`记录失败：\${error?.message ?? error}\` }, 500); return;
          }
          if (!item) { sendJson({ ok: false, error: '内容为空，没记' }, 400); return; }
          sendJson({ ok: true, key, remembered: { id: item.id, text: item.text, layer: item.layer, importance: item.importance } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-pending') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const text = String(body.text ?? '').trim();
          if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const clean = redactSensitiveText(text).slice(0, 400);
          const item = memory.addPending(clean, { who: String(body.who ?? '').trim(), expiresInMs: Number(body.expiresInMs) || undefined });
          sendJson({ ok: true, key, pending: item ? { id: item.id, text: item.text, expiresAt: item.expiresAt } : null });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-stats') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (req.headers['x-agent-token'] && key && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const s = memory.stats();
          const pendingNow = memory.listPending('');
          // 「自我时间线 / 程序记忆 / 前后矛盾」这三样原本只在提示词里出现，控制台看不见。
          // 这里一并回给界面，让人能确认她到底记着个什么故事。
          const extra = {};
          try { extra.autobio = memory.autobio({ maxChars: 360 }) || null; } catch { extra.autobio = null; }
          try {
            // timeline() 的形状是 { days: [...], span, totalDays, density, peaks, lines } —— 没有 gaps 字段。
            const t = memory.timeline({ gapDays: 3 });
            const days = Array.isArray(t.days) ? t.days : [];
            extra.timeline = {
              totalDays: Number(t.totalDays) || days.length,
              firstDay: days[0] ?? null,
              lastDay: days[days.length - 1] ?? null,
              span: String(t.span || ''),
              density: Number(t.density) || 0,
              peaks: Array.isArray(t.peaks) ? t.peaks.slice(0, 5) : []
            };
          } catch { extra.timeline = null; }
          try { extra.conflicts = memory.narrativeConflicts({ recentDays: 7 }).slice(0, 5); } catch { extra.conflicts = []; }
          try { extra.procedural = memory.listProcedures().slice(0, 8); } catch { extra.procedural = []; }
          try { extra.milestones = memory.milestones({ perKind: 1 }).slice(-6); } catch { extra.milestones = []; }
          sendJson({ ok: true, stats: s, pending: pendingNow.map((m) => ({ id: m.id, text: m.text, expiresAt: m.expiresAt })), ...extra });
          return;
        }
        // 手动触发一轮整理（控制台「立即巩固一次」）。只许控制台调：这会开模型会话、烧钱、
        // 还会改写记忆 —— 让模型自己触发等于让它给自己洗脑。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-tick') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '只能从控制台触发' }, 403); return; }
          try {
            const r = await memoryTick('manual');
            sendJson({ ok: true, ...r });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-forget') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const id = String(body.id ?? '').trim();
          const agentCall = Boolean(req.headers['x-agent-token']);
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2ToolEnabled('memoryForget')) { sendJson({ ok: false, error: '工具未启用：qq_memory_forget' }, 403); return; }
          const where = memory.forget(id);
          sendJson({ ok: !!where, removed: where || null, error: where ? undefined : '没找到这条记忆' });
          return;
        }
`;

const P_CONFIG = `      ${M} 长时记忆层默认配置。用户 config.json 里的 socialV2.memory 会覆盖这里的同名键。
      memory: {
        enabled: true,
        recallLimit: 6,                 // 唤醒时按话题召回几条
        episodicDays: 14,               // 情景流水回看几天
        recentHours: 24,                // 工作记忆的「最近」槽看几小时
        relevantSlots: 2,               // 与当前话题相关的槽位
        consolidateDays: 3,             // 一轮巩固最多补几天
        reviewPerTick: 3,               // 一轮再巩固审查几条
        coldThreshold: 0.06,            // 衰到这个分数以下进冷库（沉下去但没删）
        tickMs: 1800000,                // 整理周期，默认 30 分钟
        localDigest: true,              // 本地巩固（不花模型钱）
        autobioInPrompt: true,          // 提示词里带一句「我们走到哪一步了」
        proceduralInPrompt: true,       // 提示词里带「做法/别这样做」
        sensoryRecall: true,            // 声音/画面的记忆可被翻到
        replay: { enabled: true, everyMs: 3600000, days: 3, rowsPerDay: 6, seed: 0 },
        bootstrapRecall: true,          // 首次唤醒先做一次召回兜底
        bootstrapRecallRows: 12,
        bootstrapRecallMaxChars: 1200,
        sessionRotate: true,            // 整理会话用太满就换一个（见 maybeRotateMemorySession）
        sessionRotateRatio: 0.55,
        mergeDuplicates: true,          // 同一件事说三遍别存三条
        mergeDuplicateThreshold: 0.95
      },`;

const P_MCP_FLAGS = `  ${M} 长时记忆的四个工具（三层记忆 + 检索 + 遗忘 + 统计）
  qq_memory_recall: 'memoryRecall',
  qq_memory_remember: 'memoryRemember',
  qq_memory_forget: 'memoryForget',
  qq_memory_stats: 'memoryStats',`;

const P_MCP_TOOLS = `server.tool(
  'qq_memory_recall',
  '主动回忆：按你现在想的事去记忆里翻。记忆分三层——core（永不忘记：他是谁、你是谁）、long（长时：他的喜好、明确说过的事、你们的关系）、working（短时：最近聊的）——会像人一样自然淡忘，越重要越难忘。传 query 用大白话即可（「他喜欢什么」「上次说语音那次」），不传就按重要度从高到低给你最重要的几条。返回每条带 date 和原话，聊天里自然提一句就行，别整段复述。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().optional().describe('想回忆什么，大白话就行；不传就按重要度给最重要的'),
    limit: z.number().optional().describe('要几条，默认 8，最多 30')
  },
  async ({ key, token, query, limit }) => {
    try {
      const qs = new URLSearchParams({ key: String(key ?? '') });
      if (query) qs.set('q', String(query));
      if (limit) qs.set('limit', String(limit));
      const data = await agentApi(\`/api/socialV2/memory-recall?\${qs.toString()}\`, {
        method: 'GET',
        headers: { 'x-agent-token': token },
        timeoutMs: 30000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: \`回忆失败：\${error?.message ?? error}\` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remember',
  '往记忆里记一条（会按重要度和情绪自动定它多久不会淡忘）。记什么：他明确说过的事实、他的偏好和性格、你们关系里的一件事、你自己想通的一个道理。importance 给 1..5：5=绝不忘记（他是我主人 / 我们是什么关系）、4=很重要（他的喜好、约定）、3=一般（今天发生的事）、1~2=小事。别每轮都记，一天记两三条真的就够了；重复内容会自动合并、不会存两份。想记"还没说出口的话"请传 kind="pending"。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().describe('要记住的内容，一句话写清楚（最多 800 字）'),
    importance: z.number().optional().describe('重要度 1~5，5 最难忘，默认 3'),
    layer: z.enum(['core', 'long', 'working']).optional().describe('放哪层：core 永不忘记 / long 长时 / working 短时。不传按重要度自动选'),
    who: z.string().optional().describe('这条记忆是关于谁的（昵称），不传就按会话自动判断'),
    tags: z.array(z.string()).optional().describe('最多 8 个标签，方便以后捞出来'),
    kind: z.enum(['semantic', 'pending']).optional().describe('pending=想说但还没说出口的一句话（会过期）'),
    expiresInMs: z.number().optional().describe('kind=pending 时有效：多少毫秒后过期，默认 2 小时')
  },
  async ({ key, token, text, importance, layer, who, tags, kind, expiresInMs }) => {
    try {
      if (kind === 'pending') {
        const data = await agentApi('/api/socialV2/memory-pending', {
          method: 'POST',
          body: JSON.stringify({ key, text, who: who || '', expiresInMs }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      const data = await agentApi('/api/socialV2/memory-remember', {
        method: 'POST',
        body: JSON.stringify({ key, text, importance, layer, who: who || '', tags: Array.isArray(tags) ? tags : [] }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: \`记忆写入失败：\${error?.message ?? error}\` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_forget',
  '删掉一条记错的记忆。id 从 qq_memory_recall / qq_memory_stats 的返回里拿。核心记忆（core）删之前想清楚——那多半是关系本身。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    id: z.string().describe('要删的记忆 id')
  },
  async ({ key, token, id }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-forget', {
        method: 'POST',
        body: JSON.stringify({ key, id }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: \`删除失败：\${error?.message ?? error}\` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_stats',
  '看一眼自己的记忆现状：共有多少条、分在几层、最早记到哪天、最难忘的十条是什么、心里还压着哪几句没说出口的话。偶尔翻一次就够了，不用每轮看。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      const qs = new URLSearchParams({ key: String(key ?? '') });
      const data = await agentApi(\`/api/socialV2/memory-stats?\${qs.toString()}\`, {
        method: 'GET',
        headers: { 'x-agent-token': token },
        timeoutMs: 30000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: \`统计失败：\${error?.message ?? error}\` }], isError: true };
    }
  }
);

`;

// ── 补丁定义 ──────────────────────────────────────────────────────────────────
// probe：探针。出现在文件里 = 这个补丁已经装过了，跳过（幂等的核心）。
// find：锚点。必须在上游文件里唯一出现，否则宁可报错也不乱插。
const BRIDGE_PATCHES = [
  {
    name: 'import 记忆模块',
    probe: `from './memory-core.js'`,
    find: `import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';`,
    patch: (f) => `${f}\n${P_IMPORTS}`
  },
  {
    name: 'MEMORY_SESSION_FILE 常量',
    probe: 'MEMORY_SESSION_FILE',
    find: `const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');`,
    patch: (f) => `${f}\n${P_SESSION_FILE}`
  },
  {
    name: 'memory 实例 + 整理会话 + memoryTick（main 内）',
    probe: 'const memory = createMemoryStore(',
    find: `  loadState();`,
    patch: (f) => `${f}\n\n${P_CORE}`
  },
  {
    name: '收消息记流水（appendSocialV2Message）',
    // 探针必须是单行且只在这里出现的特征串。上游 origin/main 里 bridge.js 完全没有 logEpisode，
    // 所以「speakerId: msg.userId」出现就等于这条已装过。
    probe: 'speakerId: msg.userId',
    find: `    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');`,
    patch: (f) => `${P_LOG_IN}${f}`
  },
  {
    name: '发消息记流水（recordSentMessagesV2）',
    probe: 'memory.logEpisode({ where: key, self: true',
    find: `      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);`,
    patch: (f) => `${f}\n${P_LOG_OUT}`
  },
  {
    name: '唤醒时检索工作记忆（buildWakePromptV2）',
    probe: 'const recallText = (() =>',
    find: `    const timeSenseLine = buildTimeSenseLine(st);`,
    patch: (f) => `${f}\n${P_RECALL}`
  },
  {
    name: '把回忆拼进基础提示词',
    probe: '+ recallText',
    find: `    const base = roleLine + identityLine + tokenLine + initialPromptLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + preSleepLine + timeSenseLine;`,
    patch: (f) =>
      f.replace(
        ' + preSleepLine + timeSenseLine;',
        ' + preSleepLine + recallText + memoryHintLine + timeSenseLine;'
      )
  },
  {
    name: '记忆 HTTP 接口（6 个端点）',
    probe: `'/api/socialV2/memory-recall'`,
    find: `        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {`,
    patch: (f) => `${P_ROUTES}${f}`
  },
  {
    name: 'socialV2.memory 默认配置',
    // 探针只能用「只出现在这段配置里」的串。用 mergeDuplicateThreshold 是错的 ——
    // 上面那段 memoryTick 代码里也读了这个键，先装 tick 再查这条就永远「已装过」。
    probe: 'mergeDuplicates: true,',
    find: `      agentPreset: 'qq-chat-v2',`,
    patch: (f) => `${f}\n${P_CONFIG}`
  }
];

const MCP_PATCHES = [
  {
    name: '工具开关映射（TOOL_FLAGS）',
    probe: `qq_memory_recall: 'memoryRecall',`,
    find: `  qq_memory_clear: 'memory',`,
    patch: (f) => `${f}\n${P_MCP_FLAGS}`
  },
  {
    name: '四个工具定义',
    probe: `'qq_memory_recall',`,
    find: `server.tool(
  'qq_slang_query',`,
    patch: (f) => `${P_MCP_TOOLS}${f}`
  }
];

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function countOccur(src, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = src.indexOf(needle, i);
    if (at < 0) return n;
    n += 1;
    i = at + needle.length;
  }
}

/** 应用一组补丁。返回 { text, applied[], skipped[], failed[] } */
function applyPatches(src, patches, label) {
  let text = src;
  const applied = [];
  const skippedAlready = [];
  const failed = [];
  for (const p of patches) {
    if (text.includes(p.probe)) {
      skippedAlready.push(p.name);
      continue;
    }
    const hits = countOccur(text, p.find);
    if (hits !== 1) {
      failed.push({ name: p.name, reason: hits === 0 ? '锚点找不到（上游可能改了这句）' : `锚点出现 ${hits} 次，不唯一` });
      continue;
    }
    // patch(锚点原文) 返回「用这段替换锚点」。插入型补丁就返回 新块+锚点；
    // 改造型补丁返回锚点改过之后的样子。两种都是纯字符串替换，不需要分支。
    text = text.replace(p.find, p.patch(p.find));
    applied.push(p.name);
  }
  log(`\n【${label}】`);
  if (applied.length) applied.forEach((n) => todo(n));
  if (skippedAlready.length) skippedAlready.forEach((n) => skip(`${n}（已装过）`));
  if (failed.length) failed.forEach((f) => bad(`${f.name}：${f.reason}`));
  return { text, applied, skippedAlready, failed };
}

function backup(file) {
  const bak = `${file}.memory-install.bak-${stamp()}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function nodeCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? error);
    return stderr.split('\n').slice(0, 6).join('\n');
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
log('══════════════════════════════════════════════════════════');
log(`  whale-memory → qq-bridge 安装器`);
log(`  源仓库：${REPO}`);
log(`  目标桥：${BRIDGE}`);
log(`  模式：${apply ? '真装（--apply）' : '干跑（只报告，加 --apply 才动手）'}`);
log('══════════════════════════════════════════════════════════');

if (!looksLikeBridge(BRIDGE)) {
  bad(`找不到 qq-bridge。我试过这些地方：`);
  for (const d of tried) log(`     · ${d}`);
  log('');
  log('  三种指定方式，任选一种：');
  log('     node scripts/install-to-bridge.mjs --bridge D:\\qq-bridge');
  log('     set QQ_BRIDGE_DIR=D:\\qq-bridge   （PowerShell：$env:QQ_BRIDGE_DIR="D:\\qq-bridge"）');
  log('     在桥目录里直接跑 node <本脚本的绝对路径>');
  process.exit(1);
}
log(`  找到桥：${BRIDGE}`);

let problems = 0;

// —— 1. 记忆层源码 ——
log('\n【1/4 记忆层源码】');
const bridgeSrc = path.join(BRIDGE, 'src');
fs.mkdirSync(bridgeSrc, { recursive: true });
for (const name of SRC_FILES) {
  const from = path.join(REPO, 'src', name);
  const to = path.join(bridgeSrc, name);
  if (!fs.existsSync(from)) { bad(`源缺失：src/${name}`); problems += 1; continue; }
  const buf = fs.readFileSync(from);
  const existed = fs.existsSync(to);
  const same = existed && sha(fs.readFileSync(to)) === sha(buf);
  if (same) { skip(`${name}（一致）`); continue; }
  if (apply) fs.writeFileSync(to, buf);
  todo(`${name} ${existed ? '更新' : '新增'}  ${sha(buf)}${apply ? '' : '（未写盘）'}`);
}

// —— 2. 词表 ——
log('\n【2/4 词表】');
const bridgeData = path.join(BRIDGE, 'data');
fs.mkdirSync(bridgeData, { recursive: true });
for (const name of DATA_FILES) {
  const from = path.join(REPO, 'data', name);
  const to = path.join(bridgeData, name);
  if (!fs.existsSync(from)) { bad(`源缺失：data/${name}`); problems += 1; continue; }
  const buf = fs.readFileSync(from);
  const existed = fs.existsSync(to);
  const same = existed && sha(fs.readFileSync(to)) === sha(buf);
  if (same) { skip(`${name}（一致）`); continue; }
  if (existed && !forceData) {
    // 词表是只读主表，理论上不该被改过；但用户可能自己补过词，所以不擅自覆盖。
    todo(`${name} 已存在且不同（本地 ${sha(fs.readFileSync(to))} vs 仓库 ${sha(buf)}）—— 保留本地，加 --force-data 才覆盖`);
    continue;
  }
  if (apply) fs.writeFileSync(to, buf);
  todo(`${name} ${existed ? '覆盖' : '新增'}  ${sha(buf)}${apply ? '' : '（未写盘）'}`);
}
const learned = path.join(bridgeData, 'jieba-learned.txt');
if (fs.existsSync(learned)) {
  const n = fs.readFileSync(learned, 'utf8').split('\n').filter(Boolean).length;
  skip(`jieba-learned.txt（本地已学出 ${n} 词，绝不覆盖）`);
} else if (fs.existsSync(path.join(REPO, 'data', 'jieba-learned.txt'))) {
  if (apply) fs.copyFileSync(path.join(REPO, 'data', 'jieba-learned.txt'), learned);
  todo('jieba-learned.txt 新增（仓库里的示例词表）');
}

// —— 3. bridge.js ——
log('\n【3/4 给 bridge.js 打补丁】');
const bridgeFile = path.join(bridgeSrc, 'bridge.js');
const bridgeRaw = fs.readFileSync(bridgeFile, 'utf8');
// 行尾统一：Windows 上的 bridge.js 是 CRLF，而这里的补丁片段写的是 LF。
// 不统一就会出现「多行锚点永远匹配不上、单行锚点却又匹配得上」这种半死不活的状态 ——
// 真实踩过：装出来九条里八条成功，唯独多行那条报「锚点找不到」，查了半天才发现是 \r。
const crlf = bridgeRaw.includes('\r\n');
let bridgeText = crlf ? bridgeRaw.replace(/\r\n/g, '\n') : bridgeRaw;
const beforeLen = bridgeText.length;
const r1 = applyPatches(bridgeText, BRIDGE_PATCHES, 'bridge.js');
bridgeText = r1.text;
problems += r1.failed.length;
if (apply && r1.applied.length) {
  const bak = backup(bridgeFile);
  ok(`已备份 → ${path.basename(bak)}`);
  // 按原文件的行尾写回，避免把整个文件的行尾改掉（那会让 git diff 变成一万多行）
  fs.writeFileSync(bridgeFile, crlf ? bridgeText.replace(/\n/g, '\r\n') : bridgeText);
  const err = nodeCheck(bridgeFile);
  if (err) { bad(`语法检查失败，已回滚：\n${err}`); fs.copyFileSync(bak, bridgeFile); problems += 1; }
  else ok(`语法检查通过（+${bridgeText.length - beforeLen} 字符）`);
} else if (r1.applied.length) {
  todo(`将写入桥文件（+${bridgeText.length - beforeLen} 字符，未写盘）`);
}

// —— 4. mcp-snowluma-safe.js ——
log('\n【4/4 注册 MCP 工具】');
const mcpFile = path.join(bridgeSrc, 'mcp-snowluma-safe.js');
if (!fs.existsSync(mcpFile)) {
  bad('找不到 src/mcp-snowluma-safe.js —— 上游结构可能变了，工具注册这步跳过');
  problems += 1;
} else {
  const mcpRaw = fs.readFileSync(mcpFile, 'utf8');
  const mcpCrlf = mcpRaw.includes('\r\n');
  const mcpText0 = mcpCrlf ? mcpRaw.replace(/\r\n/g, '\n') : mcpRaw;
  const r2 = applyPatches(mcpText0, MCP_PATCHES, 'mcp-snowluma-safe.js');
  problems += r2.failed.length;
  if (apply && r2.applied.length) {
    const bak = backup(mcpFile);
    ok(`已备份 → ${path.basename(bak)}`);
    fs.writeFileSync(mcpFile, mcpCrlf ? r2.text.replace(/\n/g, '\r\n') : r2.text);
    const err = nodeCheck(mcpFile);
    if (err) { bad(`语法检查失败，已回滚：\n${err}`); fs.copyFileSync(bak, mcpFile); problems += 1; }
    else ok('语法检查通过');
  }
}

// —— 收尾 ——
log('\n══════════════════════════════════════════════════════════');
if (problems) {
  bad(`有 ${problems} 处没落下去。上游可能改过对应那句 —— 按上面报的名字去 bridge.js 里搜相近代码，改锚点后重跑。`);
} else if (apply) {
  ok('装完了。下一步：');
  log('   1) 重启桥（先杀 start.bat 的守卫 cmd，再杀 node，否则会被立刻重拉）；');
  log('   2) 浏览器打开控制台的记忆面板，或 curl 一下 /api/socialV2/memory-stats；');
  log('   3) 聊几句再看 stats —— 条数应该开始涨（流水先记，30 分钟内由 memoryTick 巩固成事实）。');
} else {
  ok('干跑结束，没有写任何文件。确认无误后加 --apply。');
}
log('══════════════════════════════════════════════════════════');
process.exit(problems ? 2 : 0);
