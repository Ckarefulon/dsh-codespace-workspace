# dsh-codespace-workspace

把 **GitHub Codespace 直接当作一个 DSH 工作区**使用。本地 DSH 连接云端
Codespace，Agent 在 Codespace 里读写文件、执行命令。

这不是一个通用的 SSH 远程连接插件：Codespace 就是工作区本身。它不往 DSH 的
SSH 主机列表里塞任何东西，因此不会和其他云工作区插件冲突。

```
┌─────────────── 本地 DSH ───────────────┐        ┌────── GitHub Codespace ──────┐
│  侧边栏工作区行（云朵图标）              │        │                              │
│    ▶️ / ⏸️ / 🕐  ← 启停 + 自动暂停倒计时 │  SSH   │  /workspaces/<repo>          │
│                                        │ ─────► │    read / write / edit       │
│  Agent 会话（cwd = 占位目录）           │        │    glob / grep / bash        │
└────────────────────────────────────────┘        └──────────────────────────────┘
```

## 功能

### 设置页：Codespace

在 DSH 设置里新增一栏 **Codespace**：

| 设置项 | 说明 |
|---|---|
| GitHub 用户名 | 用于校验与展示；留空则从 token 读取登录名 |
| 默认分支 | 新建 Codespace 时使用，默认 `main` |
| 自动暂停等待时间（分钟） | 一轮对话结束后开始倒计时，默认 30 |
| SSH 密钥（可选） | 仅保存路径；值永不回显，只显示「已设置 / 未设置」 |
| 始终显示云端工作区按钮 | 开关，默认关；开启后按钮不再跟随 hover 隐藏 |
| 自动初始化空仓库 | 开关，默认开；空仓库先提交一个 README 再建 Codespace |
| README 初始内容 | 可选；留空则创建空 README |

设置通过 DSH 标准设置存储（`Config` + `.volatile()` + settings 服务）持久化，
写在 profile 的 `cordis.patch.yml` 里，不占用 `localStorage`，升级不丢。

### 工作区列表

- 新建云端工作区的按钮放在**工作区分组标题栏的图标行里**，与 DSH 原有的图标
  同地位，紧挨在「添加工作区」的**左边**——不是另做一个独立控件。
- 云端工作区使用**云朵图标**，固定不变，不随 Codespace 状态变化。
- 操作按钮位于**倒数第三个**——在三个点菜单和新建对话按钮之前。
- 显示逻辑跟随宿主默认行为：不 hover 时隐藏；打开「始终显示」后常显。
- 按钮状态：

| 状态 | 图标 | 悬停提示 | 点击 |
|---|---|---|---|
| 已停止 | ▶️ | 启动 Codespace | 启动 |
| 运行中 | ⏸️ | 暂停 Codespace | 暂停 |
| 倒计时中 | 🕐 | 还剩 X 分钟自动暂停 | 取消倒计时 |
| 启动/暂停中 | 转圈 | — | 不可点 |

**双击时钟图标 = 立即暂停。**

工作区 hover 卡片中的「工作区位置」一行改为显示 **Codespace 的名字**。

### 新建云端工作区

只有一个窗口，分步显示，不弹一堆窗：

1. 拉取 GitHub 仓库列表，选择仓库
2. 检查该仓库的 Codespace：多个 → 选择；一个 → 直接用；没有 → 创建
3. 创建前检查 prebuild：没有则窗口内提示「未配置预构建，创建可能较慢」，
   给出 `取消` / `直接创建`
4. 空仓库 → 自动提交一个空 README，然后继续创建
5. 机器规格可选，默认最小
6. 启动失败 → 窗口内报错，可重试

### 生命周期

- **DSH 启动时**：不自动启动任何 Codespace。检查上次遗留的运行中 Codespace 并
  提示用户（带「停止」按钮），但不自动停。
- **退出 DSH 时**：尝试自动关闭所有本插件管理的 Codespace。
- **自动暂停**：一轮对话结束后开始倒计时；倒计时期间用户发新消息 → 取消倒计时，
  等 Agent 干完活重新计时；点时钟 → 取消；双击时钟 → 立即暂停。

### Git

Agent 拥有完整的 `git` 命令执行能力。**插件不干预 Git 操作，不封装 push 逻辑。**
只在创建会话时向系统提示词注入一条规则，告诉 Agent 这是云端 Codespace 工作区、
改动完成后请 `git push` 回仓库——不需要每次提醒。

### 多工作区

每个云端工作区独立控制自己的 Codespace 启停，互不干扰。

### 删除 Codespace

在三个点菜单里，与「删除工作区」**分开**。点击后弹确认框，确认后删除。

## 前置条件

| 依赖 | 必需 | 说明 |
|---|---|---|
| `git` | 是 | Agent 用它 push 回仓库 |
| `ssh` | 是 | 连接 Codespace 的数据通道 |
| `gh`（GitHub CLI） | 推荐 | 用于 `gh codespace ssh`；**未安装时插件仍可用**，改用你在设置里配置的 SSH 别名 |
| GitHub token | 是 | 控制面（REST API）。取值顺序：设置 → `GITHUB_TOKEN` → `gh auth token` |

> **本机现状**：`gh` 未安装，`git` 与 `ssh` 已安装。插件会在设置页明确显示这一
> 状态，并在缺少 `gh` 时回退到 SSH 别名，而不是直接失败。

所需 GitHub 权限范围：`codespace`、`repo`。

## 安装

```powershell
# 1. 克隆到工作区
git clone <this-repo> dsh-codespace-workspace

# 2. 装进当前 profile（只改写 profile 的 package.json dependencies 与 lockfile）
dsh plugin --profile desktop add "link:<绝对路径>\dsh-codespace-workspace"

# 3. 把包名登记进 dsh.profile.bundles，否则不会被挂载
#    编辑 %USERPROFILE%\.dsh\profiles\desktop\package.json
#    在 dsh.profile.bundles 数组里加入 "dsh-codespace-workspace"

# 4. 重启 DSH（插件文件改动不会热生效）
```

`dsh plugin add` 只改 `dependencies` 与 `pnpm-lock.yaml`，**不会**登记
`dsh.profile.bundles`，第 3 步必须手工做。它会报一条 peer dependency 警告
（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 由宿主提供），可以忽略。

装完可以确认插件已被解析并导入。注意 `desktop` profile 由 Electron 应用独占管理，
CLI 对它只允许 `dsh plugin`，跑 `--dump-config-schema` 会报
`profile "desktop" is managed exclusively by the Electron application`。所以要用一个
临时 profile 来验证（下面的 `cscheck` 只是举例，验证完删掉即可）：

```powershell
# 建一个只含 dsh-base 的临时 profile
dsh plugin --profile cscheck add "@deepseek-ai/dsh-base@0.2.0-rc.2"
dsh plugin --profile cscheck add "link:<绝对路径>\dsh-codespace-workspace"
# 手工把 "dsh-codespace-workspace" 加进该 profile 的 dsh.profile.bundles
# 然后 dump：它会真的 import() 每个插件的 main，并用其 Config 生成 JSON Schema
dsh --profile cscheck --dump-config-schema | Select-String dsh-codespace-workspace
```

输出里应出现 `"const":"dsh-codespace-workspace"` 指向一个 `config<N>` 定义，
该定义包含全部 8 个设置字段、正确的默认值、`"volatile":true`，以及
`githubToken` 上的 `"role":"secret"`。这证明模块能加载、`Config` 合法。

确认无误后重启 DSH，设置页就会出现 **Codespace**。

## 架构

```
lib/
  shared.js              Host/Client 之间的冻结契约（动作名、状态映射、脱敏）
  index.js               Host 入口：apply() / Config / inject / 装配
  host/
    github.js            GitHub REST 客户端 + token 解析
    gh.js                gh CLI 探测与调用（缺失时优雅降级）
    codespaces.js        生命周期、机器规格、prebuild、空仓库、自动暂停计时器
    transport.js         远程执行与文件读写（base64，无字符串插值）
    remote-tools.js      为 Codespace 会话注册远程工具（agent.ctx 作用域）
    session.js           agent/created、提示词注入、倒计时、退出停止
    routes.js            RPC 路由
  client.js              浏览器半边：设置页 + DOM 增强（标题栏按钮 / 行 / 菜单）+ 多步窗口
locale/{en,zh}.json      文案
test/
  check.mjs              Node 侧自检（不需要浏览器、token、gh）
  shutdown.mjs           「退出即停」的可靠性自检
  serve.mjs              浏览器自检的静态服务器
  browser/               浏览器自检：index.html + harness.js + react-lite.js
```

### 关键设计决策

1. **占位目录**：Codespace 工作区在 DSH 自己的 registry 里登记为一个真实存在的
   本地目录 `<DSH_HOME>/codespaces/<name>/`（`dsh-workspace` 要求路径存在且可
   `realpath`）。会话 `cwd` 就是这个路径，DSH 的工作区/会话机制原样工作。
2. **按 cwd 路由，不替换全局服务**：任何会话只要 `cwd` 落在占位根目录下，就是
   Codespace 会话。其余会话与其他插件完全不受影响。
3. **按 Agent 注册工具**：在 `agent/created` 时，把远程实现注册到 `agent.ctx`，
   用 `tools.restrict()` 屏蔽本地对应工具。这是 DSH 支持的 per-agent 扩展点。
4. **一行提示词**：只在会话创建时注入一条规则，不做每轮提醒。
5. **退出即停**：退出时停止所有本插件管理的 Codespace。挂点是 `ctx.effect` 的
   cleanup —— `runProfile` 的 dispose 会 await 根 fiber 的 `fiber.dispose()`，而
   cordis 会并发 await 每一个 effect disposer（已核对 `fiber.ts` 的 `_unload`）。
   预算很紧：进程 5 秒后强退，崩溃路径只有 2 秒。因此 `stopAll()` 是幂等的、用
   `Promise.allSettled` 并发发出、单个请求 3.5 秒超时、且**绝不 reject**（reject 的
   disposer 会让 `runProfile` 抛 `AggregateError`）。没有停成功的名字写进
   `pending-stop.json`，下次启动的“残留 Codespace”提示会一并列出。

## 验证

四套自检，都不需要 token、`gh` 或真实 Codespace：

```bash
# Node 侧：包清单、Config 默认值、RPC 动作表与 HTTP 守卫、shell 引用、文案一致性
node test/check.mjs                # 111 项，全通过

# 退出即停：对着真实 CodespaceManager 跑，只把 fetch 换成桩
node test/shutdown.mjs             # 31 项，全通过

# 载体端到端：起真实的 dsh-host-webserver + dsh-client-connection，
# 用真实签名 cookie 走真实 HTTP
node test/e2e.mjs                  # 全通过（找不到已安装的 Harness 时自动 SKIP）

# 浏览器侧：在真实 DOM 里跑真实 bundle，对着宿主 markup/CSS 的忠实副本
node test/serve.mjs                # 然后打开 http://127.0.0.1:19501/
                                   # 107 项，全通过
```

`test/e2e.mjs` 是这套里最有价值的一个：它不驱动桩，而是从已安装的 Harness 里
`import` **真实的** `dsh-host-webserver` 与 `dsh-client-connection`，注册真实的
路由，然后对真实监听的端口发真实 HTTP。它证明的正是桩测不了的三件事：

1. 路由能穿过 DSH 自己的 `/api` 前缀路由到达；
2. **没有会话 cookie 的请求被 harness 拒掉（401）**——即路由没有遮住 fence 和鉴权；
3. 用真实 launch-token 换来的**真实签名 cookie** 能打通，拿到 `{ok:true}`。

它还**当场演示了影子风险**以证明自己有牙齿：故意在同路径注册一个 `webServer`
exact 路由，匿名请求立刻从 401 变成 200（绕过了 fence）；撤掉它，401 回来。
所以「匿名必须是 401」这句断言对载体是敏感的——这正是之前那版实现栽的地方。

`test/shutdown.mjs` 覆盖的是「退出即停」这条最重要的可靠性要求——一个没停掉的
Codespace 会按小时计费，而用户看不见也补不回来。它断言的是真正要紧的性质：

- 每个受管 Codespace 都被要求停止，而且是**并发**发出（两个 300ms 的停止必须在
  550ms 内跑完，串行会超）。
- 请求失败、连接被拒、**API 收下连接但永不回复**这三种情况下，disposer 都**必须
  resolve**。reject 的 disposer 会让 `runProfile` 抛 `AggregateError`——那就从
  「有一个 Codespace 没停掉」变成「DSH 退不出去」，是更糟的失败模式。
- 最坏情况仍在 5 秒进程预算之内，且不早于单请求的 3.5 秒预算。
- 幂等：teardown 跑第二次不再发任何请求。
- 没停成功的名字会写进 `pending-stop.json`，下次启动的残留提示还能兜住。
- 没有 token 时不去发请求，而是把名字全部记成 pending。

其中「API 永不回复」这一例用的是**真实 socket**（本地起一个只收不回的
`http` server，把真实 `init`——含 signal——转给真实 `fetch`），不是桩。原因值得记：
Node 里 `AbortSignal.timeout()` 的定时器是 **unref'd** 的，一个「返回永不 settle 的
promise」的桩不持有任何 ref'd handle，进程会直接退出而不是触发超时——用桩测这一条
会得到假结果。已单独核实：真实 socket 下 `api()` 在 1215ms 抛 `E_TIMEOUT`。

浏览器侧覆盖的是 Node 里没法验证的部分：真实属性反射、`:hover` 驱动的 CSS、
`MutationObserver` 合并、portal 到 `document.body` 的菜单。它实际抓到过两个 bug：

- **时钟双击失效**：倒计时行上，第一次点击会立刻发出「取消倒计时」（这是刻意的，
  因为那里双击没有别的含义），于是剩余时间归零；而 `dblclick` 的处理里原本用
  「剩余时间 > 0」做守卫，结果第二次点击被静默丢弃——需求里的「双击时钟 = 立即暂停」
  从来没生效过。守卫已改为判断**状态**而不是剩余时间。
- **运行中单击不生效**：`beginClickWindow` 只清了计时器并重绘，从来没有真正发出
  被延后的那个动作，所以运行中的行单击一次什么都不会发生。现在窗口关闭时会按
  **当前**记录重新推导动作（轮询可能在这期间落地），并丢弃已经进入 busy 的记录。

另外它抓到过一个真实的时序问题：`alwaysShowCloudButton` 原本只在设置页挂载时才
读取，因此全新启动时行增强读到的是 `null`，开关实际上不生效。现在由行增强模块
自己在拿到 owner claim 时读一次设置。

### 真机（真实 GUI）上抓到的两个 bug

这两个都不是桩能测出来的，必须对着跑起来的 DSH 才暴露；而且第一个的成因是
**我自己的测试把 bug 写进了断言里**，所以它一直是绿的。

**一、`状态读取失败：Requests must be same-origin.`**

设置页的「状态」卡片一直红着，`GitHub CLI (gh)` 卡在「检查中…」。原因是 RPC
路由上那道**自己手写的** Host/Origin fence 要求请求必须带 `Origin`，而桌面外壳
的载体**两者都不带**（`Origin` 和 Fetch-Metadata 都没有），于是每一发都被 403。
Web GUI 反而正常，因为浏览器会发 `Origin`——这就是它看起来「只坏一半」的原因。

修法不是放宽自己那套，而是**逐字对齐 harness 自己的 `isTrustedApiRequest`**：它
的第一条就是 `if (origin === void 0) return true`。承重的检查是 **Host**，因为
`Host` 是 DNS rebinding 唯一伪造不了的头；`Origin` 与 `Sec-Fetch-Site` 只是补充。
另外 `isLoopbackHostname` 接受 `localhost`、`[::1]` 和**整个 127/8**，不只是
`127.0.0.1`。

对着跑着的宿主复现过（旧代码）：不带 `Origin` → 403，带上匹配的 `Origin` → 200。

**二、我自己的路由遮住了 harness 的鉴权（安全相关）**

修好 fence 之后顺手量了一下，发现更值得修的一处：路由原本注册成 `webServer` 的
**exact** 路由，而 webserver 的 `match()` 是**先查 exact 表、再查前缀表**，所以它
比 DSH 自己的 `/api` **前缀**路由先命中，直接把 `/api` 那条路整个遮掉了——而
fence 和浏览器鉴权（cookie）都挂在 `/api` 那条路上。实测（旧代码）：

```
POST /api/dsh-codespace-workspace/rpc   （无 cookie，Origin 匹配）-> 200
POST /api/no-such-plugin-xyz            （无 cookie，Origin 匹配）-> 401 unauthorized
```

第二行是 DSH 在拒绝未鉴权调用；第一行说明我们的 exact 路由绕过了它。

正确做法是注册到 `connection.fetch`：DSH 自己的 `/api` 前缀路由会先 `admit(req)`
（Host/Origin fence **加上** cookie 鉴权），再 `bridge()` 派发到插件注册的 Fetch
路由。这样等于白拿 harness 的安全策略，浏览器和桌面外壳还都能用。exact 路由现在
只作为「composition 里根本没有 `connection` 服务」时的兜底保留。

两个细节值得记：

- `connection` 不在本模块的 `inject` 里，直接读 `ready.connection` 会被 cordis
  门禁拦下（`cannot get property ... without inject`）。要用 `ctx.get(name, false)`
  ——cordis 文档里写明的「不经 inject 读取服务」的公开入口。
- 服务加载顺序没有保证，所以载体选择**不能是一次性判断**。`ready.inject(['connection'], ...)`
  是公开的触发点（已实测：服务晚到时它会触发，永不出现时保持沉默且不抛），
  于是晚到的 `connection` 会把兜底路由换掉，而不是让进程一直停在较弱的载体上。

## 已知限制

- **工作区分组标题栏的图标行、以及工作区行，都没有官方插槽**。DSH 把「添加工作区」
  按钮和 `ProjectRowItem` 的操作按钮、文件夹图标全部写死，因此以下四处通过 DOM 增强
  实现（与 `dsh-pet` 处理设置导航图标同一手法）：标题栏里的新建按钮、行首云朵图标、
  行内启停按钮、hover 文案（外加菜单里的「删除 Codespace…」）。做法是只注入、不删除
  React 拥有的节点，全部打上 `data-dsh-codespace-*` 标记，一个合并的
  `MutationObserver`，dispose 时完整撤销。宿主改版可能影响它。已核对：客户端运行时的
  插槽目录共 90 个，其中有 `sidebar.workspaces.session.menu.item`，但**没有**工作区行
  的菜单插槽，也没有标题栏图标行的插槽；`sidebar.footer.action` 是真实存在的插槽，
  但它把控件放在侧边栏底部，不符合「与原有三个图标同地位、紧挨添加工作区左侧」的要求。
  标题栏的 `_sectionHeader` / `_headerActions` 两个类名后缀经核对为
  `dsh-client-ui-workspace` 独有，不会误匹配。
- 标题栏图标行是 `justify-content:flex-end` + `max-width:60px`（正好放下三个 16px
  图标）。加进第四个控件需要放宽容器宽度，但放宽规则带了
  `:not([class*="_headerActionsHidden"])`，以免盖掉宿主自己在展开搜索框时的收起行为。
  另外「添加工作区」按钮只在目录流插槽被占用时才渲染，所以插入位置是「最后一个子元素
  之前」而不是固定下标。
- 远程工具以文本方式传输文件（base64），大文件不适合；大仓库建议让 Agent 在
  Codespace 内直接操作。
- `gh` 缺失时依赖用户自行配置 SSH 别名。设置项名为「SSH 密钥」，但**私钥路径无法
  指定主机**，所以该值被当作 `~/.ssh/config` 的主机别名使用；填成路径会得到一条
  说明如何修正的错误，而不是把路径当主机名交给 `ssh`。
- 未在本机实测的部分：GitHub REST 与 `gh` 的真实响应（本机没装 `gh`、无 token），
  以及真实 SSH 数据面（没有已配置的 Codespace 目标）。命令拼装本身已用真实 bash
  验证：20 组逐字节往返 + 5 组注入载荷，均保持为单个 shell 词且无副作用。

  **「退出即停」不在此列**：它的逻辑已按上面的 `test/shutdown.mjs` 实测（并发、
  不 reject、5 秒预算内、幂等、pending 落盘）。仍然未经实测的只有「真实 GitHub
  是否接受这次 stop 调用」这一层——那取决于 token 与账号，不取决于本插件的逻辑。
  另外「宿主在退出时确实会 await 根 effect 的 disposer」这一条是**读 DSH 源码**
  核实的（`runProfile` 的 `dispose` → `fiber.dispose()` → cordis `_unload` 并发
  await 每个 disposer），不是在本机跑一次退出观察到的；本机没有可复现的 Codespace
  目标，无法做端到端退出观察。

## 文档

- [`docs/CONTRACT.md`](docs/CONTRACT.md) —— 实现契约：经过核实的 DSH API 事实、
  冻结的 RPC 契约、模块接口、以及每条未经核实项的处理分支。

## 许可

MIT
