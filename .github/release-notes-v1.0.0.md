## 首个公开版本

从一套真实运行了半年、服务单一角色的记忆系统里抽出来，去掉业务耦合，补上测试与文档。

### 它是什么

一个**会淡忘、能联想、并且真的记得住「这个人是谁」**的长期记忆系统。零依赖、纯本地、中文优先。

数据就是几个 JSON 文件，你随时能打开看。

### 核心机制

- **三层 × 四型记忆** — `core`/`long`/`working` × `episodic`/`semantic`/`pending`/`core`（另有 `profile`/`procedural`）
- **幂律衰减** — `recency = (1 + age_days)^(-alpha)`，尾巴长、永不归零。不用指数半衰期
- **证据门槛与排序分离** — 门槛卡 `evidence`（这条跟问题有没有真关系），重要度与衰减只参与排序
- **双尺子稀有度** — 库内 df（对数式）× jieba 通用词频 × 单字降权
- **jieba 词表分词** — 10.9 万词最长匹配 + 单字兜底，消除跨词碎片
- **词表自学习** — PMI × 自由度 × 频次，从你自己的语料挖私房词
- **LSA 语义空间** — 新词发现 → PPMI 共现 → 随机化 SVD，零依赖、可解释
- **睡眠重放** — 跨天碎片重组的联想单独占一个工作记忆槽
- **重复合并** — 相似度分母取 `min`，专门抓「A 是 B 的片段」形态
- **零宽字符清洗** — 避免 `who` 严格相等导致整批记忆静默失联

### 实测数据

在 232 条语义记忆 + 2698 条情景记忆的真实语料上：

| 指标 | 结果 |
|---|---|
| `recall@1` | 13/18（调参集）/ 12/15（泛化集） |
| `recall@3` | 14/18 / 13/15 |
| `recall` 延迟 | p50 65 ms |
| 空手率 | 0 轮（18 条）/ 1 轮（15 条） |

### 工程

- 零运行时依赖，只用 Node 内置模块
- 13 个单元测试，`npm test` 即可运行
- CI 覆盖 3 平台 × 4 个 Node 版本
- 附可交互架构图（`docs/diagrams/whale-memory-architecture.html`）

### 已知问题

- `mergeDuplicates` 是 O(n²)，超过几千条需要加 LSH 或按 `who` 分桶
- `createMemoryStore` 全量读入所有语义记忆，万级以上需改成按需加载
- 不支持多进程并发写同一目录
- LSA 语义空间需要 ≥60 篇文档才启用

### 安装

```bash
npm install whale-memory
```

或者直接复制 `src/` 目录——它没有任何依赖。

```bash
npm run demo   # 端到端看一遍
npm test       # 13 个测试
```

---

完整变更见 [CHANGELOG.md](https://github.com/yokipeek/whale-memory/blob/main/CHANGELOG.md)。
