# 推到 GitHub 的三种方式（挑一条跑）

仓库已经在 `D:\project\whale-memory`，2 个提交、32 个文件、工作区干净。
远端已配好：`git@github.com:yokipeek/whale-memory.git`，用 `~/.ssh/id_github_yokipeek` 这把 key。

**你只需要先在 GitHub 上把仓库建出来**（网页点一下就行），然后推送。

---

## 方式一：网页建仓库 + 命令行推（最稳，推荐）

### 1. 建仓库

打开 https://github.com/new

- Owner 选 **yokipeek**
- Repository name 填 **whale-memory**
- 描述填：`会淡忘、能联想、跨场合记住同一个人的长期记忆系统。零依赖，纯本地。`
- 选 **Public**
- ⚠️ **不要**勾 "Add a README file"、**不要**勾 .gitignore、**不要**选 license
  （本地已有，勾了会冲突，推上去要 merge）

点 Create repository。

### 2. 推送

```powershell
cd D:\project\whale-memory
git push -u origin main
```

如果提示 `src refspec main does not match any`，说明本地分支叫 master，先改名：

```powershell
git branch -M main
git push -u origin main
```

### 3. 打 tag

```powershell
git tag -a v1.0.0 -m "Whale Memory v1.0.0 首个公开版本"
git push origin v1.0.0
```

### 4. 去 Releases 页面

https://github.com/yokipeek/whale-memory/releases/new

选 tag `v1.0.0`，标题填 `v1.0.0`，正文直接复制 `CHANGELOG.md` 里 `## [1.0.0]` 那一段。

---

## 方式二：换个 token 给 gh 用（一次搞定建仓库+推送）

如果你有 yokipeek 的 Personal Access Token：

```powershell
$env:GH_TOKEN = "ghp_你的token"
gh repo create yokipeek/whale-memory --public `
  --description "会淡忘、能联想、跨场合记住同一个人的长期记忆系统。零依赖，纯本地。" `
  --source . --push
```

Token 需要 `repo` + `workflow` 权限（因为仓库里有 `.github/workflows/ci.yml`）。

> ⚠️ 用完记得 `Remove-Item Env:GH_TOKEN`，别留在环境变量里。

---

## 方式三：SSH 已经通了，只差建仓库

我实测过 `id_github_yokipeek` 这把 key 是通的：

```
Hi yokipeek! You've successfully authenticated, but GitHub does not provide shell access.
```

所以只要你建好空仓库，`git push` 就能成功，不需要额外配任何东西。

---

## 推送后会看到的

### CI 会自动跑

`.github/workflows/ci.yml` 会在 3 个平台（Linux / Windows / macOS）× 4 个 Node 版本（18/20/22/24）上跑：

1. 确认零依赖（`dependencies` 必须是 0 个）
2. 语法检查（所有 `.js` / `.mjs`）
3. 13 个单元测试
4. 端到端 demo
5. 词表可用性（含「大肥鱼」必须是一个词）

想让它显示绿色徽章，把 README 顶部那行改成：

```markdown
[![CI](https://github.com/yokipeek/whale-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/yokipeek/whale-memory/actions/workflows/ci.yml)
```

### 建议马上做的三件事

1. **仓库设置 → Social preview**：上传 `docs/diagrams/whale-memory-architecture.png`（1280×640 裁一下）
2. **仓库设置 → Topics**：填 `memory` `long-term-memory` `llm` `chatbot` `companion` `chinese` `bm25` `lsa` `jieba`
3. **仓库设置 → About**：勾上 "Use your repository's README" 那句话会自动显示

---

## 出问题怎么办

### `Permission denied (publickey)`

```powershell
ssh -T -o IdentitiesOnly=yes -i ~/.ssh/id_github_yokipeek git@github.com
```

应该回 `Hi yokipeek!`。如果回的是 `Hi orchidsd!`，说明 key 用错了：
`~/.ssh/config` 里 `gh-yokipeek` 那个块的 `#User git` 是注释掉的，别名会失效。
本仓库已经用 `core.sshCommand` 直接指定 key，绕过了这个坑。

### `remote: Repository not found`

仓库还没建。回到方式一第 1 步。

### `Updates were rejected`

你在网页上建仓库时勾了 README / license。跑：

```powershell
git pull --rebase origin main
git push -u origin main
```

### `refusing to allow an OAuth App to create or update workflow`

token 缺 `workflow` 权限。去 https://github.com/settings/tokens 重发一个，勾上 `workflow`。

---

## 回滚

如果你推错了想撤：

```powershell
# 只删远端分支，本地不丢
git push origin --delete main
```

网页上进 Settings → 最下面 Danger Zone → Delete this repository。
