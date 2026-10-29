# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- **一键装进 qq-bridge**：`node scripts/install-to-bridge.mjs`（默认干跑，`--apply` 真装）。拷十个 `memory-*.js` + 词表、按语义锚点给 `bridge.js` 打九处补丁、注册四个记忆工具。幂等（探针字符串判定）、抗上游升级（锚点不依赖行号）、可回滚（改前备份 + 写完 `node --check`，语法错自动还原）
- **自动定位 qq-bridge**：依次尝试 `--bridge` 参数、`QQ_BRIDGE_DIR` 环境变量、仓库旁边的 `qq-bridge` / `qq-bridge-hub/qq-bridge`、当前目录往上六层、常见默认位置，每个候选都用 `looksLikeBridge()` 验（`src/bridge.js` 存在 + package.json name 含 qq-bridge）。找不到时列出所有试过的路径
- **`FROM-SCRATCH.md`**：从一台干净机器开始的七步顺序，包含哪一步能一键、哪一步必须手动（SnowLuma 因 EULA 禁自动化部署）、每一步的失败信号对照表。配了六张真实截图（DSH 首屏、SnowLuma 登录页、OneBot 的 HTTP/WS 两个端口页、桥控制台），QQ 号与头像已打码
- **`scripts/check-env.mjs`**：十三项只读环境自检（`npm run check:env`）。查 Node 版本、桥在哪、白名单填没填、DSH 与 SnowLuma 通不通、preset 在不在、记忆层关键符号齐不齐、词表全不全。每条不通过直接给修复命令，退出码 0/1 = 有无阻塞项。**判「记忆层装了没」用的是八个必现符号而不是注释块计数** —— 因为「把回忆拼进提示词」那条补丁是往既有行尾追加变量、不插注释块
- **`examples/minimal-bot.mjs`**：零依赖 HTTP 机器人示例，与 QQ/TG 无关，三个接入点可照抄
- **`scripts/shoot-snowluma.mjs` / `scripts/shoot-bridge-console.mjs`**：文档截图的复现脚本（可选，需要 playwright），截图前自动给 QQ 号/头像/token 打码

### 修复

- **程序记忆把回忆提问学成做法**：「你还记得我熬夜的事吗」被抽成技能名「我熬夜的事吗」，提示词多一条「做法」让模型每轮照演。正则加 `(?<![还你我])` 并标记 `notQuestion`，另在抽取出加问句过滤
- **「别人」被当成否定词（语义反转）**：「我不喜欢别人叫我老板」被抽成「做法：别这样做 —— 别人叫我老板」，把对方讨厌的事记成该做的事。`别` 后加 `(?!人)`
- **UTF-8 在 chunk 边界被劈开**：示例服务里 `for await` 对每个 Buffer 单独 `toString()`，中文字符 3 字节跨边界会存成永久乱码。改用 `req.setEncoding('utf8')`

## [1.0.0] — 2026-10-29

首个公开版本。从一套真实运行了半年、服务单一角色的记忆系统里抽出来，去掉业务耦合，补上测试与文档。

### 核心

- **三层 × 四型记忆**：`core` / `long` / `working` × `episodic` / `semantic` / `pending` / `core`（另有 `profile` / `procedural`）
- **幂律衰减**：`recency = (1 + age_days)^(-alpha)`，尾巴长、永不归零。不用指数半衰期
- **证据门槛与排序分离**：门槛卡 `evidence`（这条跟问题有没有真关系），重要度与衰减只参与排序
- **双尺子稀有度**：库内 df（对数式）× jieba 通用词频 × 单字降权
- **jieba 词表分词**：10.9 万词最长匹配 + 单字兜底，消除跨词碎片
- **词表自学习**：PMI × 自由度 × 频次，从你自己的语料挖私房词
- **LSA 语义空间**：新词发现 → PPMI 共现 → 随机化 SVD，零依赖、可解释
- **睡眠重放**：跨天碎片重组的联想单独占一个工作记忆槽
- **重复合并**：相似度分母取 `min`，专门抓「A 是 B 的片段」形态
- **零宽字符清洗**：避免 `who` 严格相等导致整批记忆静默失联

### 工程

- 零运行时依赖，只用 Node 内置模块
- 数据就是 JSONL / JSON，可直接 `cat`、`grep`、`cp -r`
- 13 个单元测试，`node --test` 即可运行
- 附可交互架构图（Archify 生成，含 `candidate.json` 源文件）

### 已验证的量化结果

在 232 条语义记忆 + 2698 条情景记忆的真实语料上：

| 指标 | 结果 |
|---|---|
| `recall@1` | 13/18（调参集）/ 12/15（泛化集） |
| `recall@3` | 14/18 / 13/15 |
| `recall` 延迟 | p50 65 ms |
| 空手率 | 0 轮（18 条）/ 1 轮（15 条） |

### 已知问题

- `mergeDuplicates` 是 O(n²)，超过几千条需要加 LSH 或按 `who` 分桶
- `createMemoryStore` 全量读入所有语义记忆，万级以上需改成按需加载
- 不支持多进程并发写同一目录
- LSA 语义空间需要 ≥60 篇文档才启用

---

## 版本规划

- `1.1` — 合并去重的 LSH 加速；按需加载；英文分词支持
- `1.2` — 可选的外部 embedding 接口（保留零依赖默认路径）
- `1.3` — 多租户（按 `who` 逻辑隔离而非目录隔离）
