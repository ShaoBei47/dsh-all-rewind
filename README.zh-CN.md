# dsh-all-rewind

[![CI](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/DSH-desktop%20%26%20web-4d7cfe)](https://harness.deepseek.com)

**[English](README.md)** · 中文说明

给 [DeepSeek Harness](https://harness.deepseek.com)（DSH）用的**对话轮次回退**插件：
每轮对话开始前给工作区打快照，AI 每次改文件后再提交一次，**在你发出的提示词下方点一下**，就能把工作区还原到那一轮之前的状态。

```text
┌─────────────────────────────────────────────────────────────┐
│  你：把登录页按钮改成蓝色，顺便删掉旧的 API 代码                 │
└─────────────────────────────────────────────────────────────┘
                    ↩ 回退到第 12 轮对话之前
```

- **位置符合直觉**：回退入口就在**你自己的提示词**下方（和 TRAE 一样）。
- **可逆**：每次回退前自动留安全快照，误回退还能再退回来。
- **磁盘有界**：未变文件跨版本共享、旧轮次自动修剪、超阈值自动 GC。
- **存储可放别的盘**：改一个 `dataDir` 配置就行。

---

## 目录

- [效果预览](#效果预览)
- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [安装](#安装)
  - [最快安装（GitHub）](#最快安装github)
  - [从 npm 安装](#从-npm-安装)
  - [手动安装（npm 包 → profile）](#手动安装npm-包--profile)
  - [从源码安装](#从源码安装)
  - [验证安装](#验证安装)
  - [升级 / 卸载](#升级--卸载)
- [快速上手](#快速上手)
- [使用](#使用)
- [配置](#配置)
- [快照存在哪](#快照存在哪)
- [工作原理](#工作原理)
- [磁盘占用](#磁盘占用)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [参与贡献](#参与贡献)
- [License](#license)

---

## 效果预览

安装并重启 DSH 之后，你发出的每条提示词下面都会多出一行小字：

```text
┌─────────────────────────────────────────────────────────────┐
│  你：把登录页按钮改成蓝色，顺便删掉旧的 API 代码                 │
└─────────────────────────────────────────────────────────────┘
                    ↩ 回退到第 12 轮对话之前
```

鼠标悬停可看：这一轮改了几个文件、消息预览、快照存储位置与占用。
点击 → 二次确认 → AI 在这一轮的文件改动静默撤销，底部浮层显示还原/删除/跳过文件数以及安全快照版本。

---

## 功能特性

| | |
| --- | --- |
| **轮次快照** | `turn/start` 时写入 `before-chat-turn-<n>`，此时模型还没动任何文件。 |
| **工具级提交** | 每次会改文件的工具结果写入 `toolcall-<n>-<callId>`，历史可审计。 |
| **文件级还原** | 还原被改文件、删除该轮新建文件、**永不删除任何快照都没见过的文件**。 |
| **安全** | 回退前留安全快照、检测手动改动冲突、扫描被截断时拒绝回滚。 |
| **省磁盘** | 内容寻址目录树，未改动的文件/目录跨版本共享。 |
| **自动维护** | `keepTurns` 窗口修剪 + 超过体积阈值自动 GC。 |
| **存储可配** | `dataDir` / `DSH_ALL_REWIND_DIR`，支持绝对路径、`~/…`、相对 `$DSH_HOME`。 |
| **可脚本化** | Agent 工具 `rewind_status` / `rewind_list` / `rewind_restore` / `rewind_prune`，以及仅本机可访问的 HTTP API。 |

---

## 环境要求

- 支持插件机制的 DeepSeek Harness（桌面端或 web profile）。
- **只有手动/源码安装需要 Node.js 22+**；走 DSH 插件管理器安装不需要本机 Node。
- 无运行时 npm 依赖，Windows / macOS / Linux 均可。

---

## 安装

> 无论用哪种方式，装完都要**重启 DeepSeek Harness**：桌面端在启动时加载插件并注入客户端 UI。

### 最快安装（GitHub）

现在就能用，不依赖 npm 发布：

```bash
dsh plugin --profile web add github:ShaoBei47/dsh-all-rewind
```

**桌面端**：在 DSH 会话里让 Agent 安装 `dsh-all-rewind`（它会走插件管理器的 `install_bundle`），
或使用插件管理界面。**不要**在终端对桌面 profile 执行 `dsh plugin --profile desktop …`——桌面 profile 由应用托管。

### 从 npm 安装

npm 包发布后可用：

```bash
dsh plugin --profile web add dsh-all-rewind
```

桌面端同样通过 DSH Agent / 插件界面安装，而不是终端。

### 手动安装（npm 包 → profile）

不想用插件管理器时，可以下载 npm 包，再用仓库里的安装脚本复制进 profile：

```bash
# 1) 把 npm 包下载到临时目录
npm install --prefix "%TEMP%\dsh-rewind-pkg" dsh-all-rewind

# 2) 复制进 desktop profile 并写入 cordis.patch.yml
#    在本仓库目录里执行（需要 Node 22+）
node install.mjs --source "%TEMP%\dsh-rewind-pkg\node_modules\dsh-all-rewind"
```

### 从源码安装

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind

node install.mjs                                        # 装进 desktop profile
node install.mjs --profile web                          # 装进其它 profile
node install.mjs --data-dir E:/dsh-rewind-snapshots     # 快照放到另一个盘
node install.mjs --dry-run                              # 只预览要改什么
```

`install.mjs` 会把运行时文件复制到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-all-rewind`，
并向 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 追加一个受管理的配置块（自动生成时间戳备份）。
它**不会碰你的快照数据**，并且会自动清理旧的 `dsh-trae-rewind` 条目。

**手动等价做法：** 把本目录复制到 `<DSH_HOME>/profiles/desktop/node_modules/dsh-all-rewind`，
然后在 `<DSH_HOME>/profiles/desktop/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-all-rewind
      name: dsh-all-rewind
      config:
        keepTurns: 20
```

### 验证安装

- 你的提示词下方出现回退小字；
- 宿主日志出现 `dsh-all-rewind ready (dataDir=…)`；
- 让 Agent 调 `rewind_status`，或访问：

  ```bash
  curl http://127.0.0.1:19387/dsh-all-rewind/api/status
  ```

### 升级 / 卸载

```bash
# 从更新的代码重新安装 / 升级
node install.mjs

# 卸载：移除 profile 里的注册条目和副本（快照数据保留）
node install.mjs --uninstall
```

卸载后同样需要重启 DeepSeek Harness。

---

## 快速上手

1. **安装并重启**（见上）；
2. 发一条会让 AI 改文件的提示词；
3. 几秒内这条提示词下方会出现 `↩ 回退到第 N 轮对话之前`；
4. 悬停确认 → 点击 → 二次确认，即可回退。

已经打开的编辑器标签需要重新打开才能看到还原后的内容。

---

## 使用

### 在提示词下方回退

- 只有**有快照的轮次**才会出现入口（插件运行期间捕获、且还在 `keepTurns` 窗口内）。
- 点击 → 二次确认 → 工作区还原到**该轮对话发起前**。
- 回退前先写 `pre-revert-<时间>` 安全快照，回退后再写 `post-revert-<时间>` 基线，所以回退本身可再次回退。
- 文件处理规则：

  | 情况 | 动作 |
  | --- | --- |
  | 该轮被修改过 | 从快照还原 |
  | 该轮新建 | 删除 |
  | AI 回合之外被手动改过 | 默认覆写（记为 conflict），或配 `onConflict: "skip"` 跳过 |
  | 任何快照都没见过 | **不动** |

### 让 Agent 帮你回退

| 工具 | 作用 |
| --- | --- |
| `rewind_status` | 快照仓库 / 回滚点 / 存储位置与占用概览 |
| `rewind_list` | 当前会话的回滚点（`all: true` 看全部会话） |
| `rewind_restore` | 执行回滚：`{ target, dryRun?, onConflict?, force? }` |
| `rewind_prune` | 修剪 `keepTurns` 窗口之外的版本 |

可以直接说：

- “列出我的回滚点”
- “回退到第 3 轮之前”
- “先看看回退到第 2 轮会影响哪些文件，不要真的改”（用 `dryRun: true`）

`target` 支持版本号（推荐）、commit/tree 前缀或标签（如 `before-chat-turn-3`）。

### HTTP API

界面用的就是这套仅本机 API，也方便脚本调用。端点只接受回环地址、拒绝跨站请求，POST 需要
`Content-Type: application/json`。

```
GET  /dsh-all-rewind/api/status            # storage.dataDir、diskBytes、会话/回滚点数量
GET  /dsh-all-rewind/api/sessions
GET  /dsh-all-rewind/api/points?sessionId=<id>
POST /dsh-all-rewind/api/revert            {sessionId, target, dryRun?, onConflict?, force?}
POST /dsh-all-rewind/api/prune             {sessionId?}
POST /dsh-all-rewind/api/maintenance       {sessionId?, keepVersions?}
GET  /dsh-all-rewind/ui.js
```

```bash
curl -X POST http://127.0.0.1:19387/dsh-all-rewind/api/revert \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"session-abc","target":12,"dryRun":true}'
```

---

## 配置

配置写在 profile 的 `cordis.patch.yml` 里（`install.mjs` 管理的那段插件条目）：

```yaml
- insert:
    - id: dsh-all-rewind
      name: dsh-all-rewind
      config:
        dataDir: "E:/dsh-rewind-snapshots"   # 可选，见「快照存在哪」
        keepTurns: 20
        autoMaintenance:
          enabled: true
          thresholdBytes: 134217728          # 128 MiB
          checkEveryTurns: 3
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/dsh-all-rewind` | 快照根目录（绝对路径 / `~/…` / 相对 `$DSH_HOME`）。 |
| `keepTurns` | `20` | 保留多少个轮次回滚点；窗口外的工具调用版本一并修剪。 |
| `autoMaintenance.enabled` | `true` | 是否启用自动磁盘维护。 |
| `autoMaintenance.thresholdBytes` | `134217728` | 单个仓库超过该大小触发 GC。 |
| `autoMaintenance.checkEveryTurns` | `3` | 每多少轮检查一次（检查很便宜）。 |
| `autoMaintenance.keepVersions` | `200` | 自动 GC 保留的版本数。 |
| `maxFileBytes` | `1048576` | 超过该大小的文件不参与版本化。 |
| `maxFiles` | `8000` | 扫描文件数上限；超出会标记截断并**拒绝回滚**（避免误删）。 |
| `maxTotalBytes` | `268435456` | 扫描总字节上限。 |
| `ignoreDirs` | `.git`、`node_modules`、`dist`、`.tmp` 等 | 追加忽略目录名。 |
| `ignoreFiles` | `.DS_Store` 等 | 追加忽略文件名。 |
| `captureSkipTools` | 只读工具（`read`、`grep`、`web_*` 等） | 不触发快照的工具。 |
| `respectSandboxPolicy` | `true` | 只读会话拒绝回滚（`force: true` 可绕过）。 |
| `onConflict` | `overwrite` | 快照后被手改的文件如何处理：`overwrite` 或 `skip`。 |
| `http.enabled` | `true` | 是否注册本地 HTTP API / UI 资源路由。 |
| `http.requireLocalOrigin` | `true` | 强制回环 Host、同源与 CSRF 校验。 |
| `ui.enabled` | `true` | 是否注入客户端回退入口。 |

---

## 快照存在哪

解析优先级：

1. `cordis.patch.yml` 里的 `config.dataDir`；
2. 环境变量 `DSH_ALL_REWIND_DIR`（旧的 `DSH_TRAE_REWIND_DIR` 仍兼容）；
3. 默认 `$DSH_HOME/dsh-all-rewind`（Windows 通常是 `C:\Users\<你>\.dsh\dsh-all-rewind`）。

支持绝对路径、`~/…`、以及相对 `$DSH_HOME` 的路径。当前实际位置与占用可在按钮悬停提示、
`rewind_status` 或 `GET /api/status`（`storage.dataDir` / `storage.diskBytes`）查看。

修改 `dataDir` **不会自动迁移**已有快照，需要的话手动移动或删除旧目录。
每个会话的目录结构（`<dataDir>/snapshots/<会话ID>/v2/`）：

```text
objects/<aa>/<rest>      内容寻址的文件 blob 与目录树节点（zlib 压缩，sha256 命名）
base/content/<rel>       最新快照的工作区镜像
disk/content/<rel>       已删除文件的墓碑副本
version_file_<n>.json    每个版本一个很小的元数据文件：根 tree id、变更集、统计
first_graph.json         仓库身份（会话 id + 工作区）
latest_change.json       指向最新版本
```

---

## 工作原理

```text
session/created   → baseline-<时间>                 首次观察工作区
turn/start        → before-chat-turn-<轮次>         ← 「回退到第 N 轮之前」的目标点
                    + 修剪 keepTurns 之外的版本
                    + 必要时执行自动维护
user/message      → 把该轮提示词预览挂到刚才的点上
tool/call         → 记住 callId → 工具名
tool/result       → toolcall-<轮次>-<callId>        （只读工具跳过）
回退              → pre-revert-<时间> → 写回文件 → post-revert-<时间>
```

每个会话一个隐藏仓库，保持 TRAE 的目录布局与锚点命名，但内部使用自带的**内容寻址存储**而不是
调用 `git`：blob 用 zlib 压缩、按 sha256 命名；目录树是内容寻址的 JSON
（`{"f":{文件→blob},"d":{目录→子树 id}}`），未变子树跨版本共享——和 git tree 的结构共享思路一致。
好处是没装 git 的机器、以及禁止 spawn 子进程的受限宿主也能用。

还原时对比「目标版本的文件树 / 当前磁盘状态 / 最新快照」：

| 情况 | 动作 |
| --- | --- |
| 目标里有、磁盘缺失 | 从 blob 还原 |
| 目标里有、内容一致 | 跳过 |
| 目标里有、内容不同 | 覆写（手改过会记为 `conflict`） |
| 目标之后新建的 | 删除 |
| 从未被快照见过 | **不动** |
| 扫描被截断 | 拒绝回滚 |

---

## 磁盘占用

同一套合成负载实测（`v0.1` 每版内嵌全量清单 → 现在的共享树清单 + 窗口修剪）：

| 场景 | 工作区 | v0.1 快照目录 | **当前快照目录** |
| --- | --- | --- | --- |
| 400 文件 / 30 轮（61 版本） | 1.3 MiB | 6.8 MiB | **1.6 MiB**（元数据 65 KiB） |
| 2000 文件 / 20 轮（41 版本） | 6.4 MiB | 25.0 MiB | **7.4 MiB**（元数据 104 KiB） |

固定成本是 `base/content` 镜像（≈ 1× 被跟踪源码）和确实改过的文件内容；
`keepTurns`、忽略规则与自动维护让长会话保持在合理范围。

---

## 已知限制

- **只还原文件，不截断对话**：和 TRAE 的按钮一致，聊天记录保留。
- **只有捕获到的轮次**才有入口：安装前的旧轮次、或被 `keepTurns` 修剪掉的轮次没有。
- **共享工作区**：并行会话/子代理改同一目录时各自快照独立；回滚其中一个会写回它的文件状态，可能覆盖另一个的并发修改。
- **大文件与忽略目录不参与版本化**（`maxFileBytes`、`ignoreDirs`）。
- **只读会话**默认拒绝回滚（可 `force: true`）。
- 修改 `dataDir` 不会迁移旧快照。

---

## 常见问题

**提示词下方没有回退小字？**

1. 安装后是否**重启**了 DeepSeek Harness？插件和客户端 UI 都在启动时加载；
2. 让 Agent 调 `rewind_status`（或访问 `/dsh-all-rewind/api/status`），确认插件版本与存储路径；
3. 打开 DevTools 控制台执行 `__dshAllRewind`：`undefined` 说明客户端脚本没注入；
   `__dshAllRewind.state` 看识别到的会话/回滚点，`__dshAllRewind.reconcile()` 可手动重扫；
4. 通过插件管理器安装的，确认该 bundle 在当前 profile 已启用。

**较早的提示词没有回退入口？**

那一轮没有快照：插件是之后才启动的，或版本已被 `keepTurns` 修剪。调大 `keepTurns`、重启后新轮次会保留更多历史。

**回退结果里有“跳过”的文件？**

这些文件在快照之后被 AI 回合之外的操作改过。默认策略会覆写（有安全快照兜底）；
想永远保留手改内容可设 `onConflict: "skip"`。

**磁盘占用高了怎么办？**

用 `rewind_status` 或按钮悬停提示看大小；调小 `keepTurns`、补充 `ignoreDirs`，
或调用 `POST /api/maintenance`（或 `rewind_prune`）立即修剪并 GC。

**桌面端用终端 CLI 装不了？**

桌面 profile 由应用托管。请通过 DSH Agent / 插件界面安装，或用手动/源码安装方式；
只有 web profile 支持 `dsh plugin --profile web add …`。

---

## 参与贡献

欢迎提 Issue 和 PR；较大的改动建议先开 Issue 讨论。

- 开发环境、测试命令、目录结构、发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；
- PR 前跑一遍：

  ```bash
  npm test          # node --test test/（Node 22+）
  npm run smoke     # 端到端冒烟测试
  ```

---

## License

[MIT](LICENSE)
