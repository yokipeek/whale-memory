# 部署指南

> 这份文档回答一个问题：**我拿到了这个库，然后呢？**

README 教你「它怎么工作」，这份教你「它怎么跑起来」。

---

## 目录

1. [先选一条路](#1-先选一条路)
2. [路线 A：当纯库用（5 分钟）](#2-路线-a当纯库用5-分钟)
3. [路线 B：接你自己的聊天机器人（30 分钟）](#3-路线-b接你自己的聊天机器人30-分钟)
4. [路线 C：完整复刻小鲸鱼（接 qq-bridge）](#4-路线-c完整复刻小鲸鱼接-qq-bridge)
   - [一条命令装完（懒人路线）](#一条命令装完懒人路线)
5. [定时任务：让它自己整理记忆](#5-定时任务让它自己整理记忆)
6. [数据在哪、怎么备份、怎么搬家](#6-数据在哪怎么备份怎么搬家)
7. [词表：认识你自己的私房词](#7-词表认识你自己的私房词)
8. [排错手册](#8-排错手册)

---

## 1. 先选一条路

这个库有三层用法，按你想要的深度选：

```
┌────────────────────────────────────────────────────────────┐
│  路线 A：纯库                                                │
│  你的脚本 → createMemoryStore() → 记 / 查 / 忘               │
│  适合：想给自己的 AI 加记忆，不接 QQ/微信/Telegram            │
├────────────────────────────────────────────────────────────┤
│  路线 B：接自己的机器人                                       │
│  机器人收到消息 → logEpisode() → 组 prompt 时 gatherWorkingMemory() │
│  适合：你已经有机器人（任何平台），只缺记忆                    │
├────────────────────────────────────────────────────────────┤
│  路线 C：完整复刻                                              │
│  上面两种 + 定时巩固 + 睡眠重放 + 本地规则抽取 + 模型巩固       │
│  适合：想要「会自己长」的记忆，愿意配一个模型                 │
└────────────────────────────────────────────────────────────┘
```

**三层是叠加的，不是三选一。** 先跑通 A，再加 B，最后加 C。

---

## 2. 路线 A：当纯库用（5 分钟）

### 2.1 装

三种方式，任选：

**方式一：npm（推荐）**

```bash
npm install whale-memory
```

**方式二：直接复制目录（零依赖，最省事）**

```bash
# clone 下来，把 src/ 和 data/ 两个目录整个拷进你的项目
git clone https://github.com/yokipeek/whale-memory.git
cp -r whale-memory/src whale-memory/data 你的项目/
```

> ⚠️ **`data/` 必须一起拷**。里面是中文分词词表（920 KB），少了它分词会退化，
> 检索质量明显下降。这是最容易漏的一步。

**方式三：git submodule**

```bash
git submodule add https://github.com/yokipeek/whale-memory.git vendor/whale-memory
```

### 2.2 跑起来

```js
// demo.mjs
import { createMemoryStore } from 'whale-memory';
// 复制目录的用相对路径：
// import { createMemoryStore } from './src/memory-core.js';

const mem = createMemoryStore({ dir: './my-memory' });

// ① 记流水（当天发生的对话，会按天分文件）
mem.logEpisode({ who: '他', text: '今天又熬夜到三点，说做完就睡' });
mem.logEpisode({ who: '他', text: '我不抽烟，别老给我递' });

// ② 记事实（要记很久的，直接写进语义层）
mem.remember('他不抽烟', {
  kind: 'semantic',
  layer: 'long',
  who: '他',
  importance: 4,
  attr: 'habit.smoke',   // 见下面 2.4，这个字段很重要
});

// ③ 查
const hits = mem.recall('他抽烟吗', { limit: 3 });
console.log(hits);
// → [{ text: '他不抽烟', evidence: 0.37, score: 0.70, ... }]
```

```bash
node demo.mjs
```

**第一次跑会发生什么**：`dir` 指定的目录不存在时自动创建，写入四个文件：

```
my-memory/
├── index.json          ← 计数器、水位、统计（别手改）
├── semantic.jsonl      ← 语义记忆，一行一条
├── procedural.json     ← 程序记忆（「怎么做」）
└── episodic/
    └── 2026-10-29.jsonl   ← 当天的流水，按天一个文件
```

### 2.3 三个必会的坑

**坑 1：`recall` 可能返回空数组，这是对的**

```js
mem.recall('外面天气怎么样', { limit: 3 });  // → []
```

这是设计意图，不是 bug。库里没有跟「天气」有关的事实，它不会硬塞一条不相关的进来。
**你的代码必须处理空数组** —— 空的时候就是「这次没想起什么」，别当成错误。

```js
const hits = mem.recall(q, { limit: 3 });
if (!hits.length) {
  // 正常情况：这次真没想起来
  return;
}
```

**坑 2：`who` 字段必须一致**

`recall` 里如果传 `who`，它做的是**严格字符串相等**过滤。

```js
mem.remember('他喜欢蓝色', { who: '他' });
mem.recall('喜欢什么颜色', { who: '他' });   // ✅ 能查到
mem.recall('喜欢什么颜色', { who: '他 ' });  // ❌ 差一个空格就查不到
```

历史上踩过最惨的坑：26 条记忆的 `who` 里混进了**零宽空格**（U+200B，复制粘贴带进来的，
肉眼完全看不见），导致这 26 条永远查不出来，占全部记忆的 11%，静默失联好几天才发现。

当前版本已在 `remember()` 写入侧自动清洗零宽字符，但**如果你自己往 `semantic.jsonl`
里批量导入数据，务必自己清一遍**：

```js
const clean = (s) => String(s).replace(/[\u200B-\u200F\u2060\uFEFF]/g, '');
```

**坑 3：`importance` 决定它活多久**

不传 `importance` 时是默认值，衰减会按它算。想让某条记忆几乎不消失，给 `5`。

### 2.4 `attr`：让「他改口了」能被发现

`attr` 是「这条事实描述的是哪个属性」，比如 `profile.city`、`pref.color`、`habit.加班`。

它的用处：**同 attr 不同值 = 他改口了**。

```js
mem.remember('他住在杭州', { attr: 'profile.city', importance: 4 });
// 三个月后
mem.remember('他搬到成都了', { attr: 'profile.city', importance: 4 });
```

本地巩固时看到同一个 `attr` 有两个值，会判成「改口」，走改写而不是并存。
**不填 `attr` 就不会有这个能力** —— 两条会同时存在，之后每次检索都在打架。

建议：凡是「一个人只有一个当前值」的属性都填（城市、职业、称呼、偏好），
凡是「可以有很多个」的（今天发生了什么、说过的话）不用填。

### 2.5 完整 API 速查

`createMemoryStore()` 返回 43 个成员，分五类。常用的这些：

| 类别 | 方法 | 说明 |
|---|---|---|
| **写** | `remember(text, opts)` | 记事实 |
| | `logEpisode(opts)` | 记流水（自动判断值不值得记） |
| | `addPending(opts)` | 记「待巩固」的原始材料 |
| **读** | `recall(query, opts)` | 按问题检索，返回带证据分的列表 |
| | `gatherWorkingMemory(query, opts)` | 取「此刻该记得的」多槽结果（注入 prompt 用） |
| | `renderWorking(wm)` | 把上一步的结果渲染成给模型看的文本 |
| | `renderRecalled(hits)` | 把 recall 结果渲染成文本 |
| | `tipOfTongue(query)` | 「话到嘴边」——有痕迹但提不出 |
| | `searchCold(query)` | 搜地下室（已归档的旧记忆） |
| **维护** | `decay(opts)` | 算旧账：降权、搬进冷库 |
| | `mergeDuplicates(opts)` | 合并重复 |
| | `markConsolidated(day)` | 标记某天已巩固 |
| **画像** | `setProfile(k, v)` / `getProfile()` | 稳定画像 |
| | `milestones()` / `timeline()` / `autobio()` | 里程碑 / 时间线 / 自传摘要 |
| **数据** | `stats()` | 统计 |
| | `exportAll()` / `importAll(data)` | 整库导出导入 |
| | `forget(id)` / `patchItem(id, patch)` | 删 / 改单条 |

完整 43 个成员见 `src/memory-core.js` 的 `return {` 段（约 386 行处）。

---

## 3. 路线 B：接你自己的聊天机器人（30 分钟）

### 3.1 三个接入点

接任何机器人只需要三个钩子：

```
收到消息  →  ① 记流水        mem.logEpisode()
要回复了  →  ② 取记忆        mem.gatherWorkingMemory() → mem.renderWorking()
定时/空闲 →  ③ 整理记忆      digest + decay + mergeDuplicates
```

**最关键的是 ②**：不是「把最近 N 条消息塞进去」，而是「按这条消息去检索相关记忆」。

### 3.2 完整示例

```js
import { createMemoryStore } from 'whale-memory';

const mem = createMemoryStore({ dir: './data/memory' });

// ① 每收到一条用户消息，记流水
function onUserMessage(userId, userName, text) {
  mem.logEpisode({
    who: userName,       // 保持一致！
    where: `private:${userId}`,
    text,
    at: Date.now(),
    // self=false 表示「别人说的」。机器人自己说的话传 self=true。
  });
}

// ② 要生成回复了，取该记得的
async function buildPrompt(userId, userName, userText, systemPrompt) {
  const wm = mem.gatherWorkingMemory(userText, {
    who: userName,
    episodicHours: 24,     // 「最近」算多少小时以内
    relevantSlots: 2,      // 相关记忆给几个位置
    withProcedural: true,  // 要不要带上「怎么做」的经验
    withMilestone: true,   // 要不要带上「我是谁」的里程碑
  });

  const memoryText = mem.renderWorking(wm);   // 已经是排好版的中文文本

  return [
    systemPrompt,
    memoryText,                                // ← 记忆就在这里
    `用户说：${userText}`,
  ].filter(Boolean).join('\n\n');
}

// ③ 定时整理（见第 5 节）
```

### 3.3 `renderWorking` 输出长什么样

它不是一堆 JSON，是**给模型看的中文**，自带「这段话是什么意思」的提示：

```
【你此刻心里记着的】
（这些是你自己记着的，不是对方刚说的。挑真的相关的提一句就好，别整段复述、别硬塞）
- 2026-10-29 06:22 他：喜欢蓝色的小鲸鱼

【最近发生的事】
- 2026-10-29 06:22 他：我不抽烟，别老给我递

【和这话相关的】
- 他不抽烟

【我自己琢磨的】
（这是你自己后来琢磨出来的，不是他说的）
- 他能叫你老婆大人，却翻脸不让你这么叫他
```

为什么这样设计：`【我自己琢磨的】` 必须和 `【他说的】` 分开摆。
不分开的后果是模型把自己的推测当成用户的原话复述出来 —— 这比想不起来更糟。

### 3.4 槽位说明

`gatherWorkingMemory` 返回的对象里每个数组就是一个槽：

| 槽 | 装什么 | 什么时候用 |
|---|---|---|
| `core` | 最重要的事实（importance 高的） | 永远带 |
| `recent` | 最近 N 小时里权重最高的一条流水 | 永远带 |
| `relevant` | 跟当前这句话相关的记忆 | 永远带 |
| `insight` | 重放产出的跨天联想 | 有就带 |
| `procedural` | 「怎么做」的经验 | 需要技能时带 |
| `milestone` | 「我是谁」的里程碑 | 需要人设时带 |
| `faint` | 话到嘴边（有痕迹提不出） | 可选 |
| `cold` | 冷库里的旧记忆 | 上面都空时兜底 |

可以关掉不想用的槽（`withProcedural: false` / `withMilestone: false`），
槽越少 prompt 越短，但记忆的「厚度」也越薄。

---

## 4. 路线 C：完整复刻小鲸鱼（接 qq-bridge）

> 小鲸鱼是一个跑在 QQ 上的机器人。它的记忆系统就是这个库，
> 接法在 `qq-bridge` 项目里。这里写清楚完整链路，方便你复刻到别的平台。

### 一条命令装完（懒人路线）

下面 4.1–4.7 讲的是**原理和手改方法**，想看懂再读。但如果你只是想让自己的
qq-bridge 也有记忆，不用手改：仓库里带了一个安装器。

```bash
node scripts/install-to-bridge.mjs                     # 先干跑，看它要改什么
node scripts/install-to-bridge.mjs --apply              # 确认无误再真装
node scripts/install-to-bridge.mjs --bridge D:\qq-bridge --apply   # 桥不在默认路径时
```

**它做四件事**：① 把 `src/memory-*.js` 十个文件拷进桥的 `src/` ② 拷词表到 `data/`
（`jieba-learned.txt` **绝不覆盖** —— 那是你已经学出来的词）③ 按语义锚点给 `bridge.js`
打九处补丁 ④ 给 `mcp-snowluma-safe.js` 注册四个工具（`qq_memory_recall` /
`remember` / `forget` / `stats`）。

**为什么用安装器而不是手改**：这套记忆层需要在桥的四个位置被调用（收消息记流水、
发消息记流水、拼唤醒提示词时检索、定时整理），这些调用点必须长在 `bridge.js` 里。
而 `bridge.js` 上游一直在动，手改一次之后再也对不上 —— 下次更新桥，你的改动全冲突。

安装器靠三个机制解决这件事：

| 机制 | 怎么做 | 你得到什么 |
|---|---|---|
| **幂等** | 每处补丁都有探针字符串，已存在就跳过 | 重跑一百次，结果一样 |
| **抗升级** | 用语义锚点（唯一的代码片段）而不是行号 | 上游改行号、挪位置都不影响 |
| **可回滚** | 改前备份 `.memory-install.bak-<时间戳>`，写完 `node --check`，语法错就自动还原 | 装坏了桥还能跑 |

锚点找不到时会明确报「哪一处没落下去」，而不是悄悄跳过 —— 因为「装了一半」比
「完全没装」更难排查。看到这种报错就去 `bridge.js` 里搜相近代码，把安装器里那条
`find` 改成新的锚点，再重跑。

**装完怎么验证**（重启桥之后）：

```bash
curl -H "x-console-token: <你的控制台令牌>" \
  "http://127.0.0.1:3100/api/socialV2/memory-stats"
```

返回 `{"ok":true,"stats":{"semantic":0,...}}` 就说明活着。然后随便聊几句，
再看一次 —— 条数应该开始涨（先记流水，30 分钟内由 `memoryTick` 巩固成事实）。

### 4.1 整体链路

```
QQ 消息
  ↓
SnowLuma (QQ 协议网关, 端口 3000/3001/5099)
  ↓
qq-bridge (Node, 端口 3100)
  ├─ 收到消息 → mem.logEpisode()                       记流水
  ├─ 要回复  → mem.gatherWorkingMemory() → renderWorking()  取记忆注入
  └─ 每 30 分钟 → memoryTick()                          整理
       ├─ ①a 本地规则抽取（零成本，先跑）
       ├─ ①b 模型巩固（补语义，后跑）
       ├─ ②  衰减 + 冷库归档
       ├─ ②b 合并重复
       └─ ③  睡眠重放（拼跨天联想）
  ↓
DeepSeek / 任何 OpenAI 兼容 API
```

### 4.2 第一步：建库

```js
// qq-bridge/src/bridge.js 里的真实写法（约 10227 行）
import { createMemoryStore } from './memory-core.js';

const memory = createMemoryStore({
  dir: path.join(STATE_DIR, 'memory'),   // state/memory/
  log,                                    // 可选，传你的日志函数
});
```

**只要这一行**。目录会自动建，词表会自动读 `data/`。

### 4.3 第二步：记流水

```js
// 收到别人的消息（约 13862 行）
memory.logEpisode({
  where: key,            // 'private:1154735658' 或 'group:233892709'
  who: 发言人名字,
  text: 消息内容,
  at: now,
  speakerId: QQ号,
});

// 自己说的话（约 13939 行）
memory.logEpisode({
  where: key,
  self: true,            // ← 关键：self=true 的流水不会被当成「别人说的」
  who: '我',
  text: 自己说的内容,
  at: now,
});
```

**`self: true` 很重要**。不区分的话，机器人说过的废话会被当成「用户说过的话」，
下次检索出来当作事实复述，越滚越离谱。

### 4.4 第三步：注入 prompt

```js
// 约 14245 行
const query = `${最近3条用户消息} ${这次唤醒原因}`.trim();
const wm = memory.gatherWorkingMemory(query, {
  who: 私聊对象名字,
  episodicHours: cfg.socialV2.memory.recentHours ?? 24,
  relevantSlots: cfg.socialV2.memory.relevantSlots ?? 2,
  withProcedural: cfg.socialV2.memory.proceduralInPrompt !== false,
  withMilestone: cfg.socialV2.memory.autobioInPrompt !== false,
});
const memoryText = memory.renderWorking(wm);   // 拼进 system prompt
```

### 4.5 第四步：定时整理（`memoryTick`）

这是「记忆会自己长」的核心。小鲸鱼的实现顺序（**顺序有意义，别调换**）：

```js
async function memoryTick() {
  // ①a 本地规则抽取 —— 先跑
  //    为什么先跑：零成本、毫秒级、确定性，模型挂了它也照样出活。
  //    而且它先跑，模型那段拿到的 existing 里已经带了 attr，冲突检测才对得上号。
  if (cfg.memory.localDigest !== false) {
    digestPending(memory, {
      maxDays: 3,
      markProgress: false,   // ⚠ 水位交给模型段推进，它才是终点
    });
  }

  // ①b 模型巩固 —— 后跑
  //    补本地抽不出的：情绪、关系张力、隐含偏好。
  //    它读的是同一天的流水，不会跟 ①a 抢；①a 写过的事实它判成「已有 → 强化」。
  await consolidatePendingWithModel(memory, {
    maxDays: 3,
    ask: 你的模型调用函数,
  });

  // ② 衰减 + 冷库归档
  memory.decay({ coldThreshold: 0.06 });

  // ②b 合并重复
  //    阈值 0.95 刻意保守：0.92 会开始把「同一天的两件不同的事」并成一条。
  memory.mergeDuplicates({ threshold: 0.95 });

  // ③ 睡眠重放（把散在好几天里的碎片拼成新认识）
  //    每小时最多一次，不跟上面的 tick 同步
}
```

**为什么 ①a 要设 `markProgress: false`**：
如果本地段就推进了「巩固进度水位」，模型段会一天都捞不到 —— 因为水位已经过了。
水位必须由**最后一道工序**推进。

### 4.6 配置项（`config.json`）

小鲸鱼的真实配置，可以直接照抄：

```json
{
  "socialV2": {
    "memory": {
      "enabled": true,
      "recallLimit": 6,
      "episodicDays": 14,
      "recentHours": 24,
      "relevantSlots": 2,
      "consolidateDays": 1,
      "reviewPerTick": 3,
      "localDigest": true,
      "coldThreshold": 0.06,
      "tickMs": 1800000,
      "autobioInPrompt": true,
      "proceduralInPrompt": true,
      "sensoryRecall": true,
      "replay": {
        "enabled": true,
        "everyMs": 3600000,
        "days": 3,
        "rowsPerDay": 6,
        "seed": 0
      },
      "mergeDuplicates": true,
      "mergeDuplicateThreshold": 0.95
    }
  }
}
```

| 键 | 含义 | 调它会发生什么 |
|---|---|---|
| `recallLimit` | 一次检索最多给几条 | 小 → 省 token 但可能漏；大 → 全但啰嗦 |
| `episodicDays` | 流水往回查几天 | 默认 14。太长会翻出早就过时的事 |
| `recentHours` | 「最近」算多少小时 | 影响 `recent` 槽 |
| `relevantSlots` | 相关记忆给几个位置 | 2 是实测的平衡点 |
| `consolidateDays` | 一次巩固最多追几天 | 积压多时别调大，会卡 |
| `coldThreshold` | 低于这个分搬进冷库 | 0.06 是实测值，调高会搬太多 |
| `tickMs` | 多久跑一次整理 | 30 分钟。太快没必要，太慢积压 |
| `localDigest` | 开不开本地规则抽取 | **建议开**，零成本 |

### 4.7 迁移到别的平台

把上面的四个钩子换掉就行，库本身跟平台无关：

| 钩子 | QQ/qq-bridge | Telegram | Discord | 微信 |
|---|---|---|---|---|
| `where` | `private:QQ号` / `group:群号` | `tg:chatId` | `dc:channelId` | `wx:wxid` |
| `who` | 群名片/昵称 | first_name | username | 备注名 |
| `speakerId` | QQ 号 | user.id | user.id | wxid |
| 记流水 | `logEpisode` | 同 | 同 | 同 |
| 注入 | `gatherWorkingMemory` | 同 | 同 | 同 |

`where` 的作用是「分场合」。同一个人的私聊和群聊是两份流水，
但 `who` 相同 → 语义事实是共享的。这就是「跨场合共用一本账」。

---

## 5. 定时任务：让它自己整理记忆

### 5.1 方式一：进程内定时器（简单）

```js
import { digestPending } from 'whale-memory';

const TICK_MS = 30 * 60 * 1000;

let busy = false;
async function tick() {
  if (busy) return;          // ⚠ 必须防重入，上一轮没跑完时别叠上去
  busy = true;
  try {
    // ①a 本地规则抽取
    digestPending(mem, { maxDays: 3, markProgress: false });

    // ①b 模型巩固（没有模型就跳过，只靠本地也能用）
    // await consolidateWithModel(mem);

    // ② 衰减
    mem.decay({ coldThreshold: 0.06 });

    // ②b 合并重复
    mem.mergeDuplicates({ threshold: 0.95 });
  } catch (e) {
    console.error('[memory] tick 失败:', e.message);
    // ⚠ 不要让异常冒出去，否则定时器会被干掉
  } finally {
    busy = false;
  }
}

setInterval(tick, TICK_MS);
```

### 5.2 方式二：系统定时任务

**Linux / macOS（cron）**

```bash
# crontab -e
*/30 * * * * cd /path/to/your-bot && node scripts/memory-tick.mjs >> logs/memory.log 2>&1
```

**Windows（任务计划程序）**

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "C:\your-bot\scripts\memory-tick.mjs" `
  -WorkingDirectory "C:\your-bot"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "WhaleMemoryTick" -Action $action -Trigger $trigger
```

### 5.3 单独的 tick 脚本

```js
// scripts/memory-tick.mjs
import { createMemoryStore } from 'whale-memory';
import { digestPending } from 'whale-memory/local-digest';

const mem = createMemoryStore({ dir: './data/memory' });

const local = digestPending(mem, { maxDays: 3, markProgress: true, log: console.log });
const decay = mem.decay({ coldThreshold: 0.06 });
const merged = mem.mergeDuplicates({ threshold: 0.95 });

console.log(new Date().toISOString(), {
  digested: local.map((d) => d.day),
  decay,
  merged,
});
```

> 仓库里已经带了这个脚本：`node scripts/memory-tick.mjs --dir ./data/memory`。
> 支持 `--dry-run`（只报告不写盘）和 `--max-days 3`。
>
> ⚠️ 注意 `import 'whale-memory/local-digest'` 而不是 `'whale-memory/src/memory-local-digest.js'` ——
> `package.json` 的 `exports` 字段限制了可以从包外导入的路径，直连 `src/` 会被 Node 拒绝
> （报 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。如果你是**复制目录**而不是 npm 装的，就用相对路径。

### 5.4 多久跑一次

| 数据量 | 建议间隔 | 理由 |
|---|---|---|
| < 100 条记忆 | 1 小时 | 没必要更勤 |
| 100 ~ 1000 条 | 30 分钟 | 小鲸鱼在这个量级用 30 分钟 |
| > 1000 条 | 30 分钟 + 分批 | 别调大 `maxDays`，会卡住 |

`mergeDuplicates` 是 O(n²) 的双循环（每条跟已选中的每条比一次）。
1000 条大约几十毫秒，10000 条就会到秒级。记忆量大时考虑限制 `maxPairs`。

---

## 6. 数据在哪、怎么备份、怎么搬家

### 6.1 目录结构

```
你的数据目录/
├── index.json              计数器、巩固水位、统计
├── semantic.jsonl          语义记忆（一行一条 JSON）
├── procedural.json         程序记忆
├── review-queue.json       待复习（可选）
└── episodic/
    ├── 2026-10-24.jsonl
    ├── 2026-10-25.jsonl
    └── ...                 每天一个文件
```

**`semantic.jsonl` 是最重要的**。它就是「她记得的所有事」。纯文本、一行一条、
可以直接用 `cat`/`grep` 看，不需要数据库。

```bash
# 看看她记得什么
cat data/memory/semantic.jsonl | head -5 | python -m json.tool
```

### 6.2 备份

```bash
# 最简单：整个目录打包（先停进程，避免写一半）
tar czf memory-backup-$(date +%Y%m%d).tar.gz data/memory/
```

**为什么必须停进程**：桥/机器人在内存里持有 `semantic.jsonl` 的内容，
运行中的 `saveSemantic()` 会全量重写覆盖整个文件。备份时正在写就会拿到半截文件。

### 6.3 搬家

```js
// 导出（不依赖文件系统，走 API）
const all = mem.exportAll();
fs.writeFileSync('memory-export.json', JSON.stringify(all));

// 导入
const data = JSON.parse(fs.readFileSync('memory-export.json', 'utf8'));
mem.importAll(data);
```

### 6.4 手改数据的安全做法

`semantic.jsonl` 是纯文本，可以手改，但：

1. **先停进程**
2. **先备份**：`cp semantic.jsonl semantic.jsonl.bak-$(date +%Y%m%d-%H%M%S)`
3. 改完用 Node 校验一遍：

```js
import fs from 'node:fs';
const lines = fs.readFileSync('semantic.jsonl', 'utf8').split('\n').filter(Boolean);
let bad = 0;
for (const [i, l] of lines.entries()) {
  try { JSON.parse(l); } catch (e) {
    console.log(`第 ${i + 1} 行坏了:`, l.slice(0, 60));
    bad += 1;
  }
}
console.log(`${lines.length} 条，坏 ${bad} 条`);
```

4. 检查 `who` 有没有零宽字符（见 2.3 坑 2）

---

## 7. 词表：认识你自己的私房词

### 7.1 为什么要做这件事

通用中文词表（jieba，10.9 万词）不认识你们自己造的词。

在小鲸鱼的真实数据上实测：

| 词 | 通用词表切出来 | 后果 |
|---|---|---|
| 大肥鱼 | `大 / 肥 / 鱼` | 三个都是虚字，一个线索都抓不住 → 检索 0 条 |
| 小鲸鱼 | `小 / 鲸鱼` | 勉强剩一个 |
| 富江破甲 | `富 / 江 / 破 / 甲` | 全碎 |

「大肥鱼」在语料里出现 **82 次**，但系统一个词都认不出。这不是调参数能救的，
是切词就错了。

### 7.2 生成你自己的词表

```bash
# 先看会挖出什么（不写盘）
node scripts/learn-lexicon.mjs

# 确认没问题，写盘
node scripts/learn-lexicon.mjs --apply
```

它会：

1. 读你的 `semantic.jsonl` + `episodic/*.jsonl`
2. 找 2~6 字的高频组合
3. 用三个条件筛（**老在一起** × **前后能接别的字** × **见得够多**）
4. 排除通用词表里已有的
5. 写进 `data/jieba-learned.txt`

输出示例：

```
语料：3162 段，98835 字
候选过筛：1829 → 去子串 → 1829 → 词表里没有的 → 974

前 40 个新词：
  参考音频     频 35  PMI  9.53  熵 3.65  分 34.8
  伊蕾娜      频 21  PMI 11.72  熵 2.94  分 34.43
  满穗       频 39  PMI  9.37  熵  3.1  分 29.01
  ...
```

### 7.3 三个条件是什么（为什么要三个）

| 条件 | 挡掉什么 | 反例 |
|---|---|---|
| **老在一起**（PMI ≥ 4.0） | 偶然相邻的字 | 「的时」在语料里也常相邻，但不是词 |
| **前后能接别的字**（熵 ≥ 0.9） | 别的词的尾巴 | 「肥鱼」前面永远只接「大」→ 熵 0 → 它是尾巴不是词 |
| **见得够多**（频次 ≥ 3） | 笔误、一次性说法 | 只出现 1 次的长串 |

第二条最关键。「熵低 = 邻居固定 = 某词的一部分」这一条，能自动去掉所有
被更长真词包住的尾段，不需要人工维护排除表。

### 7.4 手动加词

`data/jieba-learned.txt` 就是一行一个词，直接加：

```bash
echo "富江破甲" >> data/jieba-learned.txt
echo "抖M" >> data/jieba-learned.txt
```

**注意**：这个文件是**合并**读取的，不是覆盖。原词表 `jieba-dict.txt` 不动。
删掉 `jieba-learned.txt` 就回到纯通用词表。

### 7.5 什么时候该重跑

- 你的机器人聊了新的圈子/新的黑话（每几周看一下）
- 换了领域（从闲聊变成技术支持）
- 发现某个词搜不到，先手动加，再定期重跑

---

## 8. 排错手册

### 检索总是返回空

| 可能原因 | 怎么查 | 解决 |
|---|---|---|
| 词表没拷过去 | `node -e "console.log(require('fs').existsSync('data/jieba-dict.txt'))"` | 把 `data/` 一起拷 |
| `who` 对不上 | `mem.allSemantic().map(m => JSON.stringify(m.who))` 看有没有空格/零宽 | 清洗或统一 |
| 记忆真的没写进去 | `mem.stats().semantic` 是 0 吗 | 检查 `remember` 返回值是不是 `null` |
| 查的词太泛（「怎么样」） | 换个具体的词试试 | 正常行为，不硬凑 |
| 数据在冷库 | `mem.searchCold(q)` 有没有 | 冷库不参与普通 recall |

### `remember` 返回 `null`

```js
const r = mem.remember('');            // null —— 空文本
const r2 = mem.remember('[object Object]'); // null —— 传了个对象没取 .text
```

`remember` 第一个参数应该是**字符串**。传对象时它会取 `.text`，取不到就是 `null`。

### 定时任务跑着跑着停了

最常见：`try/catch` 没包住，异常把定时器干掉了。

```js
// ❌ 这样异常会冒出去
setInterval(async () => { await tick(); }, 1800000);

// ✅ 这样才稳
setInterval(async () => {
  try { await tick(); } catch (e) { console.error(e); }
}, 1800000);
```

### 记忆越存越乱，检索出来都是变体

`mergeDuplicates` 没在跑，或者阈值调太高。

```js
mem.mergeDuplicates({ threshold: 0.95, dryRun: true });  // 先看会并掉什么
```

阈值选择（实测过）：

| 阈值 | 效果 |
|---|---|
| 0.92 | 开始误并「同一天的两件不同的事」 |
| **0.95** | 只抓逐字重复（推荐） |
| 0.98 | 太保守，很多变体抓不到 |

### 分词把词切碎了

```bash
node scripts/check-lexicon.mjs
```

它会检查 12 项：词表规模、自学习词是不是整体、疑问词有没有被挡、意图词有没有留。

### 模型巩固老是失败

`consolidatePendingWithModel` 需要一个 `ask` 函数（调你的模型）。
模型挂了怎么办：**本地规则抽取照常跑**，这是把两段分开设计的原因 ——
零成本那段永远不会因为模型挂了而空手而归。

```js
try {
  await consolidatePendingWithModel(mem, { maxDays: 1, ask: myAsk });
} catch (e) {
  console.warn('[memory] 模型巩固失败，本轮只做本地抽取:', e.message);
  // 不要让这个失败影响后面的 decay / merge
}
```

---

## 附：最小可运行清单

如果你只想先跑起来，就这四行：

```js
import { createMemoryStore } from 'whale-memory';
const mem = createMemoryStore({ dir: './data/memory' });
mem.logEpisode({ who: '他', text: '今天说的第一句话' });
console.log(mem.recall('第一句话', { limit: 3 }));
```

跑通了再往上加。

---

**相关文档**

- [README.md](README.md) — 它怎么工作（含完全不技术的小白版）
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 每个设计的取舍，含 5 个被否决的方案
- [CONTRIBUTING.md](CONTRIBUTING.md) — 改代码前必须知道的三条硬规矩
- [CHANGELOG.md](CHANGELOG.md) — 版本变更与量化结果
