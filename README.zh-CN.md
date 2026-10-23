# dsh-all-rewind

[![CI](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-all-rewind.svg)](https://www.npmjs.com/package/dsh-all-rewind)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

中文 · **[English](README.md)**

给 [DeepSeek Harness](https://harness.deepseek.com)（DSH）用的 TRAE 风格**回退（Rewind）**插件。

每一轮对话开始、AI 动手之前，插件会把整个工作区快照进一个**影子 git 仓库**；
你的每条提示词下面会出现一个小按钮 `↩ 回退到第 N 轮对话之前`。点一下并确认，
**工作区文件**和**对话**会一起回退到那一轮之前 —— 你点的那一轮以及它之后的内容都不再显示。

影子仓库放在工作区之外（默认 `~/.dsh/dsh-all-rewind`，可配置），一轮一个 commit：
没变的文件只存一份，后续版本在 `git gc` 时做增量压缩。**你自己的 git 仓库完全不会被改动**
（index、objects、refs、工作树都保持原样）。

```text
┌─────────────────────────────────────────────────────────────┐
│  你：把登录按钮改成蓝色，并移除旧的 API 调用                 │
└─────────────────────────────────────────────────────────────┘
                        ↩ 回退到第 12 轮对话之前
```

---

## 特性

- **对话与文件一起回退（就地）**：文件恢复到该轮开始前的状态，对话在**同一个会话内**被截断——
  被回退的这轮及之后的消息从聊天和模型历史中消失，不会新开对话、不分叉。截断复用 DSH 自带的
  压缩（compaction）机制：追加一条空的 `system/message` surface replace；被回退的提示词会回填到
  输入框，可直接修改重发。
- **占用小**：每个工作区一个真正的 git 对象库，一轮一个 commit；只写入变化的内容，
  相似版本由 `git gc` 做 delta 压缩。
- **不碰你的仓库**：影子的 `GIT_DIR` 在插件数据目录里，工作区只是 `--work-tree`。
- **遵守忽略规则**：工作区 `.gitignore` 以及默认的 `node_modules/`、`dist/`、`build/`、`.venv/`
  等重目录不会被快照。
- **回退可撤销**：恢复文件前会先把当前状态做成安全快照，退过头也能找回来。
- **容量可控**：每个会话只列出最近 `keepTurns` 个回退点；仓库超过阈值后自动 `git gc`。
- **工作区不是 git 仓库也能用**：影子仓库由插件自己创建。
- **同一工作区共用一个仓库**：多个会话切换不会重复占空间。

---

## 环境要求与权限

### 必须的依赖

| 要求 | 说明 |
| --- | --- |
| DSH 桌面版（或 `dsh web`） | 在 DSH 0.2.0-rc.2 上验证。回退按钮注入在聊天界面里；宿主需要暴露 `sessions`、`sessionQuery`、`sandboxPolicy` 服务以及 `agent/request` 事件（所有交互式 web/桌面组合都有）。 |
| **DSH 进程能找到 Git 2.13+** | 插件会执行 `git add` / `git write-tree` / `git read-tree`（以及维护用的 `git gc`）。普通安装的 Git 即可，不需要 git 账号、不需要联网。Windows 上先装 [Git for Windows](https://git-scm.com/downloads) 再**重启 DSH**，让进程重新读取 PATH。 |
| Node.js 22+ | 仅源码手动安装和跑测试时需要；已打包的插件本身不额外依赖 Node。 |
| 可写的数据目录 | 默认 `$DSH_HOME/dsh-all-rewind`（`C:\Users\<你>\.dsh\dsh-all-rewind`），可用 `dataDir` 改到别的盘；必须是你的用户可写的目录，不需要管理员权限。 |
| 工作区写权限 | 回退会往工作区写文件，因此当前工作区不能是只读的。 |

如果 `git` 不在 PATH 里，在配置里写完整路径（绝对路径、用正斜杠）：

```yaml
- id: dsh-all-rewind
  config:
    gitExecutable: "C:/Program Files/Git/cmd/git.exe"
```

`rewind_status`（或按钮悬停提示）会报告插件实际找到的 git 版本；低于 2.13 通常也能跑，但不受支持。

### DSH 权限设置

插件运行在 DSH 的 **host 进程**里（不是 Agent 沙箱内），所以它自己写文件不需要逐次工具审批。真正需要注意的是两个宿主侧设置：

| 设置 | 要求值 | 原因 |
| --- | --- | --- |
| **会话权限预设** | 允许**写工作区**（如默认 / `workspace-write`）。**只读（read-only）会话会被拒绝**并返回 `READ_ONLY_SESSION`。 | 恢复轮次时用 `git read-tree` 重写工作区文件。 |
| **工作区位置** | 普通本地目录，且你的用户可读写。UNC 路径、网络共享、其他账号拥有的目录只有在 git 和你的用户都能访问时才可用。 | 影子 git 仓库把这个目录当作 work tree。 |

不需要 DSH 全局权限、开发者模式、管理员权限或网络访问。插件的本地 HTTP API 只通过 DSH 自带的环回 web 服务器暴露（强制 loopback Host 与同源请求）。

另外：插件会**屏蔽宿主机的全局/system git 配置**（设置 `GIT_CONFIG_NOSYSTEM`、空的 `GIT_CONFIG_GLOBAL`）并中和 LFS 等 filter，所以快照按字节存储，不受你本机 git 配置影响，也不需要配置签名。

### 插件读写了什么

- **读取**：工作区文件（遵守 `.gitignore` 和排除列表）、当前会话的事件流（用用户提示词生成回退点标签）。
- **写入**：`dataDir` 下的影子 git 仓库；回退时的工作区文件；应用对话截断时向当前会话日志追加一条空的 `system/message`；Web 客户端 `localStorage` 里的一个折叠标记。
- **绝不触碰**：你自己的 `.git` 目录/index/refs、工作区以外的文件、其他会话的日志、网络。

---

## 安装

### 方式一：插件管理器 / npm（推荐）

```bash
dsh plugin --profile desktop add dsh-all-rewind
```

然后重启 DeepSeek Harness。桌面版的插件管理器页面也可以直接从 npm 安装。

### 方式二：本仓库

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind
node install.mjs                                # 复制进 desktop profile 并写入 cordis.patch.yml
node install.mjs --data-dir D:/my-rewind-repo   # 可选：自定义存储位置
```

安装脚本会替换自己写入的配置块（不会重复添加），并清理 0.3.x 及更早版本留下的
`dsh-trae-rewind` 条目。

### 方式三：手动安装

把本包复制到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-all-rewind`，并在该 profile 的
`cordis.patch.yml` 里追加：

```yaml
- insert:
    - id: dsh-all-rewind
      name: dsh-all-rewind
      config:
        keepTurns: 20
```

之后重启 DeepSeek Harness。

### 验证安装

- 把鼠标悬停在聊天里的回退按钮上：提示里会显示存储目录和 git 版本。
- 或让 Agent 调用 `rewind_status`，正常结果里应有 `"backend": "shadow-git"` 和
  `"git": { "available": true, ... }`。

### 升级 / 卸载

```bash
node install.mjs               # 更新 checkout 后重新执行
node install.mjs --uninstall   # 移除 profile 条目和复制过去的包
```

`dataDir` 下的快照数据不会被删除；不需要时自行删除即可。

---

## 快速开始

1. 打开一个工作区，发一条提示词，等这一轮结束。
2. 你的提示词下方会出现 `↩ 回退到第 N 轮对话之前`。
3. 点击并确认：
   - 工作区文件恢复到这一轮开始前；
   - 聊天从这条提示词开始折叠，提示词被回填到输入框；模型历史会在你发送下一条消息时被正式截断。
4. 在回退后的位置修改并重新发送；你离开时的文件状态作为安全快照留在影子仓库里。

> 回退到**第一轮**：文件恢复到对话开始前，并截断整段对话；重新发送提示词即可重新开始。

---

## 工作原理

1. **每轮一个锚点**：`turn/start` 时把工作区记录进影子仓库 —— `git add --all` 到私有 index、
   `git write-tree`、`git commit-tree`、更新 `refs/heads/main`。`tools/pre-execute` 会拦住本轮
   第一个工具调用，等这个 commit 完成，确保文件不可能在基线之前被修改。提交号和会话日志的
   事件序号一起写进该工作区的 `state.json`。
2. **文件：硬恢复**：回退时先把当前状态提交为安全快照，再执行
   `git read-tree -u --reset <锚点>`（`--work-tree` 指向你的工作区）。锚点里有的文件被恢复，
   锚点之后新建的文件被删除，被忽略的文件完全不碰；你自己的 `.git` 不会被读取或写入。
3. **对话：就地 surface 截断**：DSH 只允许在打开的 turn/step 内追加 `system/message`，所以点击时
   先记录一个**待执行的截断点**（目标轮的 `turn/start` 序号）。客户端立即把该提示词及之后的消息
   折叠隐藏，并把原提示词回填到输入框。下一次模型请求时，插件的 `agent/request` 钩子追加一条空的
   `system/message`，其 `surfaceOp.replace` 覆盖截断点及之后的全部 surface 节点 —— 与 DSH 官方
   compaction 完全相同的机制 —— 聊天记录和模型历史同时失去这部分内容。
4. **不分叉、不复制**：会话 id、标题、日志都保持不变；撤销所需的信息（文件安全快照）留在影子仓库里。

### 存储结构

```
<dataDir>/
  .git/empty-gitconfig            # 隔离宿主机全局 git 配置，避免影响快照
  shadows/
    <workspace-key>/
      repo.git/                   # 私有 git 目录：objects / refs / index
      state.json                  # 回退锚点（commit + 日志序号）和会话元数据
```

- `dataDir` 默认是 `$DSH_HOME/dsh-all-rewind`（Windows 下通常是
  `C:\Users\<你>\.dsh\dsh-all-rewind`）。
- `<workspace-key>` 由工作区绝对路径推导，所以同一目录下的所有会话共用一个仓库。
- 可用 `config.dataDir`、环境变量 `DSH_ALL_REWIND_DIR` 或
  `node install.mjs --data-dir <路径>` 改位置（`config.dataDir` 优先）。改位置**不会**搬移旧快照，
  想保留历史请手动移动整个目录。

### 磁盘占用

每轮一次 `git add` + 一个 commit：没变的内容指向同一个 object；仓库超过
`autoMaintenance.thresholdBytes` 后自动 `git gc`，把相似版本打成增量。普通项目每轮只改几个文件，
通常只占几 MB；由于排除了 `node_modules/`、`dist/` 等目录，第一个 commit 也很小。

---

## 配置

以下字段全部可选，写在 profile `cordis.patch.yml` 的插件条目下：

```yaml
- insert:
    - id: dsh-all-rewind
      name: dsh-all-rewind
      config:
        dataDir: D:/dsh-rewind-repo       # 存储根目录（默认 $DSH_HOME/dsh-all-rewind）
        gitExecutable: git                # git 可执行文件（不在 PATH 时写绝对路径）
        gitTimeoutMs: 120000              # 单条 git 命令超时
        keepTurns: 20                     # 每个会话列出的回退点数量
        conversation:
          enabled: true                   # 同时就地截断对话
        respectSandboxPolicy: true        # 只读会话拒绝文件回退
        autoMaintenance:
          enabled: true
          thresholdBytes: 536870912       # 仓库超过约 512 MiB 时自动 gc
          checkEveryTurns: 5
        ignoreDirs:                       # 追加到默认重目录列表
          - my-large-cache/
        exclude:                          # 原生 gitignore 风格规则
          - "*.dsh-snap"
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/dsh-all-rewind` | 影子仓库根目录；支持绝对路径、`~/...` 或相对 `$DSH_HOME`。 |
| `gitExecutable` | `git` | 要执行的 git 命令。 |
| `gitTimeoutMs` | `120000` | 单条 git 命令超时。 |
| `keepTurns` | `20` | 超出窗口的旧锚点不再列出（git 对象仍然共享）。 |
| `conversation.enabled` | `true` | 是否同时回退对话；`false` 表示只回退文件。 |
| `respectSandboxPolicy` | `true` | 只读会话下拒绝文件回退（除非 force）。 |
| `autoMaintenance.enabled` | `true` | 是否自动 `git gc`。 |
| `autoMaintenance.thresholdBytes` | `536870912` | 超过该大小才自动 gc。 |
| `autoMaintenance.checkEveryTurns` | `5` | 每隔几轮检查一次大小。 |
| `ignoreDirs`、`ignoreFiles`、`exclude` | 内置列表 | 追加到影子仓库的排除规则。 |
| `http.enabled` | `true` | 注入界面使用的本地 HTTP API。 |
| `log` | `true` | 是否把快照/git 失败写进 DSH 日志。 |

---

## 工具

| 工具 | 作用 |
| --- | --- |
| `rewind_status` | git 是否可用、存储位置/大小、工作区、会话、回退点数量。 |
| `rewind_list` | 列出当前会话（或全部会话）的回退点。 |
| `rewind_restore` | 只回退文件到某一轮（或指定 commit）；不动对话。 |
| `rewind_prune` | 删除超出 `keepTurns` 的锚点记录。 |

聊天里的按钮走 HTTP API（`POST /dsh-all-rewind/api/rewind`），两部分一起回退；
工具刻意只动文件，避免 Agent 截断自己的对话。

---

## 从 0.4.x 迁移

0.4.x 在 `<dataDir>/snapshots/` 下按会话存内容寻址快照；0.5.0 改用影子 git。
两者共用同一个 `dataDir` 根目录，但子目录不同。

1. 安装 0.5.0 并重启 DeepSeek Harness。
2. 回退点从**下一轮**开始产生；0.4.x 记录的快照不会转换。
3. `rewind_list`/界面不会显示旧回退点。不需要旧数据的话，直接删除 `<dataDir>/snapshots`
   （默认 `C:\Users\<你>\.dsh\dsh-all-rewind\snapshots`）；留着也不影响使用。

---

## 已知限制

- **同一工作区只有一条时间线**：同一目录下的所有会话共用一个影子仓库。把会话 A 回退到旧锚点，
  会连带撤销会话 B 之后在该目录里做的修改。需要并行开发时请用不同工作区。
- **被忽略的文件不会恢复**：`.gitignore` 或插件排除列表（`node_modules`、`dist` 等）命中的内容
  既不快照也不回退 —— 这是控制体积的代价。
- **对话截断在下一次模型请求时正式生效**：DSH 只允许在打开的 turn/step 内追加 surface 节点，
  所以点击后先做即时视觉折叠，真正的历史截断发生在你发送下一条消息时（输入框已回填被回退的
  提示词）。会话日志只追加不重写：回退是追加事件，不是改写历史。
- **被忽略的文件不会恢复**（见下方存储与忽略规则）。
- **只能回退已完成的轮次**：正在运行的这一轮还没有锚点。
- `git lfs` 过滤器被绕过（`filter.lfs.*` 被中和）；快照按字节存储：不做 CRLF/LF 转换，
  Windows 下不跟踪文件权限位，符号链接在 Windows 下按链接文本记录。
- 工作区过大、超过 `gitTimeoutMs` 时，该轮不会产生锚点（会写日志），其他轮不受影响。

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 看不到回退按钮 | 确认 profile 里已有插件条目、`git` 可用（`rewind_status`），并重启 DeepSeek Harness；只有插件加载后开始的轮次才有锚点。 |
| `CONVERSATION_UNAVAILABLE` | 当前宿主没有 `sessionController`/`workspaceRegistry`（例如 headless 组合）。把 `conversation.enabled` 设为 `false` 即可只回退文件。 |
| `READ_ONLY_SESSION` | 会话是只读权限预设；切换到允许写工作区的预设，或给工具传 `force`。 |
| `NO_POINT` | 该轮没有锚点：可能早于插件安装、超过 `gitTimeoutMs`，或已被 `keepTurns` 清理。 |
| `GIT_UNAVAILABLE` / 完全看不到按钮 | DSH 进程的 PATH 里没有 `git`：安装 Git、重启 DSH，或在配置里设置 `gitExecutable` 绝对路径。`rewind_status` 会显示实际检测到的可执行文件和版本。 |
| git 报 `index.lock`、`Permission denied`、`Access is denied` | 工作区或数据目录被占用/当前用户不可写（杀毒软件、其他进程、管理员拥有的目录）。关闭占用程序、修权限，或把 `dataDir` 指到可写目录。 |
| 第一轮很慢 | 首次快照要写入整个工作区（排除项之外）。用 `ignoreDirs`/`exclude` 排除大的构建/依赖目录；之后的快照都是增量的。 |
| 磁盘持续变大 | 调低 `autoMaintenance.thresholdBytes`，执行 `rewind_prune`，并确认 `node_modules`/构建产物已被排除。 |
| 点了按钮没反应 | 查看 DSH 日志里的 `dsh-all-rewind` 记录；git 失败会带上命令和 stderr。 |

---

## 参与贡献

开发环境、测试矩阵和发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
问题反馈：<https://github.com/ShaoBei47/dsh-all-rewind/issues>

## 许可证

[MIT](LICENSE)
