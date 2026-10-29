#!/usr/bin/env node
// 最小可运行机器人 —— 不接任何聊天平台，只有一个 HTTP 接口。
//
// 目的：让人在 60 秒内看到「记忆真的在起作用」，而不是读 800 行部署文档脑补。
//
// 跑法：
//   node examples/minimal-bot.mjs
//
// 然后另开一个终端：
//   curl -s localhost:8787/chat -H 'content-type: application/json' \
//        -d '{"user":"他","text":"今天又熬夜到三点"}' | jq -r .reply
//   curl -s localhost:8787/chat -H 'content-type: application/json' \
//        -d '{"user":"他","text":"你还记得我熬夜的事吗"}' | jq -r .context
//
// 你会看到第二问的 context 里带着第一句 —— 这就是记忆。
//
// 三个接入点就是全部机密（对应 DEPLOYMENT.md 路线 B）：
//   ① 收到消息 → logEpisode      （记流水）
//   ② 要回复   → gatherWorkingMemory → renderWorking（捡相关记忆塞进 prompt）
//   ③ 定时     → memoryTick      （巩固/衰减/合并，这里只起个简易定时器）
//
// 唯一没做的是调用真正的模型。看 applyReply() 那个函数，把你的 LLM 调用填进去就行。

import http from 'node:http';
import { createMemoryStore } from '../src/memory-core.js';

const PORT = Number(process.env.PORT || 8787);
const DIR = process.env.MEMORY_DIR || './data/memory';

const mem = createMemoryStore({ dir: DIR, log: (...a) => console.log('[memory]', ...a) });

// ── ③ 定时整理 ───────────────────────────────────────────────
// 真实项目里用 scripts/memory-tick.mjs 挂 cron，这里为了自包含用进程内定时器。
// 两个细节是必须的，少一个就会踩坑：
//   1. 防重入 —— 上一趟没跑完就跑下一趟，两个写同一份文件会互相覆盖
//   2. try/catch —— 异常没接住的话 Node 会干掉定时器，然后你以为「跑着跑着自己停了」
let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  try {
    mem.decay({ coldThreshold: 0.06 });
    mem.mergeDuplicates({ threshold: 0.95 });
  } catch (error) {
    console.error('[tick] 失败（不影响主业务，下一轮再试）:', error?.message ?? error);
  } finally {
    ticking = false;
  }
}, 30 * 60 * 1000);

// ── ② 回复：这里换掉就是你的机器人 ────────────────────────────
// 判断「这一轮到底有没有想起东西」。
//
// 为什么不能写成 `!context.trim()`：renderWorking 即使在空库里也会渲染出
// 标题和结尾那句「不记得就说不记得」，所以 context 永远不会是空字符串 ——
// 这么写的话「还没记住任何事」那个分支永远进不去，新手第一跑就会以为坏了。
// 正确的判据是八个槽里到底有没有条目（槽名见 DEPLOYMENT.md 3.2 节的表）。
const SLOT_KEYS = ['core', 'recent', 'relevant', 'cold', 'procedural', 'milestone', 'insight', 'faint'];
function hasAnything(wm) {
  return SLOT_KEYS.some((k) => Array.isArray(wm?.[k]) && wm[k].length > 0);
}

async function applyReply(user, text, context, wm) {
  // 真实项目里，把 context 拼在 system prompt 后面，然后调模型：
  //
  //   const messages = [
  //     { role: 'system', content: PERSONA + '\n\n' + context },
  //     { role: 'user', content: text },
  //   ];
  //   return await callYourLLM(messages);
  //
  // 这里为了让你不配 key 也能看到效果，直接把它"看见了什么"说出来。
  if (!hasAnything(wm)) {
    return `（还没记住关于${user}的任何事。先说点什么。）`;
  }
  return `（我会带着下面这些记忆回复${user}。接上你的模型就是真回复了。）\n\n${context}`;
}

// ── HTTP 层 ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  if (req.method === 'GET' && req.url === '/stats') {
    return send(200, mem.stats());
  }

  if (req.method !== 'POST' || req.url !== '/chat') {
    return send(404, { error: '用 POST /chat，或 GET /stats' });
  }

  let raw = '';
  // 必须 setEncoding('utf8')。
  // 不设的话 `raw += chunk` 会对每个 Buffer 单独 toString()，而一个中文字符
  // 占 3 字节，跨 chunk 边界时会被劈成两半 —— 于是「说」变成 `\udcaf`，
  // 存进记忆库就是永久的乱码。这个 bug 在本地测不出来，因为
  // localhost 上一个请求通常一次就传完了；上线后大一点的消息必踩。
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return send(400, { error: 'body 不是合法 JSON' });
  }

  const user = String(payload.user || '他');
  const text = String(payload.text || '').trim();
  if (!text) return send(400, { error: '缺少 text' });

  // ② 捡记忆 —— 必须在 ① 之前想清楚一件事：**要不要把当前这句也记进去**。
  //
  //   这里刻意先捡后记。反过来（先记再捡）会让查询命中自己：
  //   刚存进去的这句话是最新鲜的记忆，字面跟查询完全一致，一定排第一 ——
  //   于是每轮都会「想起」对方刚刚才说的那句话，工作记忆被自己污染。
  //   qq-bridge 的做法是先记流水、但在检索时把本轮的 key 排掉（见 DEPLOYMENT.md
  //   3.1 节）；这个极简示例选了更简单的做法：先捡后记。
  //
  //   gatherWorkingMemory 返回八个槽（core/recent/relevant/cold/procedural/
  //   milestone/faint/insight），renderWorking 把它渲染成给模型看的提示词。
  const wm = mem.gatherWorkingMemory(text, { who: user });
  const context = mem.renderWorking(wm);

  // 顺带把"为什么想起这些"也留着 —— 这是这套系统跟向量库最大的区别：
  // 每条都带 evidence（有没有真关系）和 score（排第几），能查、能调。
  //
  // ⚠️ 这个 recalled 会**比 context 少**，不是 bug，是两件事：
  //   这里走 recall 的默认证据门槛（evidenceGate 0.15）—— 「这条跟这句话有没有
  //   字面关系」，宁可少给也不乱提旧事，是给「注入 k 条」省 token 用的。
  //   上面 gatherWorkingMemory 内部把门槛关掉了（evidenceGate: 0）—— 它要装的
  //   恰恰是「字面对不上但该想起来」的东西：跨天联想、舌尖、模糊影子。
  //   所以「命中 [] 但 context 里有东西」是正确状态，别以为坏了。
  //   （反过来把这里也设成 0 会更乱：门槛一关，纯提问句「外面天气怎么样」
  //    会因为里面几个字跟别的记忆重上而挤进来，正是门槛要挡的东西。）
  const recalled = mem.recall(text, { who: user, limit: 3 }).map((m) => ({
    text: m.text,
    evidence: Number(m.evidence?.toFixed?.(3) ?? m.evidence),
    score: Number(m.score?.toFixed?.(3) ?? m.score),
    confidence: m.confidenceLabel,
  }));

  // ① 记流水（捡完再记）
  //   who 是这套系统的骨架 —— 它决定「关于他的」和「关于我的」分不分得开。
  //   真实项目里别用昵称，用稳定 ID（昵称会改，改了就永久失联）。
  mem.logEpisode({ who: user, where: 'http', text, at: Date.now() });

  const reply = await applyReply(user, text, context, wm);

  send(200, { reply, context, recalled });
});

server.listen(PORT, () => {
  console.log(`记忆库: ${DIR}`);
  console.log(`试试:`);
  console.log(`  curl -s localhost:${PORT}/chat -H 'content-type: application/json' \\`);
  console.log(`       -d '{"user":"他","text":"今天又熬夜到三点"}'`);
  console.log(`  curl -s localhost:${PORT}/chat -H 'content-type: application/json' \\`);
  console.log(`       -d '{"user":"他","text":"你还记得我熬夜的事吗"}'`);
  console.log(`  curl -s localhost:${PORT}/stats`);
});
