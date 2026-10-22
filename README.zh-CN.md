# dsh-all-rewind

[![npm version](https://img.shields.io/npm/v/dsh-all-rewind.svg)](https://www.npmjs.com/package/dsh-all-rewind)
[![CI](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[English](README.md)** · 中文说明


TRAE 风格的「**回退到某轮对话发起之前**」插件，用于 [DeepSeek Harness](https://harness.deepseek.com)（DSH）：
每轮对话开始前给工作区打快照，AI 每次工具调用后再提交一次；点一下就能把工作区文件还原到那一轮之前的状态。

> 机制对标 TRAE：每会话一个隐藏快照仓库、`before-chat-turn` / `toolcall` 锚点、内容寻址存储、文件级回灌。
> 存储后端换成了内置的**内容寻址目录树**：结构共享 + 内容去重 + 自动维护，不依赖本机 `git`。

- 回退入口在**你发送的每条提示词气泡下方**（TRAE 同款位置），不再是悬浮面板。
- **可逆**：回退前自动记录安全快照，误回退还能再回退回来。
- **磁盘有界**：未变文件跨版本共享、旧轮次按窗口修剪、超阈值自动 GC。
- **存储位置可配**：一条命令把快照放到别的盘。

> v0.4 起项目整体改名为 **dsh-all-rewind**（npm 包名、仓库、HTTP API 前缀、默认数据目录均更新）。
> 新版本安装时会自动清理旧的 `dsh-trae-rewind` 注册条目；快照数据不受影响（保留原来的 `dataDir` 配置即可继续用）。

---

## 目录

- [效果预览](#效果预览)
- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [快照存在哪](#快照存在哪)
- [工作原理](#工作原理)
- [磁盘占用](#磁盘占用)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [开发与测试](#开发与测试)
- [发布（维护者）](#发布维护者)
- [License](#license)

---

## 效果预览

安装并重启后，你发出的每条提示词下面都会多出一行小字：

```text
┌────────────────────────────────────────────────────────────┐
│  你：把登录页按钮改成蓝色，顺便把 api.ts 里的旧接口删掉        │
└────────────────────────────────────────────────────────────┘
                          ↩ 回退到第 12 轮对话之前
```

鼠标悬停可看：本轮改动了几个文件、该轮消息预览、快照存储位置与占用。
点击 → 二次确认 → AI 在这一轮的改动静默撤销（底部浮层显示还原/删除/跳过文件数、安全快照版本）。

---

## 功能特性

| | |
| --- | --- |
| **轮次快照** | `turn/start` 时写入 `before-chat-turn-<n>`，此时模型还没动任何文件。 |
| **工具级提交** | 每次会改文件的工具结果写入 `toolcall-<n>-<callId>`，快照链可审计。 |
| **文件级还原** | 还原被改文件、删除该轮新建的文件、**永不删除**从未被快照跟踪的文件。 |
| **安全** | 回退前存安全快照；检测外部手动改动；扫描被截断时直接拒绝回滚，宁可不滚不误删。 |
| **省磁盘** | 内容寻址目录树，未变目录/文件跨版本共享（实测 2000 文件仓库 25 MiB → 7.4 MiB）。 |
| **自动维护** | `keepTurns` 窗口修剪 + 超过 128 MiB 自动 GC。 |
| **存储可配** | `dataDir` / `DSH_ALL_REWIND_DIR`，支持绝对路径、`~/`、相对 `$DSH_HOME`。 |
| **Agent 友好** | 宿主工具 `rewind_status` / `rewind_list` / `rewind_restore` / `rewind_prune`，另有仅本机可访问的 HTTP API。 |

---

## 环境要求

- 支持插件机制的 DeepSeek Harness（桌面端或 web profile）。
- **只有源码/手动安装方式需要 Node.js 22+**（`node install.mjs`）；走 DSH 插件管理器则不需要本机 Node。
- 无运行时 npm 依赖；Windows / macOS / Linux 均可。

---

## 安装

> 无论用哪种方式，装完都要**重启 DeepSeek Harness**（桌面端在启动时加载插件并收集 UI 注入）。

### 方式 A：DSH 插件管理器 / npm（推荐）

发布到 npm 后：

- **Web profile**（如果你的 DSH 构建提供 CLI）：

  ```bash
  dsh plugin --profile web add dsh-all-rewind
  ```

- **桌面端**：在 DSH 会话里让 Agent 安装插件 `dsh-all-rewind`（它会走插件管理器的
  `install_bundle`），或使用界面里的插件管理入口。
  **不要**在终端里对桌面 profile 执行 `dsh plugin --profile desktop …`——桌面 profile 由应用托管。

### 方式 B：直接从 GitHub 安装（npm 未发布或想用最新 main）

```bash
dsh plugin --profile web add github:ShaoBei47/dsh-all-rewind
```

### 方式 C：从 npm 包手动装进 profile（不想用插件管理器）

```bash
# 1) 把 npm 包下载到临时目录（只下载）
npm install --prefix "%TEMP%\dsh-rewind-pkg" dsh-all-rewind

# 2) 复制进 desktop profile 并注册到 cordis.patch.yml
#    在 clone 下来的仓库目录里执行（需要 Node 22+）
node install.mjs --source "%TEMP%\dsh-rewind-pkg\node_modules\dsh-all-rewind"
```

### 方式 D：本地源码安装（开发 / 离线）

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind

node install.mjs                                       # 装进 desktop profile
node install.mjs --profile web                         # 装进其它 profile
node install.mjs --data-dir E:/dsh-rewind-snapshots    # 快照放另一个盘
node install.mjs --dry-run                             # 只预览要改什么
node install.mjs --uninstall                           # 卸载（移除注册条目 + profile 副本）
```

`install.mjs` 会把运行时文件复制到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-all-rewind`，
并向 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 追加一个受管理的配置块（每次改动都会生成
`cordis.patch.yml.bak-*` 备份），**不会碰你的快照数据**。

**手动安装（等价）**：把本目录复制到 `<DSH_HOME>/profiles/desktop/node_modules/dsh-all-rewind`，
然后在 `<DSH_HOME>/profiles/desktop/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-all-rewind
      name: dsh-all-rewind
      config:
        keepTurns: 20
```

### 验证是否装好

- 聊天里你的提示词下方出现回退小字（见[效果预览](#效果预览)）；
- 宿主日志出现 `dsh-all-rewind ready (dataDir=…)`；
- 让 Agent 调 `rewind_status`，或访问：

  ```bash
  curl http://127.0.0.1:19387/dsh-all-rewind/api/status
  ```

---

## 使用

### 在界面上回退

1. 发一条提示词，让 AI 改文件。
2. 这条提示词下方会出现 `↩ 回退到第 N 轮对话之前`（新轮次约 2.5 秒内出现；切换会话会自动重取）。
3. 悬停可确认这一轮改了什么、快照存在哪。
4. 点击 → 二次确认 → 工作区还原到**该轮对话发起前**。
5. 已打开的编辑器标签请重新打开以刷新内容。

具体规则：

- 该轮修改过的文件 → 从快照还原；
- 该轮新建的文件 → 删除；
- 从未被快照跟踪的文件（你自己后来新建的）→ **不动**；
- 回退前先写 `pre-revert-<时间>` 安全快照，回退后再写 `post-revert-<时间>` 基线，所以回退本身可再回退。

### 让 Agent 帮你回退

| 工具 | 作用 |
| --- | --- |
| `rewind_status` | 快照仓库 / 回滚点 / 存储位置与占用概览 |
| `rewind_list` | 列出当前会话的回滚点（`all: true` 列出全部会话） |
| `rewind_restore` | 执行回滚：`{ target, dryRun?, onConflict?, force? }` |
| `rewind_prune` | 按 `keepTurns` 窗口修剪旧版本 |

可以直接对 Agent 说：

- “列出我的回滚点”
- “回退到第 3 轮之前”
- “先看看回退到第 2 轮会影响哪些文件，不要真的改”（`dryRun: true`）

`target` 支持版本号（推荐）、commit/tree 前缀或标签（如 `before-chat-turn-3`）。

### HTTP API

界面用的就是这套仅本机 API，也可以自己脚本调用。所有端点只接受回环地址
（`localhost` / `127.0.0.0/8` / `::1`），拒绝跨站请求，POST 必须 `Content-Type: application/json`。

```
GET  /dsh-all-rewind/api/status                 # storage.dataDir、diskBytes、会话与回滚点数量
GET  /dsh-all-rewind/api/sessions
GET  /dsh-all-rewind/api/points?sessionId=<id>
POST /dsh-all-rewind/api/revert                 {sessionId, target, dryRun?, onConflict?, force?}
POST /dsh-all-rewind/api/prune                  {sessionId?}
POST /dsh-all-rewind/api/maintenance            {sessionId?, keepVersions?}
GET  /dsh-all-rewind/ui.js
```

示例：

```bash
curl -X POST http://127.0.0.1:19387/dsh-all-rewind/api/revert \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"session-abc","target":12,"dryRun":true}'
```

---

## 配置

配置写在 profile 的 `cordis.patch.yml` 里、`install.mjs` 管理的那段 `dsh-all-rewind` 条目中：

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
| `dataDir` | `$DSH_HOME/dsh-all-rewind` | 快照存储根目录（绝对路径 / `~/` / 相对 `$DSH_HOME`） |
| `keepTurns` | `20` | 保留多少个轮次回滚点；窗口外的旧工具调用版本一并修剪 |
| `autoMaintenance.enabled` | `true` | 是否启用自动维护 |
| `autoMaintenance.thresholdBytes` | `134217728` | 仓库超过该大小触发一次 GC |
| `autoMaintenance.checkEveryTurns` | `3` | 每多少轮检查一次（检查本身很便宜） |
| `autoMaintenance.keepVersions` | `200` | 自动 GC 保留的版本数 |
| `maxFileBytes` | `1048576` | 超过该大小的文件不参与版本化 |
| `maxFiles` | `8000` | 扫描文件数上限；超出会标记截断并**拒绝回滚**（避免误删） |
| `maxTotalBytes` | `268435456` | 扫描总字节上限 |
| `ignoreDirs` | `.git`、`node_modules`、`dist`、`.tmp` 等 | 追加忽略目录名 |
| `ignoreFiles` | `.DS_Store` 等 | 追加忽略文件名 |
| `captureSkipTools` | 只读工具（`read`、`grep`、`web_*` 等） | 不触发快照的工具 |
| `respectSandboxPolicy` | `true` | 只读会话拒绝回滚（`force: true` 可绕过） |
| `onConflict` | `overwrite` | 快照之后被手动改过的文件如何处理：`overwrite`（有安全快照）/ `skip` |
| `http.enabled` | `true` | 是否注册本地 HTTP API / UI 资源路由 |
| `http.requireLocalOrigin` | `true` | 强制回环 Host + 同源 + CSRF 校验 |
| `ui.enabled` | `true` | 是否注入客户端回退入口 |

---

## 快照存在哪

解析优先级：

1. `cordis.patch.yml` 里的 `config.dataDir`；
2. 环境变量 `DSH_ALL_REWIND_DIR`；
3. 默认 `$DSH_HOME/dsh-all-rewind`（Windows 通常是 `C:\Users\<你>\.dsh\dsh-all-rewind`）。

支持绝对路径、`~/…`、以及相对 `$DSH_HOME` 的路径。当前实际位置与占用可在按钮悬停提示、
`rewind_status` 或 `GET /api/status`（`storage.dataDir` / `storage.diskBytes`）查看。

修改 `dataDir` **不会自动迁移**已有快照；需要的话手动移动或删除旧目录。

每个会话的目录结构（`<dataDir>/snapshots/<会话ID>/v2/`）：

```text
objects/<aa>/<rest>          内容寻址的文件 blob 与目录树节点（zlib 压缩，sha256 命名）
base/content/<rel>           最新快照的工作区镜像
disk/content/<rel>           已删除文件的墓碑副本
version_file_<n>.json        每个版本一个很小的元数据文件：根 tree id、变更集、统计
first_graph.json             仓库身份（会话 id + 工作区）
latest_change.json           指向最新版本
```

---

## 工作原理

### 事件 → 快照时序

```text
session/created   → baseline-<时间>                    首次观察工作区
turn/start        → before-chat-turn-<轮次>            ← 界面「回退到第 N 轮之前」的目标点
                    + pruneVersions(keepTurns)          窗口修剪
                    + 必要时自动维护（大小检查）
user/message      → 把该轮用户消息预览挂到刚才的点上
tool/call         → 记住 callId → 工具名
tool/result       → toolcall-<轮次>-<callId>           （只读工具跳过）
回退              → pre-revert-<时间> → 写回文件 → post-revert-<时间>
```

### 还原算法

拿目标版本的文件树、当前磁盘状态、最新快照清单做三路判断：

| 情况 | 动作 |
| --- | --- |
| 目标里有、磁盘缺失 | 从 blob 还原 |
| 目标里有、内容一致 | 跳过 |
| 目标里有、内容不同 | 覆写（若是你手动改的会记为 `conflict`） |
| 目标之后新建的文件 | 删除 |
| 从未被快照跟踪的文件 | **不动** |
| 工作区扫描被截断 | 拒绝回滚 |

### 设计取舍

- **不依赖 git**：每个会话一个隐藏快照仓库，保持 TRAE 的目录布局与锚点命名，但对象库是自己实现的内容寻址存储：
  blob 按 sha256 命名并 zlib 压缩；目录树是内容寻址的 JSON（`{"f":{文件→blob},"d":{目录→子树 id}}`），
  未变子树跨版本共享——与 git tree 机制一致。这样在禁止 spawn 子进程的受限宿主机、以及没装 git 的机器上也能用。
- **回退直接写盘**（二进制安全），并自带安全快照，误回退可再回退。

---

## 磁盘占用

同一套合成负载实测（`v0.1` 每版内嵌全量清单 → 现在的共享树清单 + 窗口修剪）：

| 场景 | 工作区 | v0.1 快照目录 | **当前快照目录** |
| --- | --- | --- | --- |
| 400 文件 / 30 轮（61 版本） | 1.3 MiB | 6.8 MiB | **1.6 MiB**（元数据 65 KiB） |
| 2000 文件 / 20 轮（41 版本） | 6.4 MiB | 25.0 MiB | **7.4 MiB**（元数据 104 KiB） |

剩余固定成本是 `base/content` 镜像（≈ 1× 被跟踪源码）加上确实改过的文件内容。自动维护 + `keepTurns`
让长会话的占用保持有界。

---

## 已知限制

- **只还原文件，不截断对话**：和 TRAE 的按钮行为一致，聊天记录保留。
- **只有插件运行期间捕获的轮次**才有回退入口；安装前的旧轮次、或被 `keepTurns` 修剪掉的轮次不会出现。
- **共享工作区**：并行会话/子代理改同一目录时各自快照独立；回滚其中一个会话会写回它的文件状态，可能覆盖另一个的并发修改。
- **大文件与忽略目录不参与版本化**（`maxFileBytes`、`ignoreDirs`），回滚也不会动它们。
- **只读会话**默认拒绝回滚（可传 `force: true`）。
- 修改 `dataDir` 不会迁移旧快照。

---

## 常见问题

**提示词下方没有回退小字？**

1. 安装后是否**重启**了 DeepSeek Harness？插件与 UI 都在启动时加载。
2. 让 Agent 调 `rewind_status`（或访问 `/dsh-all-rewind/api/status`），确认插件版本与存储路径正常。
3. 打开 DevTools 控制台执行 `__dshAllRewind`：`undefined` 说明客户端脚本没被注入；
   `__dshAllRewind.state` 可看识别到的会话与回滚点，`__dshAllRewind.reconcile()` 可手动重扫页面。
4. 如果是通过 DSH 插件管理器安装的，确认该 bundle 在当前 profile 已启用。

**某条较早的提示词没有回退入口？**

那一轮没有快照：插件是之后才启动的，或该版本已被 `keepTurns` 修剪。把这个值调大、重启后新轮次会保留更多历史。

**回退结果里有“跳过”的文件？**

这些文件在快照之后被 AI 回合之外的操作改了。默认策略是 `overwrite`（有安全快照兜底）；
想永远保留手改内容可设为 `onConflict: "skip"`。

**磁盘占用高了怎么办？**

用 `rewind_status`（或按钮悬停提示）看当前大小；可以调小 `keepTurns`、补充 `ignoreDirs`，
或调用 `POST /api/maintenance`（或 `rewind_prune`）立即修剪并 GC。

**桌面端用 CLI 装不了？**

桌面 profile 由应用托管。请用方式 A（让 Agent / 插件界面安装）或方式 C/D（手动/源码安装）；
只有 web profile 支持 `dsh plugin --profile web add …`。

---

## 开发与测试

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind

npm test          # node --test test/（Node 22+，会为每个测试文件起子进程）
npm run test:all  # 单进程跑全部测试（受限沙箱里用这个）
npm run smoke     # 不依赖 DSH 宿主的端到端冒烟测试
```

| 目录 / 文件 | 作用 |
| --- | --- |
| `lib/index.js` | Cordis 插件入口：事件监听、工具、路由、UI 注入 |
| `lib/manager.js` | 会话 → 快照仓库映射、轮次追踪、自动维护 |
| `lib/store.js` | 快照 capture / restore / prune / GC |
| `lib/tree.js` | 内容寻址目录树（跨版本结构共享） |
| `lib/objects.js` | 内容寻址 blob 存储（zlib + sha256） |
| `lib/workspace.js` | 工作区扫描、清单 diff、还原计划 |
| `lib/http.js` | 本地 HTTP API（Host/CSRF 校验） |
| `assets/ui.js` | 每条提示词下方的回退入口 |
| `install.mjs` | profile 安装/卸载、`--source`、`--data-dir` |
| `test/` | 单元 / 集成 / 客户端 DOM / 安装器 / Loader / 冒烟测试 |

`test/real-cordis.test.js` 与 `test/loader.test.js` 在能拿到真实 Cordis 构建时会真正加载插件
（可用 `DSH_CORDIS_PATH` 指定），否则自动 skip。

---

## 发布（维护者）

```bash
npm login
npm publish                 # publishConfig.access 已是 public；prepublishOnly 会先跑测试

# 或走 CI 发布：
git tag v0.3.0 && git push origin v0.3.0   # 仓库 Secrets 里配置 NPM_TOKEN
```

发版前：改 `package.json` 的 `version`、更新 `CHANGELOG.md`、跑 `npm test`；
`npm pack --dry-run` 应只包含运行时文件（`lib/`、`assets/`、清单、安装器、文档）。

如果改了 GitHub 账号/仓库名，记得同步更新 `package.json` 的 `repository` / `homepage` / `bugs`、
两个 README 的徽章与安装命令。

---

## License

[MIT](LICENSE)
