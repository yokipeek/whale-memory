// 程序记忆（procedural memory）+ 多模态引用（sensory refs）
//
// ── 为什么需要 ──────────────────────────────────────────────────────
//   评分卡里「存储」这一项原来 80%，缺口写得很清楚：缺程序记忆、缺视觉/听觉记忆。
//
//   程序记忆是人脑里和「情景/语义」并列的一类：会骑车、会用某个软件、
//   知道喊两声「喵」对方就会回。它有三个特点，和事实记忆完全不同：
//     ① 不靠「想起来」，靠「做出来」—— 检索方式是「现在要做 X，我该怎么做」
//     ② 忘得极慢（骑自行车几十年不忘），而且几乎不受情绪影响
//     ③ 一条程序由很多步组成，中途改一步就整条失效（要版本化）
//
//   多模态引用不是「存图片」—— 图片在 QQ 那边本来就是独立资源。
//   这里存的是「这件事跟一段声音/一张图有关」的指针 + 一句它能被读懂的摘要。
//   人的视觉记忆也不是像素，是「我记得那天窗外在放烟花」这种可检索的描述。
//
// ── 边界 ─────────────────────────────────────────────────────────────
//   · 不存二进制：只存 URI + 摘要 + 感知通道（vision/audio/file）。
//   · 程序记忆不自动执行：它是提示词里的「我知道该怎么做」，不是自动化脚本。
//     真要跑命令必须由 agent 自己决定 —— 记忆层永远不直接调用工具。

/** 感知通道：决定渲染时怎么描述它。 */
export const SENSORY_CHANNELS = ['vision', 'audio', 'file', 'link'];

/**
 * 从对话里抽「这件事跟某段声音/某张图有关」。
 *
 * 只认两类信号：
 *   ① 有附件 URI（QQ 语音/图片/文件在消息里带 url 或 file）
 *   ② 文字里明确提到「刚才那条语音」「那张图」这种回指
 *
 * 为什么不用模型判断：这一步每轮都要跑，走模型太慢也太贵。
 * 规则够了 —— 真正的描述由模型在巩固时补（见 memory-consolidate）。
 */
const DEICTIC_SENSORY = [
  { re: /(?:刚才|刚刚|上面|那条|这条|这个)?\s*(语音|声音|录音)/u, channel: 'audio' },
  { re: /(?:刚才|刚刚|上面|那张|这张|这个)?\s*(图片|照片|截图|表情)/u, channel: 'vision' },
  { re: /(?:刚才|刚刚|上面|那个|这个)?\s*(文件|文档|压缩包|附件)/u, channel: 'file' },
];

export function detectSensory(text, { attachments = [] } = {}) {
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(attachments) ? attachments : []) {
    const uri = String(a?.url || a?.file || a?.uri || '').trim();
    // 有 summary 没 uri 也要收：QQ 语音段有时只剩一个 SILK 文件名（甚至被上游滤掉），
    // 但 asr 已经把「它说了什么」填进 summary —— 那才是最该记住的部分。
    // uri 只证明「有过这段音频」，summary 才证明「她听懂了」。
    const summary = String(a?.summary || a?.alt || a?.name || '').slice(0, 120);
    if (!uri && !summary) continue;
    const kind = String(a?.kind || a?.type || '').toLowerCase();
    let channel = 'file';
    // 视频归 vision：它和图片一样是「看见」。归 file 会让「他发过一段视频」
    // 从视觉通道消失（画像统计与渲染文案都按 channel 分）。
    if (kind.includes('image') || kind.includes('photo') || kind.includes('sticker') || kind.includes('video')) channel = 'vision';
    else if (kind.includes('audio') || kind.includes('voice') || kind.includes('record')) channel = 'audio';
    else if (/\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(uri)) channel = 'vision';
    else if (/\.(silk|amr|mp3|wav|ogg|m4a|flac)$/i.test(uri)) channel = 'audio';
    // 没 summary 时按 kind 补一个人话标签。不补的话渲染出来是「（那段：图、图）」——
    // 两条并列的「图」既分不出是表情还是照片，也读不出是什么，等于白记一条。
    const label = summary || (kind.includes('sticker') ? '表情' : kind.includes('face') ? '表情'
      : kind.includes('video') ? '视频' : kind.includes('image') || kind.includes('photo') ? '图片'
        : kind.includes('audio') || kind.includes('voice') || kind.includes('record') ? '语音' : '');
    // 去重键带 summary：同一条语音重发两次（同 file 名、不同内容）不该被合并成一条。
    const key = `${channel}|${uri}|${summary.slice(0, 24)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ channel, uri, summary: label });
  }
  const s = String(text || '');
  for (const d of DEICTIC_SENSORY) {
    const m = s.match(d.re);
    if (!m) continue;
    // 已经拿到同通道的真实附件时不再加回指：原文会渲染成
    // 「（那会儿还有一段语音：宝贝我想你了、语音（他只是提了一句）」这种废话。
    if (out.some((r) => r.channel === d.channel && r.uri)) continue;
    const key = `${d.channel}|text`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ channel: d.channel, uri: '', summary: String(m[0]).slice(0, 60), deictic: true });
  }
  return out.slice(0, 4);
}

/** 感知摘要渲染：「（附一张图：你说的那张猫）」 */
export function renderSensory(refs) {
  const list = Array.isArray(refs) ? refs.filter(Boolean) : [];
  if (!list.length) return '';
  const label = { vision: '图', audio: '语音', file: '文件', link: '链接' };
  // summary 是「图片/视频/表情/语音」这类泛称时，直接用它当主语，别再套一层通道名 ——
  // 否则渲染成「图：图片」「语音：语音」，读起来像口吃，也丢了「视频」比「图」更准的信息。
  const GENERIC = new Set(['图片', '照片', '视频', '表情', '语音', '文件', '附件', '压缩包', '文档', '链接']);
  const bits = list.map((r) => {
    const l = label[r.channel] || '附件';
    const head = r.summary ? (GENERIC.has(r.summary) ? r.summary : `${l}：${r.summary}`) : l;
    return `${head}${r.deictic ? '（他只是提了一句）' : ''}`;
  });
  return `（那会儿还有一段${bits.join('、')}）`;
}

// ── 程序记忆 ──────────────────────────────────────────────────────────

/**
 * 程序记忆的抽取规则。
 *
 * 只认「教过 / 学会了 / 下次这样」这三种语境。原因是这一层最怕噪声 ——
 * 程序记忆一旦写错，之后每次都会照着错的做法执行，比忘掉更糟。
 * 所以门槛刻意高：必须是明确的动作序列或明确的「以后就这么办」。
 */
const PROC_PATTERNS = [
  {
    // 「你以后就……」「下次这样……」= 他教我的流程。
    //
    // ⚠️ 这里原来写的是 `(?:以后|下次|记得|要先?)` —— `要先?` 里的 `?` 让「先」可选，
    // 于是等于「只要句子里出现一个『要』字就算教学」。实测「需要你的表情图，
    // 这样你想表达……」直接被抽成程序记忆「你的表情图」，提示词里就多了一条
    // 毫无意义的「技能」。现在每个锚点都必须完整出现。
    re: /(?:以后|从今以后|往后|下次)\s*(?:你)?\s*(?:就|要|得)?\s*([^。！!？?\n]{4,80})/u,
    kind: 'taught',
  },
  {
    // 「记得先……再……」
    re: /记得\s*(?:先|要)?\s*([^。！!？?\n]{4,80})/u,
    kind: 'taught',
  },
  {
    // 「先 X 再 Y」—— 必须是完整的「先…再…」两步，缺一不算流程
    re: /先\s*([^。！!？?\n，,]{2,14})[，,]\s*再\s*([^。！!？?\n]{2,60})/u,
    kind: 'taught',
    twoStep: true,
  },
  {
    // 「我学会了 X」「我会 X 了」= 我习得的技能
    // `学会` 后面必须吃掉可选的「了」，否则「我学会了边撒娇边发语音」会把
    // 「了边撒娇边发语音」当成技能名（多了个孤零零的「了」）。
    re: /我(?:已经)?(?:学会|会了|掌握了|摸清了)了?\s*([^。！!？?\n]{2,40})/u,
    kind: 'learned',
  },
  {
    // 「X 要这样做」「X 的正确做法是」= 客观步骤。放在「先…再…」前面，
    // 因为「发语音要这样做：先合成再发」里那个「先…再…」是解释，不是流程本身。
    re: /([^。！!？?\n]{2,20}?)(?:要这样|这样做|的正确(?:做法|步骤|方式是)|的流程是)\s*(?:做\s*[:：]\s*)?(?:是|为)?\s*([^。！!？?\n]{2,60})/u,
    kind: 'howto',
  },
];

// 程序记忆的噪声过滤：QQ 占位符和口语反问进了程序记忆，提示词里就只剩一堆断句。
const PROC_NOISE = /\[(?:表情|图片|语音|文件|转发)[^\]]*\]|问号脸|啥啊|怎么了|为什么|是不是/u;

/**
 * 抽程序记忆。
 *
 * 返回 [{ skill, kind, steps, confidence }]
 *   skill   —— 归一化的技能名（用来去重：「发语音」只该有一条最新做法）
 *   steps   —— 原文片段（不强行切成数组，中文的「先…再…」切坏了反而更难读）
 */
export function extractProcedures(text) {
  const s = String(text || '');
  if (!s || s.length < 6) return [];
  const out = [];
  for (const p of PROC_PATTERNS) {
    const m = s.match(p.re);
    if (!m) continue;
    // 「先 X 再 Y」有两个捕获组，拼回「X，再 Y」才是完整流程。
    // 只取最后一组会丢掉 X（「先确认他没在开会，再发语音」只剩「发语音」）。
    const groups = m.slice(1).filter((g) => typeof g === 'string' && g.trim());
    // 只有「先 X 再 Y」那条有两个捕获组需要拼回去（一个是 X、一个是 Y）。
    // 其它模式也可能有两个组（howto 的「主语 + 步骤」），但主语本身就是技能名，
    // 拼进去会读成「发语音，再 做：先合成再发」。所以由模式自己声明 twoStep。
    const body = p.twoStep && groups.length >= 2
      ? `${groups[0].trim()}，再 ${groups[groups.length - 1].trim()}`
      : String(m[m.length - 1] || '').trim();
    if (body.length < 4) continue;
    if (PROC_NOISE.test(body)) continue;
    // 技能名：从片段里取第一个动词短语（最多 12 字），或者取前 8 字
    const skill = (body.match(/^[\u4e00-\u9fa5a-zA-Z0-9]{2,12}/u)?.[0] || body.slice(0, 8)).trim();
    out.push({
      skill,
      kind: p.kind,
      steps: body.slice(0, 200),
      confidence: p.kind === 'learned' ? 0.8 : 0.65,
    });
  }
  // 同一句里抽出多条时，只留最具体的一条（步骤最长的）
  if (out.length > 1) out.sort((a, b) => b.steps.length - a.steps.length);
  return out.slice(0, 1);
}

/**
 * 程序记忆的「版本化」判定：同 skill 的新步骤要不要覆盖旧的。
 *
 * 为什么不能简单覆盖：他可能只是补充一句细节，不是改流程。
 * 规则：
 *   · 新步骤包含旧步骤的关键动词，且更长 → 补充（合并成新的，保留旧的作历史）
 *   · 完全不重合 → 是另一套做法，也覆盖（旧的作废，但留 revisions）
 *   · 更短且被旧步骤包含 → 忽略（人家只是简说了一遍）
 */
export function shouldReviseProcedure(existing, incoming) {
  const o = String(existing?.steps || '');
  const n = String(incoming?.steps || '');
  if (!o) return { revise: true, reason: 'new' };
  if (!n) return { revise: false, reason: 'empty' };
  if (o.includes(n) && n.length < o.length * 0.8) return { revise: false, reason: 'shorter-contained' };
  if (n === o) return { revise: false, reason: 'same' };
  return { revise: true, reason: n.length > o.length ? 'richer' : 'different' };
}

/** 程序记忆渲染：给提示词用，一条一行，明确标「这是做法不是事实」。 */
export function renderProcedures(list, { max = 3 } = {}) {
  const rows = (Array.isArray(list) ? list : []).filter((p) => p && p.steps).slice(0, max);
  if (!rows.length) return '';
  const lines = ['【我会的做法】（这些是「怎么做」，不是「发生过什么」）'];
  for (const p of rows) {
    lines.push(`- ${p.skill || '（没命名）'}：${String(p.steps).slice(0, 120)}`);
  }
  return lines.join('\n');
}

/**
 * 把一次「教了但没学会」记下来 —— 反面经验也算程序记忆。
 *
 * 人记「这样做会失败」比记「这样做能成功」更牢（一次被烫就记住火）。
 * 这条在提示词里的价值是：不要重复踩同一个坑。
 *
 * ⚠️ 上一版是 `(?:别|不要|不能)…\s*([^。！?]{3,40})` 直接取捕获组，这是**语义反转**：
 *    「不能叫我老婆大人」→ rule「叫我老婆大人」，
 *    结果提示词里多了一条「别这样做：叫我老婆大人」的反向指令 —— 恰好教错。
 * 现在必须把否定前缀一起带上，并且倒过来归一成「别 X」的读法。
 *
 * 另一类噪声：QQ 表情占位符 `[表情:尴尬]`、纯口语反问「你问号脸干啥」。
 * 这些进了程序记忆会让提示词变成一堆无意义短句，宁可漏也不收。
 */
const PITFALL_NOISE = /\[(?:表情|图片|语音|文件)[^\]]*\]|问号脸|啥啊|怎么了|是什么|为什么/u;

export function extractPitfalls(text) {
  const s = String(text || '');
  // 捕获组 1 = 否定词，捕获组 2 = 被否定的动作。两者都要，缺一就反转。
  const m = s.match(/(千万别|记住别|不要|不能|不准|不许|别)\s*([^。！!？?\n]{2,40})/u);
  if (!m) return null;
  const neg = m[1];
  const body = String(m[2] || '').trim();
  if (body.length < 2) return null;
  if (PITFALL_NOISE.test(body)) return null;
  // 「不要变风格」→「别变风格」；「不能叫我老婆大人」→「别叫我老婆大人」
  const rule = `别${body}`.slice(0, 80);
  return { rule, confidence: 0.6, negatedBy: neg };
}
