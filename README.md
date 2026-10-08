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
  e2e.mjs                载体端到端：真实 webserver + 真实 connection + 真实签名 cookie
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

四套离线自检（不需要 token、`gh` 或真实 Codespace），加一套需要令牌的联网自检：

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
                                   # 136 项，全通过

# 联网：用 gh 的令牌打真实 GitHub API（无令牌时自动 SKIP）
node test/live.mjs
```

`test/live.mjs` 是唯一会碰网络的一套，它存在的理由很具体：离线套件看不见本机那个
**TLS 拦截**故障——中间人根证书只在 Windows 系统信任库里，Node 的 `fetch` 只信自带
CA 包，于是所有 GitHub API 调用都变成 `TypeError: fetch failed`，而 `gh` 走 Go 读系统
库完全正常。这套测试先量出「直连能不能用」，再断言控制面**两条路都通**，这样回退路径
真的被走到时才算数。

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

**三、`仓库读取失败：cannot reach the GitHub API (TypeError)`**

`gh` 装好、状态卡全绿之后，仓库列表依然读不出来。原因是**本机有 TLS 拦截**：中间人
根证书只装在 Windows 系统信任库里，而 Node 的 `fetch` 只信**自带**的 CA 包，于是每次
调用都失败——真正的成因藏在 `error.cause.code = UNABLE_TO_VERIFY_LEAF_SIGNATURE`，
而旧代码只把 `error.name` 写进消息，于是用户看到的是一个毫无信息量的 `TypeError`。
`gh` 用 Go 读系统库，同一个请求完全正常，这才造成「令牌来自 gh auth token 却调不通
API」这种一半好的假象。

修法是给控制面加一条**进程内**的回退：`tls.getCACertificates('system')` 取到系统信任库
（本机 225 个证书），失败的那一发改走 `node:https` 请求并带上 `ca`，结果包成真的
`Response`，所以下游的 `status`/`headers.get`/`text()` 全都不用改。**没有**用
`tls.setDefaultCACertificates()`——那会让本插件偷偷放宽整个 host 进程的 TLS 信任，影响到
别的插件；改动留在自己的传输层里。错误消息也改成报 `cause` 的 code，不再是 `TypeError`。

另有 `NODE_OPTIONS=--use-system-ca` 可用（一次修好所有 Node 代码），但它要改环境变量并
重启 DSH，所以只作为备选写在这里。

**四、启动图标的样式和旁边的按钮不一样**

需求里那句「样式要和其他的等价」原来没做到：我的按钮做成了 **16×16**、`radius-xs`、
hover 只变色，而标题栏真正用的 `_9lTDKa_iconButton` 是 **28×28**、`radius-sm`、
`--dsw-alias-label-secondary`，**hover 出现背景**而不是变色。图标本身也偏重：我写了
`stroke-width="1.3"`（那是宿主 `Medium` 档）**并且写在 path 上**，而旁边的加号是
`IconProjectAddOutlineRegular`，即 **1**，且按 primitives 的规范 `stroke-width` 应该放在
`<svg>` 上。

我一开始把 16×16 当成对的，是因为把 `Rows` 模块的 `hIlkoa_iconButton`（工作区行的按钮，
确实是 16×16）错当成了标题栏的类——**浏览器 harness 的夹具也照抄了这个错值**，于是
「launcher 和其它按钮一样大」这条断言一直是绿的。夹具已按真实 CSS 改正，并补上几何、
圆角、颜色、hover 背景、描边宽度、rail 下字形 18px 的断言（浏览器侧从 107 项涨到 114 项）。
云朵路径同时抽成一个常量，React 与 DOM 两条渲染路径共用，避免再次漂移。

**五、图标会「有时候」跑到「新建工作区」按钮的右边**

听起来像时序问题，其实是**确定性**的，只是触发条件不明显：**只有宿主自己的提示框
正开着时才会发生**。原因是 DSH 的 `Tooltip` 在缺省配置下**不是 portal**（工作区标题栏
没传 `portal`），所以气泡是以**兄弟节点**的形式渲染在**同一个 `headerActions` 容器**里
的。我那段「把按钮插到最后一个子元素之前」的代码于是把按钮插到了气泡前面 —— 也就是
「添加工作区」的右边。

更糟的是它**不能自愈**：一旦插错，按钮的 `nextElementSibling` 正是那段代码要去找的
东西，于是每次重扫都「看起来已经就位」。现在改成**记住锚点元素**、永远贴在它前面，
而不是每轮重新猜「最后一个控件」；选锚点只看标签名（`BUTTON`），不看子节点顺序。
浏览器套件补了两条会真的触发它的回归测试：宿主重渲染追加控件、以及一个开着的提示框
气泡。另外我自己那个提示框**挂到 `document.body`**，从根上不再进这个容器。

**六、`typeof` 一个未声明的名字让提示框静默失效**

改提示框时踩了个安静的坑：`attachTooltip` 是模块作用域的函数，而 `doc` 是
`installRowAugmentation` 的**局部变量**。我写了 `typeof doc === 'undefined'` 当守卫 ——
但 `typeof` 对**未声明的标识符**返回 `'undefined'` **而不抛错**，于是这个函数每次都直接
返回空操作：**没有报错、console 干净、看起来一切正常，只是提示框永远不出现**。

现在改成在函数内部解析 `document`（那是真实全局）。这条也写进了记忆：客户端 bundle 里
绝不要用 `typeof someUndeclaredName` 当守卫。

**七、图标补上了右上角的加号，云朵保持原尺寸、只在交叉处断开**

「新建云端工作区」的图标原本是一个单独的云朵，而它旁边宿主自己的按钮是
`IconProjectAddOutlineRegular`（文件夹 + 加号）。现在这个图标是**云朵 + 加号**：加号
**逐字抄**宿主那两条 path。

第一版我把云朵**缩小**塞到左下角、给加号让位。那不对 —— 宿主的做法是主体**保持原尺寸**，
只把轮廓在加号穿过的地方**断开**（它的文件夹就是满尺寸，右上角被切开让加号坐进去）。
现在照这个做：云朵用**未修改的原 path**，套一个 SVG `<mask>`，mask 里先把 16×16 的白底
铺满，再用 `stroke-width:2.6` 的**黑线**沿着加号两条笔画走一遍 —— 于是云朵轮廓在加号
经过的那一段被擦掉，云朵本身的尺寸一点没变。

几个具体取舍：

- 用 mask 而不是手算断点。这条轮廓与加号实际有**两处**相交（竖笔切右瓣于 y≈6.706，横笔
  的**描边带**还会蹭到大弧 x≈9.76 附近），手写子路径就得把这两组交点算准并永久跟着
  path 同步；mask 直接表达「绕开加号」这个意图，不会漂移。
- 裁切笔画用 `stroke-linecap="butt"`：圆头会多伸出半个带宽，在瓣的下端可能咬下一小块
  孤立的碎线。
- 每个图标一个独立 mask id（`maskUnits="userSpaceOnUse"`）。id 是全文档唯一的，两个
  图标共用会让 `url(#id)` 解析到第一个，静默用错 mask。

校验上补了一条**栅格化对照**：克隆同一个图标、只摘掉 cloud path 上的 `mask` 属性，
两张都画到 canvas 上逐像素比对 —— 差值就是被 mask 擦掉的那部分墨。这一点很重要，因为
**结构断言证明不了 mask 真的擦掉了东西**：mask 颜色写错、`maskUnits` 漏了、id 撞了，
都照样渲染成一朵完整的云。我前两版采样框写法都不稳（按「列」判空会被弧线在别的高度上
的墨抵消；按固定矩形采样则会被抗锯齿边缘的零星像素和加号自身的墨干扰），最后换成这种
不依赖几何假设的做法。

**八、hover 提示框换成 DSH 那种**

原来用的是原生 `title`，画出来是操作系统的气泡，和旁边宿主控件的完全不是一回事。现在
照抄宿主 Tooltip 的**渲染结果**：`position:fixed`、真实的 tooltip 设计令牌、
`role="tooltip"`、500ms 悬停延迟（宿主 `delayMs: 500`），并挂在 `document.body` 上。
CSS 全部只引用 `--dsw-alias-tooltip-bg` / `--dsw-static-neutral-bluish-00` 这些主题
变量，不硬编码任何颜色值。

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
- 标题栏图标行是 `justify-content:flex-end` + `max-width:60px`，而标题栏的控件是
  **28×28**（`_9lTDKa_iconButton`），所以 60px 正好放**两个**（28+4+28）。加进第三个
  控件需要放宽容器宽度，放宽规则带了 `:not([class*="_headerActionsHidden"])`，以免盖掉
  宿主自己在展开搜索框时的收起行为。**注意别把 `Rows` 模块的 `hIlkoa_iconButton`
  （16×16，工作区行的按钮）当成标题栏的类**——两者同后缀不同模块，混淆过一次，见上文
  「四」。另外「添加工作区」按钮只在目录流插槽被占用时才渲染，所以插入位置是「最后一个
  子元素之前」而不是固定下标。窄栏（rail）下宿主把盒子放大到 36px、字形放大到 18px。
- 远程工具以文本方式传输文件（base64），大文件不适合；大仓库建议让 Agent 在
  Codespace 内直接操作。
- `gh` 缺失时依赖用户自行配置 SSH 别名。设置项名为「SSH 密钥」，但**私钥路径无法
  指定主机**，所以该值被当作 `~/.ssh/config` 的主机别名使用；填成路径会得到一条
  说明如何修正的错误，而不是把路径当主机名交给 `ssh`。
- 未在本机实测的部分：**真实 SSH 数据面**（没有已配置的 Codespace 目标），以及
  Codespace 的创建/启停/删除这些会改云端状态的调用。控制面本身已联网实测：
  `test/live.mjs` 用 `gh` 的令牌打真实 GitHub API，`getViewer` / `listRepos` /
  `listCodespaces` 都通（本机 18 个仓库、0 个 Codespace）。命令拼装也已用真实 bash
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
