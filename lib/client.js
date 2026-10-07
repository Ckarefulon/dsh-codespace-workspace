/**
 * dsh-codespace-workspace — client half.
 *
 * Self-contained lazy-CJS bundle: `window.__ModuleLoader__.load({ id, factory })`
 * with a factory that requires only `react`. No build step, no JSX, no
 * TypeScript, and no other DSH package — `@deepseek-ai/dsh-client-ui-primitives`
 * is deliberately NOT required (a throwing import blanks the whole slot entry);
 * the markup and CSS it would have supplied are copied here and styled with
 * `--dsw-alias-*` tokens.
 *
 * Two surfaces, both registered through `ctx.slots`:
 *   1. `settings.section`        — the **Codespace** page (id `dsh-codespace-workspace`, order 70).
 *   2. `shell.overlay`           — the single multi-step create window and the delete confirmation.
 *
 * Plus one DOM augmentation module, because the sidebar's own controls have no
 * slot at all (see docs/CONTRACT.md §2, "no workspace-row slot"). It injects:
 *   - the new-cloud-workspace launcher, as a peer of the host's icons in the
 *     workspace section header, immediately left of 添加工作区;
 *   - the cloud marker and the start/stop button on each managed workspace row;
 *   - the hover card's location line and the row menu's 删除 Codespace… item.
 * It follows the discipline `dsh-pet` uses for the hardcoded settings-nav icon —
 * one coalesced `MutationObserver`, inject only, never remove or replace a
 * React-owned node, tag everything `data-dsh-codespace-*`, undo fully on dispose.
 * The same module holds the store's owner claim, so the 4 s `workspaces` poll
 * lives exactly as long as the workspace section is on screen.
 *
 * Wire contract literals are repeated from `lib/shared.js` (the bundle cannot
 * import it). Keep the two in sync.
 *
 * @module dsh-codespace-workspace/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-codespace-workspace',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------------------------ *
     * 1. Wire contract — mirror of lib/shared.js
     * ------------------------------------------------------------------ */

    /** Package name; also the client module-loader id and the settings namespace. */
    const PLUGIN_ID = 'dsh-codespace-workspace'

    /** Exact host route the browser posts RPC calls to. */
    const RPC_ROUTE = '/api/dsh-codespace-workspace/rpc'

    /** Every RPC action name (mirror of `ACTIONS` in lib/shared.js). */
    const ACTIONS = {
      STATUS: 'status',
      GET_SETTINGS: 'get-settings',
      SET_SETTINGS: 'set-settings',
      LIST_REPOS: 'list-repos',
      LIST_CODESPACES: 'list-codespaces',
      MACHINES: 'machines',
      PREBUILD: 'prebuild',
      CREATE: 'create',
      START: 'start',
      STOP: 'stop',
      REMOVE: 'remove',
      PAUSE_CANCEL: 'pause-cancel',
      PAUSE_NOW: 'pause-now',
      WORKSPACES: 'workspaces',
      CREATE_WORKSPACE: 'create-workspace',
      REMOVE_WORKSPACE: 'remove-workspace',
    }

    /** Default settings values (mirror of `SETTINGS_DEFAULTS` in lib/shared.js). */
    const SETTINGS_DEFAULTS = {
      githubUsername: '',
      defaultBranch: 'main',
      autoPauseMinutes: 30,
      sshKeyPath: '',
      alwaysShowCloudButton: false,
      autoInitEmptyRepo: true,
      readmeContent: '',
    }

    /** The setting that is never rendered back to the user, only marked as set. */
    const SECRET_KEYS = ['sshKeyPath', 'githubToken']

    /** Sidebar/workspace poll cadence, per docs/CONTRACT.md §6. */
    const POLL_MS = 4000

    /**
     * How long a single click on a running row button waits for a second one.
     *
     * A running Codespace's button means two things — one click pauses it, two
     * clicks pause it NOW — so the single-click action is deferred by this much
     * and cancelled if a `dblclick` arrives first. 320 ms is short enough to
     * feel immediate and long enough for a real double-click.
     */
    const CLICK_WINDOW_MS = 320

    /** Locale namespace for every string this bundle renders. */
    const LOCALE_NS = 'codespace'

    /* States whose normalized phase gates the row button. Mirrors
     * `codespacePhase()` in lib/shared.js.
     * VERIFY: the exact GitHub state strings were not exercised against the live
     * API in this build (docs/CONTRACT.md §3 flags the same gap). The mapping is
     * deliberately tolerant: unknown states normalize to `pending`, which
     * disables the control instead of offering a start the API would reject. */
    const RUNNING_STATES = ['available']
    const STOPPED_STATES = ['shutdown', 'shut_down', 'archived', 'stopped']
    const PENDING_STATES = [
      'created', 'queued', 'provisioning', 'starting', 'shuttingdown', 'shutting_down',
      'exporting', 'updating', 'rebuilding', 'pending',
    ]
    const ERROR_STATES = ['failed', 'unavailable', 'deleted', 'moved', 'unknown']

    /**
     * Normalize a raw Codespace state onto a UI phase.
     * @param {unknown} state - raw `state` field.
     * @returns {'running'|'stopped'|'pending'|'error'} the phase.
     */
    function codespacePhase(state) {
      if (typeof state !== 'string') return 'pending'
      const key = state.trim().toLowerCase().replace(/[\s-]+/g, '_')
      if (RUNNING_STATES.indexOf(key) >= 0) return 'running'
      if (STOPPED_STATES.indexOf(key) >= 0) return 'stopped'
      if (PENDING_STATES.indexOf(key) >= 0) return 'pending'
      if (ERROR_STATES.indexOf(key) >= 0) return 'error'
      return 'pending'
    }

    /** Patterns that must never reach the screen. Mirror of shared.js `redact()`. */
    const SECRET_PATTERNS = [
      /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
      /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    ]

    /**
     * Strip anything credential-shaped out of a string before it is rendered.
     * The host already redacts; this is belt-and-braces for messages that never
     * passed through it (transport errors, exceptions thrown in this bundle).
     * @param {string} text - candidate text.
     * @returns {string} the same text with credential-shaped runs replaced.
     */
    function redact(text) {
      let out = text
      for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
      return out
    }

    /* ------------------------------------------------------------------ *
     * 2. Locale dictionaries (also written to locale/zh.json, locale/en.json)
     * ------------------------------------------------------------------ */

    /** Simplified Chinese dictionary — the key-set source of truth. */
    const MESSAGES_ZH = {
      nav: 'Codespace',
      'page.title': 'Codespace',
      'page.subtitle': '把 GitHub Codespace 当作 DSH 工作区：文件与命令工具在云端 Codespace 里运行。',

      'status.heading': '状态',
      'status.refresh': '刷新',
      'status.checking': '检查中…',
      'status.gh': 'GitHub CLI (gh)',
      'status.gh.installed': '已安装 · {version}',
      'status.gh.missing': '未安装',
      'status.gh.missingNote': '没有检测到 GitHub CLI。这不影响使用：插件会改用你在下面配置的 SSH 连接方式（推荐填 ~/.ssh/config 里的主机别名，例如 codespace-mybox）。安装 gh 后可以获得更完整的能力。',
      'status.token': 'GitHub 令牌',
      'status.token.settings': '来自插件设置',
      'status.token.env': '来自环境变量 GITHUB_TOKEN',
      'status.token.gh': '来自 gh auth token',
      'status.token.none': '未找到',
      'status.token.noneNote': '未找到令牌：仓库列表与 Codespace 生命周期操作不可用。',
      'status.login': 'GitHub 登录',
      'status.loggedOut': '未登录',
      'status.configured': '配置',
      'status.configured.yes': '已配置',
      'status.configured.no': '未配置',
      'status.failed': '状态读取失败：{message}',

      'settings.heading': '设置',
      'field.githubUsername': 'GitHub 用户名',
      'field.githubUsername.hint': '留空表示使用令牌所属的账号。',
      'field.defaultBranch': '默认分支',
      'field.autoPauseMinutes': '自动暂停等待时间（分钟）',
      'field.autoPauseMinutes.hint': '一个回合结束后开始计时，期间收到新消息会取消。填 0 表示不自动暂停。双击工作区行上的时钟图标可以立即暂停。',
      'field.sshKeyPath': 'SSH 密钥（可选）',
      'field.sshKeyPath.hint': '没有 gh 时用它连接 Codespace。填 ~/.ssh/config 里的主机别名，例如 codespace-mybox（私钥请在 Host 条目里用 IdentityFile 指定——只填密钥路径无法确定要连接哪台主机）。',
      'field.sshKeyPath.set': '已设置',
      'field.sshKeyPath.unset': '未设置',
      'field.sshKeyPath.write': '输入新的值（保存后不再显示）',
      'field.sshKeyPath.save': '保存',
      'field.sshKeyPath.clear': '清除',
      'field.alwaysShowCloudButton': '始终显示云端工作区按钮',
      'field.alwaysShowCloudButton.hint': '关闭时，按钮只在鼠标悬停该工作区行时出现。开启后该行的整组操作按钮会常驻显示（CSS 无法只显示其中的一个子元素）。',
      'field.autoInitEmptyRepo': '自动初始化空仓库',
      'field.autoInitEmptyRepo.hint': '仓库没有任何提交时，先提交一个 README 再创建 Codespace。',
      'field.readmeContent': 'README 初始内容',
      'field.readmeContent.hint': '留空则提交一个空的 README.md。',
      'save': '保存',
      'saving': '保存中…',
      'saved': '已保存',
      'saveFailed': '保存失败：{message}',

      'managed.heading': '云端工作区',
      'managed.empty': '还没有由本插件管理的 Codespace 工作区。',
      'managed.loading': '正在读取…',
      'managed.new': '新建云端工作区',
      'managed.delete': '删除 Codespace…',
      'managed.deleteFallbackNote': '侧边栏工作区行的「⋯」菜单里也有「删除 Codespace…」。如果那里没有出现，可以用这里的按钮。',

      'window.title': '新建云端工作区',
      'step.repo': '选择仓库',
      'step.codespace': '选择 Codespace',
      'step.machine': '选择机型',
      'step.apply': '创建',
      'step.done': '完成',
      'repo.search': '搜索仓库',
      'repo.loading': '正在读取仓库…',
      'repo.empty': '没有匹配的仓库。',
      'repo.failed': '仓库读取失败：{message}',
      'repo.private': '私有',
      'repo.isEmpty': '空仓库',
      'repo.count': '共 {n} 个',
      'cs.heading': '该仓库已有 Codespace',
      'cs.pick': '选择一个 Codespace',
      'cs.none': '该仓库还没有 Codespace，将新建一个。',
      'cs.loading': '正在读取 Codespace…',
      'cs.failed': 'Codespace 读取失败：{message}',
      'cs.state': '状态：{state}',
      'cs.createNew': '新建一个 Codespace',
      'prebuild.checking': '正在检查预构建…',
      'prebuild.missing': '未配置预构建，创建可能较慢',
      'prebuild.cancel': '取消',
      'prebuild.proceed': '直接创建',
      'prebuild.ok': '该仓库已配置预构建。',
      'machine.heading': '选择机型',
      'machine.loading': '正在读取机型…',
      'machine.failed': '机型读取失败：{message}',
      'machine.empty': '该仓库没有可用的机型。',
      'machine.default': '默认最小',
      'machine.cpus': '{n} 核',
      'machine.memory': '{n} GB 内存',
      'machine.storage': '{n} GB 存储',
      'machine.gpu': 'GPU',
      'seed.note': '仓库为空：将先提交 README.md，再创建 Codespace。',
      'seed.note.off': '仓库为空，但「自动初始化空仓库」已关闭，创建可能失败。',
      'apply.creating': '正在创建 Codespace…',
      'apply.creatingHint': '创建通常需要 1–3 分钟。',
      'apply.starting': '正在启动 Codespace…',
      'apply.registering': '正在登记 DSH 工作区…',
      'apply.failed': '操作失败：{message}',
      'retry': '重试',
      'back': '上一步',
      'next': '下一步',
      'cancel': '取消',
      'close': '关闭',
      'success.title': 'Codespace 已就绪',
      'success.body': 'DSH 工作区已登记，会话的工作目录是云端 Codespace。',
      'success.open': '在此打开会话',
      'success.opening': '正在打开…',
      'success.openFailed': '侧边栏里还没有这一行，请展开侧边栏后点击该工作区右侧的「新建会话」。',
      'success.done': '完成',

      'row.cloud': '云端 Codespace 工作区',
      'row.start': '启动 Codespace',
      'row.stop': '暂停 Codespace',
      'row.countdown': '还剩 {n} 分钟自动暂停',
      'row.countdownSoon': '即将自动暂停',
      'row.pending': '正在切换状态…',
      'row.error': '状态异常：{state}',
      'row.actionFailed': '操作失败：{message}',

      'menu.delete': '删除 Codespace…',
      'delete.title': '删除 Codespace',
      'delete.body': '将永久删除云端 Codespace「{name}」。其中未推送的改动会一起丢失，且无法恢复。DSH 里保留的工作区记录只包含一个空的占位目录。',
      'delete.confirm': '永久删除',
      'delete.working': '正在删除…',
      'delete.failed': '删除失败：{message}',

      'launcher.label': '新建云端工作区',
    }

    /** English dictionary, complete against the zh key set. */
    const MESSAGES_EN = {
      nav: 'Codespace',
      'page.title': 'Codespace',
      'page.subtitle': 'Use a GitHub Codespace as a DSH workspace: file and command tools run inside the cloud Codespace.',

      'status.heading': 'Status',
      'status.refresh': 'Refresh',
      'status.checking': 'Checking…',
      'status.gh': 'GitHub CLI (gh)',
      'status.gh.installed': 'installed · {version}',
      'status.gh.missing': 'not installed',
      'status.gh.missingNote': 'The GitHub CLI was not found. That does not block the plugin: it connects to the Codespace through the SSH setting below instead (a host alias from ~/.ssh/config, such as codespace-mybox, is the recommended value). Installing gh enables the fuller capability set.',
      'status.token': 'GitHub token',
      'status.token.settings': 'from plugin settings',
      'status.token.env': 'from the GITHUB_TOKEN environment variable',
      'status.token.gh': 'from gh auth token',
      'status.token.none': 'not found',
      'status.token.noneNote': 'No token found: the repository list and the Codespace lifecycle actions are unavailable.',
      'status.login': 'GitHub login',
      'status.loggedOut': 'not signed in',
      'status.configured': 'Configuration',
      'status.configured.yes': 'configured',
      'status.configured.no': 'not configured',
      'status.failed': 'Could not read the status: {message}',

      'settings.heading': 'Settings',
      'field.githubUsername': 'GitHub username',
      'field.githubUsername.hint': 'Leave empty to use the account the token belongs to.',
      'field.defaultBranch': 'Default branch',
      'field.autoPauseMinutes': 'Auto-pause delay (minutes)',
      'field.autoPauseMinutes.hint': 'Counts down after a turn ends; a new message cancels it. 0 disables auto-pause. Double-click the clock on a workspace row to pause immediately.',
      'field.sshKeyPath': 'SSH key (optional)',
      'field.sshKeyPath.hint': 'Used to reach the Codespace when gh is unavailable. Put a host alias from ~/.ssh/config here (such as codespace-mybox); name the private key with IdentityFile in that Host entry — a key path alone does not say which host to reach.',
      'field.sshKeyPath.set': 'Set',
      'field.sshKeyPath.unset': 'Not set',
      'field.sshKeyPath.write': 'Enter a new value (never shown again)',
      'field.sshKeyPath.save': 'Save',
      'field.sshKeyPath.clear': 'Clear',
      'field.alwaysShowCloudButton': 'Always show the cloud workspace button',
      'field.alwaysShowCloudButton.hint': 'When off, the button appears only while the pointer is over that workspace row. When on, the row’s whole action cluster stays visible (CSS cannot reveal one child of a hidden container).',
      'field.autoInitEmptyRepo': 'Initialize empty repositories',
      'field.autoInitEmptyRepo.hint': 'Commit a README first when the repository has no commits.',
      'field.readmeContent': 'Initial README content',
      'field.readmeContent.hint': 'Leave empty to commit an empty README.md.',
      'save': 'Save',
      'saving': 'Saving…',
      'saved': 'Saved',
      'saveFailed': 'Save failed: {message}',

      'managed.heading': 'Cloud workspaces',
      'managed.empty': 'No Codespace workspace is managed by this plugin yet.',
      'managed.loading': 'Loading…',
      'managed.new': 'New cloud workspace',
      'managed.delete': 'Delete Codespace…',
      'managed.deleteFallbackNote': 'The workspace row’s “⋯” menu also offers “Delete Codespace…”. If it does not appear there, use the button here.',

      'window.title': 'New cloud workspace',
      'step.repo': 'Repository',
      'step.codespace': 'Codespace',
      'step.machine': 'Machine',
      'step.apply': 'Create',
      'step.done': 'Done',
      'repo.search': 'Search repositories',
      'repo.loading': 'Loading repositories…',
      'repo.empty': 'No repository matches.',
      'repo.failed': 'Could not load repositories: {message}',
      'repo.private': 'private',
      'repo.isEmpty': 'empty',
      'repo.count': '{n} total',
      'cs.heading': 'This repository already has Codespaces',
      'cs.pick': 'Pick one',
      'cs.none': 'This repository has no Codespace yet; one will be created.',
      'cs.loading': 'Loading Codespaces…',
      'cs.failed': 'Could not load Codespaces: {message}',
      'cs.state': 'state: {state}',
      'cs.createNew': 'Create a new Codespace',
      'prebuild.checking': 'Checking for a prebuild…',
      'prebuild.missing': 'No prebuild configured — creating may be slow',
      'prebuild.cancel': 'Cancel',
      'prebuild.proceed': 'Create anyway',
      'prebuild.ok': 'This repository has a prebuild configured.',
      'machine.heading': 'Machine type',
      'machine.loading': 'Loading machine types…',
      'machine.failed': 'Could not load machine types: {message}',
      'machine.empty': 'No machine type is available for this repository.',
      'machine.default': 'smallest default',
      'machine.cpus': '{n} CPUs',
      'machine.memory': '{n} GB RAM',
      'machine.storage': '{n} GB storage',
      'machine.gpu': 'GPU',
      'seed.note': 'The repository is empty: README.md is committed first, then the Codespace is created.',
      'seed.note.off': 'The repository is empty and “Initialize empty repositories” is off, so creation may fail.',
      'apply.creating': 'Creating the Codespace…',
      'apply.creatingHint': 'Creation usually takes 1–3 minutes.',
      'apply.starting': 'Starting the Codespace…',
      'apply.registering': 'Registering the DSH workspace…',
      'apply.failed': 'The operation failed: {message}',
      'retry': 'Retry',
      'back': 'Back',
      'next': 'Next',
      'cancel': 'Cancel',
      'close': 'Close',
      'success.title': 'The Codespace is ready',
      'success.body': 'The DSH workspace is registered; the session works inside the cloud Codespace.',
      'success.open': 'Open a session here',
      'success.opening': 'Opening…',
      'success.openFailed': 'That row is not in the sidebar yet. Expand the sidebar and use the “New session” button on the workspace row.',
      'success.done': 'Done',

      'row.cloud': 'Cloud Codespace workspace',
      'row.start': 'Start Codespace',
      'row.stop': 'Pause Codespace',
      'row.countdown': 'Auto-pause in {n} min',
      'row.countdownSoon': 'Auto-pausing soon',
      'row.pending': 'Changing state…',
      'row.error': 'Unhealthy state: {state}',
      'row.actionFailed': 'The action failed: {message}',

      'menu.delete': 'Delete Codespace…',
      'delete.title': 'Delete Codespace',
      'delete.body': 'The cloud Codespace “{name}” is deleted permanently. Unpushed work inside it is lost and cannot be recovered. The DSH workspace record stays behind as an empty placeholder directory.',
      'delete.confirm': 'Delete permanently',
      'delete.working': 'Deleting…',
      'delete.failed': 'Delete failed: {message}',

      'launcher.label': 'New cloud workspace',
    }

    /** Replace `{name}` placeholders. */
    function interpolate(template, params) {
      if (params === undefined || params === null) return template
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** Translator used before (and without) the locale service. */
    function fallbackT(key, params) {
      return interpolate(MESSAGES_ZH[key] !== undefined ? MESSAGES_ZH[key] : key, params)
    }

    /* ------------------------------------------------------------------ *
     * 3. Styles — one <style> element, injected inside ctx.effect.
     *
     * Only `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-focus-ring-*` tokens are
     * referenced; every token carries a fallback so a renamed token degrades the
     * appearance instead of breaking it. Literal colors appear nowhere.
     * ------------------------------------------------------------------ */

    /**
     * Class-name suffixes of the host's hashed CSS modules.
     *
     * VERIFY: the hashed prefix is per build (currently `hIlkoa_` for the rows
     * module and `_9lTDKa_` for the workspace browser), so every lookup matches
     * the *suffix* through an attribute-contains selector. If a future build
     * renames a suffix, the matching surface is skipped (with a single console
     * warning) and the rest of the plugin keeps working — the workspace row and
     * the section header are both the host's own DOM and are never required for
     * anything else here.
     *
     * Declared before `CSS` because the stylesheet is built from them.
     */
    const ROW_ACTIONS_SUFFIX = '_rowActions'
    const MENU_OPEN_SUFFIX = '_menuOpen'
    const HOVER_PATH_SUFFIX = '_hoverPath'
    const SECTION_HEADER_SUFFIX = '_sectionHeader'
    const HEADER_ACTIONS_SUFFIX = '_headerActions'
    const HEADER_HIDDEN_SUFFIX = '_headerActionsHidden'
    const RAIL_SUFFIX = '_rail'

    /**
     * The cloud glyph, drawn to the same spec as the host's own icons.
     *
     * The controls this sits among are `Icon*OutlineRegular` from
     * `@deepseek-ai/dsh-client-ui-primitives`, and their artwork has a fixed
     * shape: `<svg width height viewBox="0 0 16 16" fill="none" aria-hidden
     * stroke-width={1}>` with `stroke="currentColor"` on each stroked path. The
     * `Regular` weight is **1**; the host's `Medium` weight is 1.3
     * (`ICON_MEDIUM_STROKE`).
     *
     * This glyph used to declare `stroke-width: 1.3` on the path itself, which
     * made it visibly heavier than the "添加工作区" button beside it — that is
     * the mismatch this constant fixes. Keep the stroke width here (one place,
     * consumed by both the React and the DOM renderer) rather than on a path.
     *
     * The primitives set has no cloud artwork (there is no `Cloud` symbol in its
     * bundle), so the path is ours; it is drawn for a 1px stroke on the 16x16
     * grid, so the two renderers cannot drift apart.
     */
    const CLOUD_PATH = 'M11.667 12.667H6a4.667 4.667 0 1 1 4.473-6h1.193a3 3 0 1 1 0 6Z'
    const ICON_STROKE_WIDTH = '1'

    const CSS = [
      /* ---- shared page chrome ---- */
      '.dcw-root{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);max-width:880px}',
      '.dcw-root *{box-sizing:border-box}',
      '.dcw-title{font-size:20px;font-weight:600;line-height:1.3;margin:0}',
      '.dcw-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin:4px 0 0}',
      '.dcw-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;margin-top:12px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-settings-card-fill,transparent)}',
      '.dcw-card-title{font-size:15px;font-weight:600;line-height:1.4;margin:0}',
      '.dcw-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dcw-row-start{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.dcw-stack{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}',
      '.dcw-label{font-size:13px;font-weight:500;line-height:1.5}',
      '.dcw-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dcw-mono{font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:12px;overflow-wrap:anywhere}',
      '.dcw-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dcw-divider{height:1px;background:var(--dsw-alias-border-l2);margin:4px 0}',

      /* ---- controls ---- */
      '.dcw-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
      '.dcw-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dcw-button:disabled{cursor:default;opacity:.45}',
      '.dcw-button[data-variant="primary"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted);font-weight:600}',
      '.dcw-button[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dcw-button[data-variant="danger"]{color:var(--dsw-alias-state-error-primary);border-color:transparent;padding:0 10px}',
      '.dcw-button[data-variant="danger"]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dcw-button[data-variant="ghost"]{border-color:transparent;padding:0 8px;color:var(--dsw-alias-label-secondary)}',
      '.dcw-button[data-variant="ghost"]:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dcw-button:focus-visible,.dcw-input:focus-visible,.dcw-switch:focus-visible,.dcw-choice:focus-visible,[data-dsh-codespace-launcher]:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dcw-input{height:32px;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;padding:0 10px}',
      '.dcw-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      'textarea.dcw-input{height:auto;min-height:72px;padding:8px 10px;resize:vertical;line-height:1.5}',
      '.dcw-switch{position:relative;width:36px;height:20px;flex:none;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-3,transparent);cursor:pointer}',
      '.dcw-switch[data-on="true"]{background:var(--dsw-alias-state-business-primary);border-color:transparent}',
      '.dcw-switch:disabled{cursor:default;opacity:.45}',
      '.dcw-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s}',
      '.dcw-switch[data-on="true"] .dcw-switch-knob{transform:translateX(16px);background:var(--dsw-alias-label-primary-inverted)}',

      /* ---- choice rows (repo / codespace / machine) ---- */
      '.dcw-choice{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;font:inherit;padding:8px 10px;cursor:pointer}',
      '.dcw-choice:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dcw-choice:disabled{cursor:default;opacity:.5}',
      '.dcw-choice[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary)}',
      '.dcw-choice-mark{flex:none;width:16px;height:16px;margin-top:2px;border-radius:50%;border:1.5px solid var(--dsw-alias-label-tertiary)}',
      '.dcw-choice[data-selected="true"] .dcw-choice-mark{border:5px solid var(--dsw-alias-state-business-primary)}',
      '.dcw-choice-name{font-weight:600;overflow-wrap:anywhere}',
      '.dcw-choice-meta{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dcw-list{display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto;padding-right:2px}',
      '.dcw-tag{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dcw-tag[data-tone="business"]{color:var(--dsw-alias-state-business-primary);border-color:transparent;background:var(--dsw-alias-bg-layer-3,transparent)}',

      /* ---- notices / errors ---- */
      '.dcw-notice{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dcw-notice[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:transparent;background:var(--dsw-alias-bg-layer-3,transparent)}',
      '.dcw-error{border-radius:8px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);overflow-wrap:anywhere}',
      '.dcw-empty{padding:12px 0;color:var(--dsw-alias-label-secondary);font-size:12px}',

      /* ---- steps ---- */
      '.dcw-steps{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.dcw-step{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dcw-step[data-active="true"]{color:var(--dsw-alias-label-primary)}',
      '.dcw-step-number{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid currentColor;font-size:11px;flex:none}',
      '.dcw-step[data-active="true"] .dcw-step-number{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted)}',
      '.dcw-step-sep{color:var(--dsw-alias-label-tertiary);font-size:11px}',

      /* ---- spinner ---- */
      '@keyframes dcw-spin{to{transform:rotate(360deg)}}',
      '.dcw-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-label-tertiary);border-top-color:transparent;border-radius:50%;animation:dcw-spin .8s linear infinite;flex:none}',

      /* ---- overlay window ---- */
      '.dcw-overlay{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:16px;background:var(--dsw-alias-bg-mask-1,color-mix(in srgb,var(--dsw-alias-label-primary) 40%,transparent))}',
      '.dcw-window{width:min(680px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base))}',
      '.dcw-window-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.dcw-window-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}',

      /* ---- workspace-row augmentation ---------------------------------- *
       * OBSERVED (dsh-client-ui-workspace/lib/client.js, the Rows CSS module):
       *   .<hash>_rowActions{flex:none;align-items:center;gap:10px;display:none}
       *   .<hash>_projectRow:hover .<hash>_rowActions,
       *   .<hash>_sessionRow:hover .<hash>_rowActions,
       *   .<hash>_searchResultRow:hover .<hash>_rowActions,
       *   .<hash>_projectRow.<hash>_menuOpen .<hash>_rowActions,
       *   .<hash>_sessionRow.<hash>_menuOpen .<hash>_rowActions{display:inline-flex}
       *   .<hash>_slot{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;
       *                justify-content:center;align-items:center;display:inline-flex}
       *   .<hash>_iconButton{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;
       *                      color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;
       *                      justify-content:center;align-items:center;padding:0;display:inline-flex}
       *   .<hash>_iconButton:hover{color:var(--dsw-alias-label-primary)}
       *   .<hash>_folder{display:none}                     <-- the folder span is hidden in BOTH states
       *   .<hash>_projectRow:hover .<hash>_folder{display:none}
       * The hashed prefix (`hIlkoa_`) is per build, so every selector below matches
       * the class name by suffix via [class*="_name"]. The stable hooks are
       * `data-row-key` (host-rendered) and the `data-dsh-codespace-*` attributes
       * this bundle adds.
       * ------------------------------------------------------------------ */
      '[data-dsh-codespace-icon]{width:16px;height:20px;color:var(--dsw-alias-label-secondary);flex:none;display:inline-flex;align-items:center;justify-content:center;pointer-events:none}',
      '[data-dsh-codespace-icon] svg{width:16px;height:16px;display:block}',
      '[data-dsh-codespace-action]{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:1;cursor:pointer;flex:none}',
      '[data-dsh-codespace-action]:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '[data-dsh-codespace-action]:disabled{cursor:default;opacity:.6}',
      '[data-dsh-codespace-action] .dcw-spin{width:10px;height:10px;border-width:1.5px}',
      '[data-dsh-codespace-glyph]{display:inline-block;font-size:12px;line-height:1}',
      /* `alwaysShowCloudButton`: the container is `display:none` when the row is
       * not hovered, and a `display:none` ancestor cannot be overridden from a
       * descendant — so the CONTAINER has to be revealed. Only managed rows carry
       * the marker, so no other row changes. */
      '[data-dsh-codespace-row][data-dsh-codespace-always] [class*="_rowActions"]{display:inline-flex}',

      /* ---- section-header launcher ------------------------------------- *
       * OBSERVED (dsh-client-ui-workspace/lib/client.js, the WorkspaceBrowser
       * CSS module, `_9lTDKa_`):
       *   .<hash>_sectionHeader{height:36px;justify-content:flex-end;align-items:center;
       *                         gap:4px;padding-left:4px;display:flex;overflow:hidden}
       *   .<hash>_headerActions{max-width:60px;flex:none;align-items:center;gap:4px;
       *                         display:flex;overflow:hidden}
       *   .<hash>_headerActionsHidden{opacity:0;visibility:hidden;pointer-events:none;max-width:0}
       *   .<hash>_rail .<hash>_headerActions{max-width:none}
       *   .<hash>_rail .<hash>_iconButton{border-radius:var(--dsw-radius-md);
       *                                    width:36px;height:36px;
       *                                    color:var(--dsw-alias-label-primary)}
       *   .<hash>_iconButton{border-radius:var(--dsw-radius-xs);cursor:pointer;
       *                      width:16px;height:16px;color:var(--dsw-alias-label-tertiary);
       *                      background:0 0;border:none;flex:none;display:inline-flex}
       *   .<hash>_iconButton:hover{color:var(--dsw-alias-label-primary)}
       * The launcher is a peer of those controls, so it copies `iconButton` exactly
       * and takes the rail metrics in rail mode. Three consequences of the host's
       * own rules are handled here rather than in JavaScript:
       *   - `max-width:60px` fits exactly three 16px icons with 4px gaps
       *     (16*3 + 4*2 = 56). A fourth peer would be clipped by `overflow:hidden`,
       *     so the container is widened. The `:not(...)` guard is load-bearing:
       *     without it this rule would also beat the host's `headerActionsHidden`
       *     collapse (same property, and ours is more specific), leaving the group
       *     visible while the search box is expanded.
       *   - `headerActionsHidden` (applied to the same element while the search box
       *     is expanded) collapses the CONTAINER to `max-width:0;opacity:0;
       *     pointer-events:none`. Because the launcher is a child of that container
       *     it disappears with its peers for free.
       *   - The header is `justify-content:flex-end` and the search slot is `flex:1`,
       *     so widening the group shifts it left without pushing any host control
       *     out of view. */
      /* The launcher is a peer of the host's own header controls, so it copies
       * that control's metrics verbatim from `WorkspaceBrowser`'s
       * `_iconButton`: 28x28, `--dsw-radius-sm`, `--dsw-alias-label-secondary`,
       * a transparent background, and a hover that shows a BACKGROUND rather
       * than changing the text colour. An earlier revision used a 16x16 box
       * with `--dsw-radius-xs` and a colour-only hover, which read as a smaller,
       * differently-styled control next to the "+" button. */
      '[data-dsh-codespace-launcher]{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;flex:none}',
      '[data-dsh-codespace-launcher]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '[data-dsh-codespace-launcher]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '[data-dsh-codespace-launcher] svg{display:block}',
      '[data-dsh-codespace-header][class*="' + HEADER_ACTIONS_SUFFIX + '"]:not([class*="' + HEADER_HIDDEN_SUFFIX + '"]){max-width:none}',
      /* Rail mode: the host enlarges the box to 36px and its glyph to 18px
       * (`size: wide ? 16 : 18`), so the glyph follows the box. */
      '[class*="' + RAIL_SUFFIX + '"] [data-dsh-codespace-launcher]{border-radius:var(--dsw-radius-md,8px);width:36px;height:36px;color:var(--dsw-alias-label-primary)}',
      '[class*="' + RAIL_SUFFIX + '"] [data-dsh-codespace-launcher] svg{width:18px;height:18px}',

      /* ---- menu item we append to the host's portaled workspace menu ---- */
      '[data-dsh-codespace-menu-separator]{height:1px;background:var(--dsw-alias-border-l2);margin:4px 6px}',
      '[data-dsh-codespace-menu-item]{display:flex;align-items:center;width:100%;gap:8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;text-align:left;padding:6px 10px;cursor:pointer}',
      '[data-dsh-codespace-menu-item]:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}',
    ].join('\n')

    /* ------------------------------------------------------------------ *
     * 4. Transport
     * ------------------------------------------------------------------ */

    /** Error carrying the host's `error.code`, never a credential. */
    function RpcError(code, message) {
      const error = new Error(redact(message))
      error.code = code
      error.name = 'RpcError'
      return error
    }

    /**
     * One RPC call against the host route. Always resolves the parsed body;
     * rejects only on a transport failure or `{ ok: false }`.
     *
     * @param {string} action - one of ACTIONS.
     * @param {object} [payload] - the action's payload.
     * @returns {Promise<object>} the success body.
     */
    async function rpc(action, payload) {
      const body = Object.assign({ action }, payload === undefined ? {} : payload)
      const send = (globalThis.__DSH_TRANSPORT__ && globalThis.__DSH_TRANSPORT__.fetch) || fetch
      let response
      try {
        response = await send(RPC_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        throw RpcError('E_TRANSPORT', messageOf(error))
      }
      let data = null
      try {
        data = await response.json()
      } catch (error) {
        throw RpcError('E_BAD_RESPONSE', 'HTTP ' + String(response.status))
      }
      if (data === null || typeof data !== 'object') throw RpcError('E_BAD_RESPONSE', 'HTTP ' + String(response.status))
      if (data.ok !== true) {
        const failure = data.error !== null && typeof data.error === 'object' ? data.error : {}
        throw RpcError(typeof failure.code === 'string' ? failure.code : 'E_UNKNOWN', String(failure.message || 'HTTP ' + String(response.status)))
      }
      return data
    }

    /** Reduce an unknown thrown value to a displayable, redacted string. */
    function messageOf(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return redact(error)
      if (typeof error.message === 'string') return redact(error.message)
      return redact(String(error))
    }

    /* ------------------------------------------------------------------ *
     * 5. Tolerant readers for the wire records
     *
     * `Managed` and `Codespace` are described in docs/CONTRACT.md §6, but the
     * host half is written in parallel: every reader below accepts the documented
     * shape plus the two obvious variants, and returns an empty/neutral value
     * rather than throwing.
     * ------------------------------------------------------------------ */

    /** Coerce to a finite number, or `Number.MAX_SAFE_INTEGER` so it sorts last. */
    function num(value) {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
    }

    /** VERIFY: `Managed.codespace` is documented as a `Codespace` object; the
     * host may also send just the name. Both are accepted here. */
    function codespaceOf(record) {
      if (record === null || typeof record !== 'object') return null
      const cs = record.codespace
      if (cs !== null && typeof cs === 'object') return cs
      if (typeof cs === 'string' && cs !== '') return { name: cs, state: record.state }
      return null
    }

    /** The Codespace name used by every lifecycle RPC (`{ name }`). */
    function codespaceNameOf(record) {
      const cs = codespaceOf(record)
      if (cs !== null && typeof cs.name === 'string' && cs.name !== '') return cs.name
      if (typeof record.codespaceName === 'string') return record.codespaceName
      return ''
    }

    /** Human label for the hover card: display name, then name, then DSH title. */
    function codespaceLabelOf(record) {
      const cs = codespaceOf(record)
      if (cs !== null) {
        if (typeof cs.displayName === 'string' && cs.displayName !== '') return cs.displayName
        if (typeof cs.name === 'string' && cs.name !== '') return cs.name
      }
      if (typeof record.title === 'string' && record.title !== '') return record.title
      return codespaceNameOf(record)
    }

    /** The raw state string, for the error tooltip. */
    function codespaceStateOf(record) {
      const cs = codespaceOf(record)
      if (cs !== null && typeof cs.state === 'string') return cs.state
      if (typeof record.state === 'string') return record.state
      return ''
    }

    /** Normalized phase, falling back to the top-level `state` field. */
    function phaseOf(record) {
      return codespacePhase(codespaceStateOf(record))
    }

    /** VERIFY: `autoPauseRemainingMs` is documented in milliseconds and
     * `autoPauseDeadline` as a deadline; an epoch-seconds deadline is also
     * accepted, because that mistake is invisible in a 4-second poll. */
    function countdownMsOf(record) {
      const remaining = record.autoPauseRemainingMs
      if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining > 0) return remaining
      const deadline = record.autoPauseDeadline
      let at = null
      if (typeof deadline === 'number' && Number.isFinite(deadline)) at = deadline
      else if (typeof deadline === 'string') {
        const parsed = Date.parse(deadline)
        if (!Number.isNaN(parsed)) at = parsed
      }
      if (at === null) return 0
      if (at < 1e11) at *= 1000
      return Math.max(0, at - Date.now())
    }

    /** Whether the row button must show a spinner. */
    function isBusy(record, pendingIds) {
      if (pendingIds.has(record.workspaceId)) return true
      if (record.busy === true) return true
      return phaseOf(record) === 'pending'
    }

    /** Fill in defaults for a settings object coming off the wire. */
    function normalizeSettings(raw) {
      const out = Object.assign({}, SETTINGS_DEFAULTS)
      if (raw !== null && typeof raw === 'object') {
        for (const key of Object.keys(SETTINGS_DEFAULTS)) {
          if (raw[key] !== undefined) out[key] = raw[key]
        }
      }
      return out
    }

    /**
     * Whether a write-only secret has a stored value.
     *
     * VERIFY: the exact redaction marker is the host's choice. A non-empty string
     * (including the usual `***` / `•••` / `[redacted]` placeholders), a truthy
     * boolean, or a `secrets` marker object all count as "set". The value itself
     * is never rendered and never sent back.
     */
    function secretIsSet(settings, secrets, key) {
      if (secrets !== null && typeof secrets === 'object') {
        const marker = secrets[key]
        if (marker === true) return true
        if (marker !== null && typeof marker === 'object' && marker.set === true) return true
        if (typeof marker === 'string' && marker !== '' && marker !== 'none') return true
      }
      if (settings === null || typeof settings !== 'object') return false
      const value = settings[key]
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') return value !== ''
      return false
    }

    /** Whether a settings object still carries a real secret value (never sent back). */
    function stripSecrets(settings) {
      const out = Object.assign({}, settings)
      for (const key of SECRET_KEYS) delete out[key]
      return out
    }

    /** The smallest machine: fewest CPUs, then least memory, then least storage. */
    function compareMachines(a, b) {
      const cpus = num(a.cpus) - num(b.cpus)
      if (cpus !== 0) return cpus
      const memory = num(a.memoryGb) - num(b.memoryGb)
      if (memory !== 0) return memory
      const storage = num(a.storageGb) - num(b.storageGb)
      if (storage !== 0) return storage
      return String(a.name).localeCompare(String(b.name))
    }

    /** The machine the window preselects. */
    function smallestMachine(machines) {
      if (!Array.isArray(machines) || machines.length === 0) return null
      return machines.slice().sort(compareMachines)[0]
    }

    /* ------------------------------------------------------------------ *
     * 6. Stores
     * ------------------------------------------------------------------ */

    /** Cheap structural equality for wire snapshots (they are small and flat). */
    function sameJson(a, b) {
      if (a === b) return true
      try {
        return JSON.stringify(a) === JSON.stringify(b)
      } catch (error) {
        return false
      }
    }

    /**
     * The plugin's one data store: the managed-workspace list (polled) plus the
     * settings (loaded on demand).
     *
     * Polling is a non-overlapping `setTimeout` chain that runs only while at
     * least one subscriber holds an "owner" claim — the sidebar launcher and the
     * settings page's workspace list. The row augmenter observes without owning,
     * so the plugin does not poll when neither surface is mounted.
     *
     * @param {(action: string, payload?: object) => Promise<object>} call - the RPC.
     * @returns {object} the store.
     */
    function createStore(call) {
      const listeners = new Set()
      let owners = 0
      let disposed = false
      let timer = null
      let inFlight = false
      let state = {
        workspaces: [],
        workspacesReady: false,
        workspacesError: '',
        settings: null,
        settingsRevision: 0,
        settingsLoaded: false,
        settingsError: '',
      }

      function getState() {
        return state
      }

      function publish(patch) {
        let changed = false
        for (const key of Object.keys(patch)) {
          if (!sameJson(state[key], patch[key])) {
            changed = true
            break
          }
        }
        if (!changed) return
        state = Object.assign({}, state, patch)
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.warn('[dsh-codespace-workspace] store listener failed', error)
          }
        }
      }

      function schedule() {
        if (disposed || owners === 0 || timer !== null) return
        timer = setTimeout(() => {
          timer = null
          void poll()
        }, POLL_MS)
      }

      function stopPolling() {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }

      async function poll() {
        if (disposed || inFlight) return
        inFlight = true
        try {
          const data = await call(ACTIONS.WORKSPACES)
          publish({
            workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
            workspacesReady: true,
            workspacesError: '',
          })
        } catch (error) {
          publish({ workspacesError: messageOf(error), workspacesReady: true })
        } finally {
          inFlight = false
          schedule()
        }
      }

      /** Refresh now (used after a mutation); never overlaps the poll chain. */
      function refresh() {
        if (disposed) return
        stopPolling()
        if (inFlight) {
          schedule()
          return
        }
        void poll()
      }

      async function loadSettings(force) {
        if (state.settingsLoaded && force !== true) return state.settings
        try {
          const data = await call(ACTIONS.GET_SETTINGS)
          publish({
            settings: normalizeSettings(data.settings),
            settingsRevision: data.settingsRevision !== undefined ? data.settingsRevision : data.revision,
            settingsLoaded: true,
            settingsError: '',
          })
        } catch (error) {
          publish({ settingsError: messageOf(error), settingsLoaded: true })
          throw error
        }
        return state.settings
      }

      async function saveSettings(patch) {
        const data = await call(ACTIONS.SET_SETTINGS, { patch })
        publish({
          settings: normalizeSettings(data.settings),
          settingsRevision: data.settingsRevision !== undefined ? data.settingsRevision : data.revision,
          settingsLoaded: true,
          settingsError: '',
        })
        return state.settings
      }

      function subscribe(listener, owns) {
        listeners.add(listener)
        if (owns === true) {
          owners += 1
          if (owners === 1) refresh()
        }
        return () => {
          listeners.delete(listener)
          if (owns === true) {
            owners = Math.max(0, owners - 1)
            if (owners === 0) stopPolling()
          }
        }
      }

      function dispose() {
        disposed = true
        stopPolling()
        listeners.clear()
        owners = 0
      }

      return { getState, subscribe, refresh, loadSettings, saveSettings, dispose }
    }

    /**
     * Which overlay is open. One `shell.overlay` entry reads this, so the create
     * flow and the delete confirmation are never a stack of dialogs.
     */
    function createUiStore() {
      const listeners = new Set()
      let seq = 0
      let state = { create: null, del: null }

      function publish(next) {
        state = next
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.warn('[dsh-codespace-workspace] ui listener failed', error)
          }
        }
      }

      return {
        getState() {
          return state
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        openCreate() {
          seq += 1
          publish({ create: { seq }, del: null })
        },
        openDelete(target) {
          seq += 1
          publish({ create: null, del: Object.assign({ seq }, target) })
        },
        close() {
          publish({ create: null, del: null })
        },
        dispose() {
          listeners.clear()
          state = { create: null, del: null }
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * 7. Hooks and shared components
     * ------------------------------------------------------------------ */

    /** `useSyncExternalStore` when available, with a React-17-shaped fallback.
     * The branch is resolved once, so hook order is stable for the module. */
    const useExternalStore =
      typeof React.useSyncExternalStore === 'function'
        ? function useStore(subscribe, getSnapshot) {
            return React.useSyncExternalStore(subscribe, getSnapshot)
          }
        : function useStore(subscribe, getSnapshot) {
            const [value, setValue] = React.useState(getSnapshot)
            React.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot])
            return value
          }

    /** Subscribe to a snapshot store. */
    function useStoreState(store, owns) {
      const subscribe = React.useCallback((listener) => store.subscribe(listener, owns), [store, owns])
      const getSnapshot = React.useCallback(() => store.getState(), [store])
      return useExternalStore(subscribe, getSnapshot)
    }

    /** Re-render when the active locale changes. */
    function useLocaleTick(locale) {
      const [, bump] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => {
        if (locale === undefined || locale === null || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => bump())
      }, [locale])
    }

    /** The cloud glyph used by the launcher, the window header and the row marker. */
    function CloudIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          strokeWidth: ICON_STROKE_WIDTH,
        },
        h('path', { d: CLOUD_PATH, stroke: 'currentColor' }),
      )
    }

    /** A plain button matching the host's control metrics. */
    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dcw-button',
          'data-variant': props.variant === undefined ? 'default' : props.variant,
          disabled: props.disabled === true,
          onClick: props.onClick,
          title: props.title,
          'aria-label': props['aria-label'],
        },
        props.children,
      )
    }

    /** Escape closes the topmost overlay window (the host Modal's own contract). */
    function useEscape(onClose) {
      const latest = React.useRef(onClose)
      latest.current = onClose
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.shiftKey) return
          if (event.defaultPrevented) return
          latest.current()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [])
    }

    /** The one overlay host: a mask plus a card, matching the host Modal's shape.
     * The component itself unmounts when nothing is open, so the key listener and
     * the window are owned by the open window rather than by the slot. */
    function OverlayWindow(props) {
      useEscape(props.onClose)
      return h(
        'div',
        {
          className: 'dcw-overlay',
          role: 'presentation',
          onClick: (event) => {
            if (event.target === event.currentTarget) props.onClose()
          },
        },
        h(
          'div',
          {
            className: 'dcw-window',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': props.label,
          },
          props.children,
        ),
      )
    }

    /** `role="switch"` toggle (the host's own control contract). */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'dcw-switch',
          'aria-checked': props.checked === true ? 'true' : 'false',
          'aria-label': props.label,
          title: props.label,
          'data-on': props.checked === true ? 'true' : 'false',
          disabled: props.disabled === true,
          onClick: () => props.onChange(props.checked !== true),
        },
        h('span', { className: 'dcw-switch-knob' }),
      )
    }

    /** One labelled control row. */
    function Field(props) {
      return h(
        'div',
        { className: 'dcw-stack' },
        h('div', { className: 'dcw-label' }, props.label),
        props.control,
        props.hint === undefined || props.hint === null ? null : h('div', { className: 'dcw-muted' }, props.hint),
      )
    }

    /** One labelled row with the control on the right (switches). */
    function ToggleRow(props) {
      return h(
        'div',
        { className: 'dcw-row-start' },
        h(
          'div',
          { className: 'dcw-stack' },
          h('div', { className: 'dcw-label' }, props.label),
          props.hint === undefined ? null : h('div', { className: 'dcw-muted' }, props.hint),
        ),
        props.control,
      )
    }

    /** One selectable row used by the repo, codespace and machine steps. */
    function Choice(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dcw-choice',
          'data-selected': props.selected === true ? 'true' : 'false',
          'aria-pressed': props.selected === true ? 'true' : 'false',
          disabled: props.disabled === true,
          onClick: props.onClick,
        },
        h('span', { className: 'dcw-choice-mark', 'aria-hidden': 'true' }),
        h(
          'span',
          { className: 'dcw-stack' },
          h(
            'span',
            { className: 'dcw-row' },
            h('span', { className: 'dcw-choice-name' }, props.title),
            props.tag === undefined ? null : h('span', { className: 'dcw-tag', 'data-tone': props.tagTone }, props.tag),
          ),
          props.meta === undefined ? null : h('span', { className: 'dcw-choice-meta' }, props.meta),
          props.detail === undefined ? null : h('span', { className: 'dcw-muted' }, props.detail),
        ),
      )
    }

    /** The multi-step progress line. */
    function Steps(props) {
      const labels = [props.t('step.repo'), props.t('step.codespace'), props.t('step.machine'), props.t('step.apply')]
      const children = []
      for (let i = 0; i < labels.length; i += 1) {
        if (i > 0) children.push(h('span', { key: 'sep' + i, className: 'dcw-step-sep' }, '›'))
        children.push(
          h(
            'span',
            { key: 'step' + i, className: 'dcw-step', 'data-active': i === props.active ? 'true' : 'false' },
            h('span', { className: 'dcw-step-number' }, String(i + 1)),
            labels[i],
          ),
        )
      }
      return h('div', { className: 'dcw-steps' }, children)
    }

    /* ------------------------------------------------------------------ *
     * 8. Settings section
     * ------------------------------------------------------------------ */

    /**
     * The **Codespace** settings page.
     *
     * Every value is persisted through `set-settings`; nothing is kept in
     * localStorage. The SSH field is write-only: only a set/unset marker plus an
     * empty input is ever rendered, and a stored value is never read back.
     */
    function createSettingsSection(deps) {
      const { store, ui, t, locale } = deps

      function SettingsSection() {
        useLocaleTick(locale)
        const snapshot = useStoreState(store, true)
        const [draft, setDraft] = React.useState(null)
        const [saving, setSaving] = React.useState(false)
        const [saveError, setSaveError] = React.useState('')
        const [saved, setSaved] = React.useState(false)
        const [secretDraft, setSecretDraft] = React.useState('')
        const [secretBusy, setSecretBusy] = React.useState(false)
        const [status, setStatus] = React.useState(null)
        const [statusError, setStatusError] = React.useState('')
        const [statusBusy, setStatusBusy] = React.useState(false)
        const alive = React.useRef(true)

        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])

        // The settings page reads its own values; it does not depend on another
        // surface having loaded them.
        React.useEffect(() => {
          store.loadSettings().catch(() => {})
        }, [])

        React.useEffect(() => {
          if (snapshot.settingsLoaded && draft === null && snapshot.settings !== null) {
            setDraft(stripSecrets(snapshot.settings))
          }
        }, [snapshot.settingsLoaded, snapshot.settings, draft])

        const loadStatus = React.useCallback(() => {
          setStatusBusy(true)
          setStatusError('')
          rpc(ACTIONS.STATUS)
            .then((data) => {
              if (!alive.current) return
              setStatus(data)
            })
            .catch((error) => {
              if (!alive.current) return
              setStatusError(messageOf(error))
            })
            .then(() => {
              if (alive.current) setStatusBusy(false)
            })
        }, [])

        React.useEffect(() => {
          loadStatus()
        }, [loadStatus])

        const base = snapshot.settings === null ? null : stripSecrets(snapshot.settings)
        const dirty = draft !== null && base !== null && !sameJson(draft, base)

        function setField(key, value) {
          setSaved(false)
          setDraft((current) => Object.assign({}, current === null ? SETTINGS_DEFAULTS : current, { [key]: value }))
        }

        function commit() {
          if (draft === null || base === null) return
          const patch = {}
          for (const key of Object.keys(SETTINGS_DEFAULTS)) {
            if (key === 'sshKeyPath') continue
            if (!sameJson(draft[key], base[key])) patch[key] = draft[key]
          }
          if (Object.keys(patch).length === 0) return
          setSaving(true)
          setSaveError('')
          store
            .saveSettings(patch)
            .then(() => {
              if (!alive.current) return
              setSaving(false)
              setSaved(true)
            })
            .catch((error) => {
              if (!alive.current) return
              setSaving(false)
              setSaveError(messageOf(error))
            })
        }

        function writeSecret(value) {
          setSecretBusy(true)
          setSaveError('')
          store
            .saveSettings({ sshKeyPath: value })
            .then(() => {
              if (!alive.current) return
              setSecretBusy(false)
              setSecretDraft('')
              setSaved(true)
            })
            .catch((error) => {
              if (!alive.current) return
              setSecretBusy(false)
              setSaveError(messageOf(error))
            })
        }

        const gh = status !== null && status.gh !== null && typeof status.gh === 'object' ? status.gh : null
        const ghInstalled = gh !== null && gh.installed === true
        const tokenSource = status !== null && typeof status.tokenSource === 'string' ? status.tokenSource : 'none'
        const tokenFound = tokenSource !== 'none' && tokenSource !== ''
        const login = gh !== null && typeof gh.login === 'string' && gh.login !== '' ? gh.login : ''

        const statusRows = []
        statusRows.push(
          h(
            'div',
            { key: 'gh', className: 'dcw-row-start' },
            h('div', { className: 'dcw-stack' }, h('div', { className: 'dcw-label' }, t('status.gh'))),
            h(
              'div',
              { className: 'dcw-stack', style: { alignItems: 'flex-end', textAlign: 'right' } },
              h(
                'span',
                { className: ghInstalled ? undefined : 'dcw-muted' },
                status === null
                  ? t('status.checking')
                  : ghInstalled
                    ? t('status.gh.installed', { version: gh.version === undefined || gh.version === null || gh.version === '' ? '?' : gh.version })
                    : t('status.gh.missing'),
              ),
              ghInstalled || status === null
                ? null
                : h('span', { className: 'dcw-muted' }, t('status.gh.missingNote')),
            ),
          ),
        )
        statusRows.push(
          h(
            'div',
            { key: 'token', className: 'dcw-row' },
            h('span', { className: 'dcw-label' }, t('status.token')),
            h('span', null, tokenSource === 'settings' ? t('status.token.settings') : tokenSource === 'env' ? t('status.token.env') : tokenSource === 'gh' ? t('status.token.gh') : t('status.token.none')),
          ),
        )
        if (!tokenFound && status !== null) {
          statusRows.push(h('div', { key: 'tokenNote', className: 'dcw-muted' }, t('status.token.noneNote')))
        }
        statusRows.push(
          h(
            'div',
            { key: 'login', className: 'dcw-row' },
            h('span', { className: 'dcw-label' }, t('status.login')),
            h('span', null, login === '' ? t('status.loggedOut') : login),
          ),
        )
        // VERIFY: `status.configured` is documented but its shape is not; only a
        // boolean is rendered, anything else is ignored rather than guessed at.
        if (status !== null && typeof status.configured === 'boolean') {
          statusRows.push(
            h(
              'div',
              { key: 'configured', className: 'dcw-row' },
              h('span', { className: 'dcw-label' }, t('status.configured')),
              h('span', null, status.configured ? t('status.configured.yes') : t('status.configured.no')),
            ),
          )
        }

        const secretSet = secretIsSet(snapshot.settings, status === null ? null : status.secrets, 'sshKeyPath')

        const managed = snapshot.workspaces
        const managedCard = h(
          'div',
          { className: 'dcw-card' },
          h(
            'div',
            { className: 'dcw-row' },
            h('h3', { className: 'dcw-card-title' }, t('managed.heading')),
            h(
              Button,
              { onClick: () => ui.openCreate() },
              h(CloudIcon),
              t('managed.new'),
            ),
          ),
          snapshot.workspacesError !== ''
            ? h('div', { className: 'dcw-error' }, t('apply.failed', { message: snapshot.workspacesError }))
            : null,
          !snapshot.workspacesReady
            ? h('div', { className: 'dcw-empty' }, t('managed.loading'))
            : managed.length === 0
              ? h('div', { className: 'dcw-empty' }, t('managed.empty'))
              : h(
                  'div',
                  { className: 'dcw-list' },
                  managed.map((record) =>
                    h(
                      'div',
                      { key: String(record.workspaceId), className: 'dcw-row', style: { padding: '4px 0' } },
                      h(
                        'div',
                        { className: 'dcw-stack' },
                        h('span', { className: 'dcw-label' }, codespaceLabelOf(record)),
                        h(
                          'span',
                          { className: 'dcw-muted' },
                          t('cs.state', { state: codespaceStateOf(record) === '' ? 'unknown' : codespaceStateOf(record) }),
                        ),
                      ),
                      h(
                        Button,
                        {
                          variant: 'danger',
                          onClick: () =>
                            ui.openDelete({
                              workspaceId: record.workspaceId,
                              codespaceName: codespaceNameOf(record),
                              label: codespaceLabelOf(record),
                            }),
                        },
                        t('managed.delete'),
                      ),
                    ),
                  ),
                ),
          h('div', { className: 'dcw-muted' }, t('managed.deleteFallbackNote')),
        )

        return h(
          'div',
          { className: 'dcw-root' },
          h('h2', { className: 'dcw-title' }, t('page.title')),
          h('p', { className: 'dcw-sub' }, t('page.subtitle')),

          h(
            'div',
            { className: 'dcw-card' },
            h(
              'div',
              { className: 'dcw-row' },
              h('h3', { className: 'dcw-card-title' }, t('status.heading')),
              h(Button, { onClick: loadStatus, disabled: statusBusy }, statusBusy ? t('status.checking') : t('status.refresh')),
            ),
            statusError === '' ? null : h('div', { className: 'dcw-error' }, t('status.failed', { message: statusError })),
            statusRows,
          ),

          h(
            'div',
            { className: 'dcw-card' },
            h('h3', { className: 'dcw-card-title' }, t('settings.heading')),
            draft === null
              ? h('div', { className: 'dcw-empty' }, t('managed.loading'))
              : h(
                  React.Fragment,
                  null,
                  h(Field, {
                    label: t('field.githubUsername'),
                    hint: t('field.githubUsername.hint'),
                    control: h('input', {
                      className: 'dcw-input',
                      type: 'text',
                      value: draft.githubUsername === undefined || draft.githubUsername === null ? '' : String(draft.githubUsername),
                      spellCheck: false,
                      onChange: (event) => setField('githubUsername', event.target.value),
                    }),
                  }),
                  h(Field, {
                    label: t('field.defaultBranch'),
                    control: h('input', {
                      className: 'dcw-input',
                      type: 'text',
                      value: draft.defaultBranch === undefined || draft.defaultBranch === null ? '' : String(draft.defaultBranch),
                      spellCheck: false,
                      onChange: (event) => setField('defaultBranch', event.target.value),
                    }),
                  }),
                  h(Field, {
                    label: t('field.autoPauseMinutes'),
                    hint: t('field.autoPauseMinutes.hint'),
                    control: h('input', {
                      className: 'dcw-input',
                      type: 'number',
                      min: '0',
                      step: '1',
                      value: String(num(draft.autoPauseMinutes) === Number.MAX_SAFE_INTEGER ? 0 : draft.autoPauseMinutes),
                      onChange: (event) => {
                        const parsed = Number.parseInt(event.target.value, 10)
                        setField('autoPauseMinutes', Number.isFinite(parsed) && parsed > 0 ? parsed : 0)
                      },
                    }),
                  }),
                  h(ToggleRow, {
                    label: t('field.alwaysShowCloudButton'),
                    hint: t('field.alwaysShowCloudButton.hint'),
                    control: h(Switch, {
                      checked: draft.alwaysShowCloudButton === true,
                      label: t('field.alwaysShowCloudButton'),
                      onChange: (next) => setField('alwaysShowCloudButton', next),
                    }),
                  }),
                  h(ToggleRow, {
                    label: t('field.autoInitEmptyRepo'),
                    hint: t('field.autoInitEmptyRepo.hint'),
                    control: h(Switch, {
                      checked: draft.autoInitEmptyRepo === true,
                      label: t('field.autoInitEmptyRepo'),
                      onChange: (next) => setField('autoInitEmptyRepo', next),
                    }),
                  }),
                  h(Field, {
                    label: t('field.readmeContent'),
                    hint: t('field.readmeContent.hint'),
                    control: h('textarea', {
                      className: 'dcw-input',
                      rows: 4,
                      value: draft.readmeContent === undefined || draft.readmeContent === null ? '' : String(draft.readmeContent),
                      onChange: (event) => setField('readmeContent', event.target.value),
                    }),
                  }),
                  h(
                    'div',
                    { className: 'dcw-actions' },
                    h(Button, { variant: 'primary', onClick: commit, disabled: saving || !dirty }, saving ? t('saving') : t('save')),
                    saved && !dirty ? h('span', { className: 'dcw-muted' }, t('saved')) : null,
                  ),
                ),
            saveError === '' ? null : h('div', { className: 'dcw-error' }, t('saveFailed', { message: saveError })),

            h('div', { className: 'dcw-divider' }),
            h(Field, {
              label: t('field.sshKeyPath'),
              hint: t('field.sshKeyPath.hint'),
              control: h(
                'div',
                { className: 'dcw-actions' },
                h('span', { className: 'dcw-tag' }, secretSet ? t('field.sshKeyPath.set') : t('field.sshKeyPath.unset')),
                h('input', {
                  className: 'dcw-input',
                  style: { flex: 1, minWidth: 160 },
                  type: 'password',
                  autoComplete: 'off',
                  placeholder: t('field.sshKeyPath.write'),
                  value: secretDraft,
                  onChange: (event) => setSecretDraft(event.target.value),
                }),
                h(Button, { onClick: () => writeSecret(secretDraft), disabled: secretBusy || secretDraft === '' }, t('field.sshKeyPath.save')),
                secretSet
                  ? h(Button, { variant: 'ghost', onClick: () => writeSecret(''), disabled: secretBusy }, t('field.sshKeyPath.clear'))
                  : null,
              ),
            }),
          ),

          managedCard,
        )
      }

      return SettingsSection
    }

    /* ------------------------------------------------------------------ *
     * 9. The single multi-step window (create flow) and the delete confirm
     * ------------------------------------------------------------------ */

    /**
     * The create flow. Internal steps only — `repo` → `codespace` → `machine` →
     * `apply` → `done`. Reused by the sidebar launcher and by the settings page.
     */
    function createNewWorkspaceWindow(deps) {
      const { store, ui, t, locale } = deps

      function CreateFlow(props) {
        useLocaleTick(locale)
        const snapshot = useStoreState(store, false)
        const [step, setStep] = React.useState('repo')
        const [repos, setRepos] = React.useState(null)
        const [reposError, setReposError] = React.useState('')
        const [query, setQuery] = React.useState('')
        const [repo, setRepo] = React.useState(null)
        const [codespaces, setCodespaces] = React.useState(null)
        const [codespacesError, setCodespacesError] = React.useState('')
        const [selected, setSelected] = React.useState(null)
        const [createNew, setCreateNew] = React.useState(false)
        const [prebuild, setPrebuild] = React.useState(undefined)
        const [prebuildAcknowledged, setPrebuildAcknowledged] = React.useState(false)
        const [machines, setMachines] = React.useState(null)
        const [machinesError, setMachinesError] = React.useState('')
        const [machine, setMachine] = React.useState(null)
        const [stage, setStage] = React.useState('')
        const [failure, setFailure] = React.useState('')
        const [created, setCreated] = React.useState(null)
        const [opening, setOpening] = React.useState(false)
        const [openHint, setOpenHint] = React.useState('')
        const alive = React.useRef(true)
        const retryRef = React.useRef(null)

        React.useEffect(() => {
          alive.current = true
          store.loadSettings().catch(() => {})
          return () => {
            alive.current = false
            if (retryRef.current !== null) clearTimeout(retryRef.current)
          }
        }, [])

        const loadRepos = React.useCallback(() => {
          setRepos(null)
          setReposError('')
          rpc(ACTIONS.LIST_REPOS)
            .then((data) => {
              if (alive.current) setRepos(Array.isArray(data.repos) ? data.repos : [])
            })
            .catch((error) => {
              if (!alive.current) return
              setRepos([])
              setReposError(messageOf(error))
            })
        }, [])

        React.useEffect(() => {
          loadRepos()
        }, [loadRepos])

        const settings = snapshot.settings === null ? SETTINGS_DEFAULTS : snapshot.settings
        const branch = typeof settings.defaultBranch === 'string' && settings.defaultBranch !== '' ? settings.defaultBranch : 'main'
        const autoInit = settings.autoInitEmptyRepo === true

        /** Step 2: resolve the Codespace for the chosen repository. */
        function chooseRepo(next) {
          setRepo(next)
          setSelected(null)
          setCreateNew(false)
          setCodespaces(null)
          setCodespacesError('')
          setStep('codespace')
          rpc(ACTIONS.LIST_CODESPACES, { repo: next.nameWithOwner })
            .then((data) => {
              if (!alive.current) return
              const list = Array.isArray(data.codespaces) ? data.codespaces : []
              setCodespaces(list)
              // Several → the user picks; exactly one → use it; none → create.
              if (list.length === 1) setSelected(list[0])
              if (list.length === 0) setCreateNew(true)
            })
            .catch((error) => {
              if (!alive.current) return
              setCodespaces([])
              setCodespacesError(messageOf(error))
              setCreateNew(true)
            })
        }

        /** Step 3: machine choice, and the prebuild notice for a new Codespace. */
        function goToMachine() {
          setStep('machine')
          setPrebuild(undefined)
          setPrebuildAcknowledged(false)
          setMachines(null)
          setMachinesError('')
          setMachine(null)
          rpc(ACTIONS.PREBUILD, { repo: repo.nameWithOwner })
            .then((data) => {
              if (!alive.current) return
              // VERIFY: `hasPrebuild` is `boolean | null`; `null` means "could not
              // determine", which docs/CONTRACT.md §3 says to treat as "no prebuild"
              // — the safe branch, because it only costs a notice.
              setPrebuild(data.hasPrebuild === true ? true : false)
            })
            .catch(() => {
              if (alive.current) setPrebuild(false)
            })
          rpc(ACTIONS.MACHINES, { repo: repo.nameWithOwner })
            .then((data) => {
              if (!alive.current) return
              const list = Array.isArray(data.machines) ? data.machines : []
              setMachines(list)
              setMachine(smallestMachine(list))
            })
            .catch((error) => {
              if (!alive.current) return
              setMachines([])
              setMachinesError(messageOf(error))
            })
        }

        /** Step 4: run the sequence, then register the DSH workspace. */
        async function apply() {
          setStep('apply')
          setFailure('')
          setCreated(null)
          try {
            let cs = createNew ? null : selected
            if (cs === null) {
              setStage(t('apply.creating'))
              const data = await rpc(ACTIONS.CREATE, {
                repo: repo.nameWithOwner,
                branch,
                machine: machine === null ? undefined : machine.name,
              })
              cs = data.codespace
            } else if (phaseOf({ codespace: cs }) === 'stopped' || phaseOf({ codespace: cs }) === 'error') {
              setStage(t('apply.starting'))
              const data = await rpc(ACTIONS.START, { name: codespaceNameOf({ codespace: cs }) })
              cs = data.codespace
            }
            if (!alive.current) return
            setStage(t('apply.registering'))
            // VERIFY: `create-workspace` takes `{ codespace, title? }`; the
            // Codespace NAME (a string) is sent, which is what every lifecycle
            // action in the same contract uses as its key.
            const registered = await rpc(ACTIONS.CREATE_WORKSPACE, { codespace: codespaceNameOf({ codespace: cs }) })
            if (!alive.current) return
            setCreated(registered.workspace === undefined ? null : registered.workspace)
            setStage('')
            setStep('done')
            store.refresh()
          } catch (error) {
            if (!alive.current) return
            setStage('')
            setFailure(messageOf(error))
          }
        }

        /** "Open a session here": click the host's own new-session button on the
         * row. VERIFY: the workspace UI exposes no public open-session API to
         * other plugins, so the only honest route is the host's own control. The
         * row appears only after the sidebar re-renders, hence the bounded retry. */
        function openSession() {
          const workspaceId = created === null || created === undefined ? '' : String(created.workspaceId)
          setOpening(true)
          setOpenHint('')
          let attempts = 0
          const attempt = () => {
            if (!alive.current) return
            attempts += 1
            const row = workspaceId === '' ? null : document.querySelector('[data-row-key="workspace:' + workspaceId + '"]')
            const actions = row === null ? null : row.querySelector('[class*="_rowActions"]')
            const buttons = actions === null ? [] : actions.querySelectorAll('button')
            const target = buttons.length === 0 ? null : buttons[buttons.length - 1]
            if (target !== null) {
              target.click()
              setOpening(false)
              props.onClose()
              return
            }
            store.refresh()
            if (attempts >= 8) {
              setOpening(false)
              setOpenHint(t('success.openFailed'))
              return
            }
            retryRef.current = setTimeout(attempt, 500)
          }
          attempt()
        }

        const filtered = React.useMemo(() => {
          const list = repos === null ? [] : repos
          const needle = query.trim().toLowerCase()
          if (needle === '') return list
          return list.filter((entry) => String(entry.nameWithOwner).toLowerCase().indexOf(needle) >= 0)
        }, [repos, query])

        /* ---- step bodies ---- */

        const head = h(
          'div',
          { className: 'dcw-window-head' },
          h(
            'div',
            { className: 'dcw-stack' },
            h('h2', { className: 'dcw-title' }, t('window.title')),
            h(Steps, { t, active: step === 'repo' ? 0 : step === 'codespace' ? 1 : step === 'machine' ? 2 : 3 }),
          ),
          h(Button, { variant: 'ghost', onClick: props.onClose, 'aria-label': t('close'), title: t('close') }, '✕'),
        )

        if (step === 'repo') {
          return h(
            React.Fragment,
            null,
            head,
            h('input', {
              className: 'dcw-input',
              type: 'search',
              placeholder: t('repo.search'),
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            reposError === '' ? null : h('div', { className: 'dcw-error' }, t('repo.failed', { message: reposError })),
            repos === null
              ? h('div', { className: 'dcw-empty' }, t('repo.loading'))
              : filtered.length === 0
                ? h('div', { className: 'dcw-empty' }, t('repo.empty'))
                : h(
                    'div',
                    { className: 'dcw-list' },
                    filtered.map((entry) =>
                      h(Choice, {
                        key: String(entry.nameWithOwner),
                        title: String(entry.nameWithOwner),
                        tag: entry.isPrivate === true ? t('repo.private') : undefined,
                        meta: [
                          entry.isEmpty === true ? h('span', { key: 'e' }, t('repo.isEmpty')) : null,
                          h('span', { key: 'b' }, String(entry.defaultBranch === undefined || entry.defaultBranch === null ? branch : entry.defaultBranch)),
                        ].filter(Boolean),
                        selected: false,
                        onClick: () => chooseRepo(entry),
                      }),
                    ),
                  ),
            h(
              'div',
              { className: 'dcw-window-foot' },
              repos === null ? null : h('span', { className: 'dcw-muted' }, t('repo.count', { n: filtered.length })),
              h(Button, { onClick: props.onClose }, t('cancel')),
            ),
          )
        }

        if (step === 'codespace') {
          const list = codespaces === null ? [] : codespaces
          const showNotice = !createNew && list.length === 0
          return h(
            React.Fragment,
            null,
            head,
            h('div', { className: 'dcw-label' }, String(repo === null ? '' : repo.nameWithOwner)),
            codespacesError === '' ? null : h('div', { className: 'dcw-error' }, t('cs.failed', { message: codespacesError })),
            codespaces === null
              ? h('div', { className: 'dcw-empty' }, t('cs.loading'))
              : h(
                  React.Fragment,
                  null,
                  h('h3', { className: 'dcw-card-title' }, list.length === 0 ? t('cs.none') : list.length === 1 ? t('cs.heading') : t('cs.pick')),
                  h(
                    'div',
                    { className: 'dcw-list' },
                    list.map((entry) =>
                      h(Choice, {
                        key: String(entry.name),
                        title: String(entry.displayName === undefined || entry.displayName === null || entry.displayName === '' ? entry.name : entry.displayName),
                        meta: [h('span', { key: 's' }, t('cs.state', { state: String(entry.state === undefined ? 'unknown' : entry.state) }))],
                        detail: String(entry.name),
                        selected: createNew ? false : selected !== null && selected.name === entry.name,
                        onClick: () => {
                          setCreateNew(false)
                          setSelected(entry)
                        },
                      }),
                    ),
                    showNotice || createNew
                      ? h(Choice, {
                          title: t('cs.createNew'),
                          selected: createNew,
                          onClick: () => {
                            setCreateNew(true)
                            setSelected(null)
                          },
                        })
                      : null,
                  ),
                ),
            h(
              'div',
              { className: 'dcw-window-foot' },
              h(Button, { onClick: () => setStep('repo') }, t('back')),
              h(Button, { onClick: props.onClose }, t('cancel')),
              h(
                Button,
                {
                  variant: 'primary',
                  disabled: codespaces === null || (!createNew && selected === null),
                  onClick: () => (createNew ? goToMachine() : apply()),
                },
                t('next'),
              ),
            ),
          )
        }

        if (step === 'machine') {
          const list = machines === null ? [] : machines
          const needsNotice = prebuild !== true && !prebuildAcknowledged
          return h(
            React.Fragment,
            null,
            head,
            h('h3', { className: 'dcw-card-title' }, t('machine.heading')),
            repo !== null && repo.isEmpty === true ? h('div', { className: 'dcw-notice', 'data-tone': 'warn' }, autoInit ? t('seed.note') : t('seed.note.off')) : null,
            prebuild === undefined
              ? h('div', { className: 'dcw-empty' }, t('prebuild.checking'))
              : needsNotice
                ? h(
                    'div',
                    { className: 'dcw-notice', 'data-tone': 'warn' },
                    h('div', null, t('prebuild.missing')),
                    h(
                      'div',
                      { className: 'dcw-actions', style: { marginTop: 8 } },
                      h(Button, { onClick: () => setStep('codespace') }, t('prebuild.cancel')),
                      h(Button, { variant: 'primary', onClick: () => setPrebuildAcknowledged(true) }, t('prebuild.proceed')),
                    ),
                  )
                : h('div', { className: 'dcw-notice' }, t('prebuild.ok')),
            machinesError === '' ? null : h('div', { className: 'dcw-error' }, t('machine.failed', { message: machinesError })),
            machines === null
              ? h('div', { className: 'dcw-empty' }, t('machine.loading'))
              : list.length === 0
                ? h('div', { className: 'dcw-empty' }, t('machine.empty'))
                : h(
                    'div',
                    { className: 'dcw-list' },
                    list.map((entry) => {
                      const isDefault = machine !== null && machine.name === entry.name
                      const meta = []
                      if (Number.isFinite(Number(entry.cpus))) meta.push(h('span', { key: 'c' }, t('machine.cpus', { n: entry.cpus })))
                      if (Number.isFinite(Number(entry.memoryGb))) meta.push(h('span', { key: 'm' }, t('machine.memory', { n: entry.memoryGb })))
                      if (Number.isFinite(Number(entry.storageGb))) meta.push(h('span', { key: 's' }, t('machine.storage', { n: entry.storageGb })))
                      if (entry.gpu === true) meta.push(h('span', { key: 'g' }, t('machine.gpu')))
                      return h(Choice, {
                        key: String(entry.name),
                        title: String(entry.displayName === undefined || entry.displayName === null || entry.displayName === '' ? entry.name : entry.displayName),
                        tag: isDefault ? t('machine.default') : undefined,
                        tagTone: isDefault ? 'business' : undefined,
                        meta,
                        detail: String(entry.name),
                        selected: isDefault,
                        onClick: () => setMachine(entry),
                      })
                    }),
                  ),
            h(
              'div',
              { className: 'dcw-window-foot' },
              h(Button, { onClick: () => setStep('codespace') }, t('back')),
              h(Button, { onClick: props.onClose }, t('cancel')),
              h(Button, { variant: 'primary', disabled: machine === null || needsNotice, onClick: apply }, t('next')),
            ),
          )
        }

        if (step === 'apply') {
          return h(
            React.Fragment,
            null,
            head,
            failure === ''
              ? h(
                  'div',
                  { className: 'dcw-row' },
                  h('span', { className: 'dcw-spin' }),
                  h('span', null, stage === '' ? t('apply.creating') : stage),
                )
              : h(
                  React.Fragment,
                  null,
                  h('div', { className: 'dcw-error' }, t('apply.failed', { message: failure })),
                  h(
                    'div',
                    { className: 'dcw-window-foot' },
                    h(Button, { onClick: props.onClose }, t('cancel')),
                    h(Button, { variant: 'primary', onClick: apply }, t('retry')),
                  ),
                ),
            failure === '' && stage === t('apply.creating') ? h('div', { className: 'dcw-muted' }, t('apply.creatingHint')) : null,
            failure === ''
              ? h('div', { className: 'dcw-window-foot' }, h(Button, { onClick: props.onClose }, t('cancel')))
              : null,
          )
        }

        return h(
          React.Fragment,
          null,
          head,
          h('h3', { className: 'dcw-card-title' }, t('success.title')),
          h('div', { className: 'dcw-muted' }, t('success.body')),
          created === null ? null : h('div', { className: 'dcw-mono' }, String(created.title === undefined ? codespaceLabelOf(created) : created.title)),
          openHint === '' ? null : h('div', { className: 'dcw-notice', 'data-tone': 'warn' }, openHint),
          h(
            'div',
            { className: 'dcw-window-foot' },
            created === null ? null : h(Button, { onClick: openSession, disabled: opening }, opening ? t('success.opening') : t('success.open')),
            h(Button, { variant: 'primary', onClick: props.onClose }, t('success.done')),
          ),
        )
      }

      return CreateFlow
    }

    /** The irreversible delete, confirmed in our own overlay. */
    function createDeleteDialog(deps) {
      const { ui, store, t, locale } = deps

      function DeleteDialog(props) {
        useLocaleTick(locale)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState('')
        const alive = React.useRef(true)
        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])

        const target = props.target
        function confirm() {
          if (target.codespaceName === '') {
            setError(t('delete.failed', { message: 'missing codespace name' }))
            return
          }
          setBusy(true)
          setError('')
          rpc(ACTIONS.REMOVE, { name: target.codespaceName })
            .then(() => {
              if (!alive.current) return
              setBusy(false)
              store.refresh()
              props.onClose()
            })
            .catch((failure) => {
              if (!alive.current) return
              setBusy(false)
              setError(t('delete.failed', { message: messageOf(failure) }))
            })
        }

        return h(
          React.Fragment,
          null,
          h('h2', { className: 'dcw-title' }, t('delete.title')),
          h('div', { className: 'dcw-muted' }, t('delete.body', { name: target.label === '' ? target.codespaceName : target.label })),
          error === '' ? null : h('div', { className: 'dcw-error' }, error),
          h(
            'div',
            { className: 'dcw-window-foot' },
            h(Button, { onClick: props.onClose, disabled: busy }, t('cancel')),
            h(Button, { variant: 'danger', onClick: confirm, disabled: busy }, busy ? t('delete.working') : t('delete.confirm')),
          ),
        )
      }

      return DeleteDialog
    }

    /* ------------------------------------------------------------------ *
     * 10. Workspace-row augmentation (the DOM patch)
     *
     * The workspace row has no slot (docs/CONTRACT.md §2 "verified negative
     * finding"), so this is the `dsh-pet` technique applied to the sidebar:
     * observe, inject our own tagged nodes, never touch a React-owned one.
     * ------------------------------------------------------------------ */

    /** Marker attributes — everything this module adds is findable and undoable. */
    const ATTR = {
      row: 'data-dsh-codespace-row',
      always: 'data-dsh-codespace-always',
      icon: 'data-dsh-codespace-icon',
      action: 'data-dsh-codespace-action',
      glyph: 'data-dsh-codespace-glyph',
      glyphKind: 'data-dsh-codespace-glyph-kind',
      for: 'data-dsh-codespace-for',
      path: 'data-dsh-codespace-path',
      original: 'data-dsh-codespace-original',
      menu: 'data-dsh-codespace-menu',
      menuItem: 'data-dsh-codespace-menu-item',
      menuSeparator: 'data-dsh-codespace-menu-separator',
      header: 'data-dsh-codespace-header',
      launcher: 'data-dsh-codespace-launcher',
      style: 'data-dsh-codespace-style',
    }

    /** `data-row-key` prefix used by the workspace row (observed at L1287). */
    const ROW_KEY_PREFIX = 'workspace:'

    /** Set while this module is mutating the DOM, so the observer can ignore itself. */
    let mutating = false

    /** Run `fn` with the self-mutation guard up, reporting whether it changed anything. */
    function mutate(fn) {
      mutating = true
      try {
        fn()
      } finally {
        mutating = false
      }
    }

    /** Inline SVG cloud for the row marker (the row is not React-rendered by us). */
    function cloudNode() {
      const NS = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(NS, 'svg')
      // The same spec as `CloudIcon`, so the two renderers cannot drift.
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('xmlns', NS)
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('stroke-width', ICON_STROKE_WIDTH)
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', CLOUD_PATH)
      path.setAttribute('stroke', 'currentColor')
      svg.appendChild(path)
      return svg
    }

    /**
     * Install the row augmentation.
     *
     * @param {object} deps - `{ store, ui, t }`.
     * @returns {() => void} the disposer: removes every node, attribute and observer.
     */
    function installRowAugmentation(deps) {
      const { store, ui, t } = deps
      const doc = typeof document === 'undefined' ? undefined : document
      const Observer = typeof MutationObserver === 'undefined' ? undefined : MutationObserver
      if (doc === undefined || doc.body === null) {
        console.warn('[dsh-codespace-workspace] sidebar augmentation unavailable: no document.body')
        return () => {}
      }

      /** Workspace ids with an in-flight click, so the button shows a spinner. */
      const pending = new Set()
      /** Deferred single clicks, keyed by workspace id (a double-click cancels one). */
      const clickTimers = new Map()
      let warnedMissingActions = false
      let queued = false
      let observer = null
      let active = true

      /** Records by workspace id, from the last poll. */
      function managedIndex() {
        const list = store.getState().workspaces
        const map = new Map()
        if (Array.isArray(list)) {
          for (const record of list) {
            if (record !== null && typeof record === 'object' && record.workspaceId !== undefined) {
              map.set(String(record.workspaceId), record)
            }
          }
        }
        return map
      }

      /** The workspace id a row stands for, or `null` when the row is not ours. */
      function workspaceIdOfRow(row) {
        const key = row.getAttribute('data-row-key')
        if (typeof key !== 'string' || key.indexOf(ROW_KEY_PREFIX) !== 0) return null
        const id = key.slice(ROW_KEY_PREFIX.length)
        return id === '' ? null : id
      }

      /** Paint the button for the record's current state. */
      function paintButton(button, record) {
        const phase = phaseOf(record)
        // Two different "busy" notions. `pending` (an RPC in flight, or the host
        // reporting one) disables the control. `armed` (a single click waiting out
        // the double-click window) only shows the spinner: disabling the button
        // there would swallow the second click and with it the double-click.
        const inFlight = isBusy(record, pending)
        const armed = clickTimers.has(button.getAttribute(ATTR.for))
        const busy = inFlight || armed
        const remaining = countdownMsOf(record)
        let kind
        let label
        if (busy) {
          kind = 'pending'
          label = t('row.pending')
        } else if (phase === 'running' && remaining > 0) {
          kind = 'countdown'
          const minutes = Math.max(1, Math.ceil(remaining / 60000))
          label = t('row.countdown', { n: minutes })
        } else if (phase === 'running') {
          kind = 'stop'
          label = t('row.stop')
        } else if (phase === 'error') {
          kind = 'error'
          label = t('row.error', { state: codespaceStateOf(record) })
        } else {
          kind = 'start'
          label = t('row.start')
        }

        const previous = button.getAttribute(ATTR.glyphKind)
        if (previous !== kind) {
          button.setAttribute(ATTR.glyphKind, kind)
          while (button.firstChild !== null) button.removeChild(button.firstChild)
          if (kind === 'pending') {
            const spinner = doc.createElement('span')
            spinner.className = 'dcw-spin'
            spinner.setAttribute('aria-hidden', 'true')
            button.appendChild(spinner)
          } else {
            const glyph = doc.createElement('span')
            glyph.setAttribute(ATTR.glyph, '')
            glyph.setAttribute('aria-hidden', 'true')
            glyph.textContent = kind === 'stop' ? '⏸️' : kind === 'countdown' ? '🕐' : kind === 'error' ? '⚠️' : '▶️'
            button.appendChild(glyph)
          }
        }
        button.disabled = inFlight
        button.setAttribute('aria-label', label)
        button.title = label
      }

      /** One lifecycle click; the button is disabled while it is in flight. */
      function act(workspaceId, record, action) {
        const name = codespaceNameOf(record)
        if (name === '') return
        pending.add(workspaceId)
        repaint(workspaceId)
        rpc(action, { name })
          .then(() => {
            pending.delete(workspaceId)
            store.refresh()
            repaint(workspaceId)
          })
          .catch((error) => {
            pending.delete(workspaceId)
            console.warn('[dsh-codespace-workspace] ' + action + ' failed: ' + messageOf(error))
            repaint(workspaceId)
          })
      }

      /**
       * Open the double-click window for one workspace: show the spinner, and
       * when the window closes without a second click, perform the single-click
       * action.
       *
       * The action is re-derived from the CURRENT record rather than captured
       * when the window opened, because the poll can land in between (the
       * Codespace may have reached `Available`, or a countdown may have started)
       * and acting on the stale intent would be wrong. A record that has since
       * become busy is dropped: something else is already driving it.
       */
      function beginClickWindow(workspaceId) {
        repaint(workspaceId)
        return setTimeout(() => {
          clickTimers.delete(workspaceId)
          const current = managedIndex().get(workspaceId)
          if (current === undefined || isBusy(current, pending)) {
            repaint(workspaceId)
            return
          }
          const intent = clickIntent(current)
          if (intent === null || intent.defer !== true) {
            repaint(workspaceId)
            return
          }
          act(workspaceId, current, intent.action)
        }, CLICK_WINDOW_MS)
      }

      /**
       * What one click on the row button means in the record's current state.
       *
       * `defer` is a flag, not a duration: a running Codespace's button carries
       * two meanings (one click pauses, two pause immediately), so its action
       * waits out `CLICK_WINDOW_MS` for a possible second click. Everything else
       * acts at once. The deferred action is re-derived when the window closes
       * (see `beginClickWindow`), so it is the flag — not a captured action —
       * that has to survive.
       *
       * @returns {{ action: string, defer: boolean } | null}
       */
      function clickIntent(record) {
        const phase = phaseOf(record)
        if (phase === 'running') {
          if (countdownMsOf(record) > 0) return { action: ACTIONS.PAUSE_CANCEL, defer: false }
          return { action: ACTIONS.STOP, defer: true }
        }
        if (phase === 'stopped' || phase === 'error') return { action: ACTIONS.START, defer: false }
        return null
      }

      /** Re-read the record and repaint just that row's button. */
      function repaint(workspaceId) {
        const record = managedIndex().get(workspaceId)
        const row = doc.querySelector('[data-row-key="' + ROW_KEY_PREFIX + workspaceId + '"]')
        if (record === undefined || row === null) return
        const button = row.querySelector('[' + ATTR.action + ']')
        if (button === null) return
        mutate(() => paintButton(button, record))
      }

      /**
       * Patch one managed row.
       *
       * OBSERVED ORDER (dsh-client-ui-workspace/lib/client.js `ProjectRowItem`,
       * ≈L1314–1359): the `rowActions` container holds exactly two children —
       * `[ Menu(ellipsis → rename/delete), Tooltip > button(new session) ]`. The
       * ellipsis is therefore the FIRST child and the new-session button the LAST,
       * so "third from last, before the ellipsis" means: insert as the new first
       * child of `rowActions`. The container is checked to hold exactly two
       * elements first; a row that does not match is skipped untouched.
       */
      function patchRow(row, workspaceId, record) {
        mutate(() => {
          if (row.getAttribute(ATTR.row) === null) row.setAttribute(ATTR.row, '')

          // (a) Leading cloud marker. The host's own folder span is `display:none`
          // in both the collapsed and the hovered state (`.hIlkoa_folder{display:none}`
          // and `.hIlkoa_projectRow:hover .hIlkoa_folder{display:none}`), so there is
          // no visible folder icon to replace: the marker is simply added as the
          // row's first child, with the host's `.slot` metrics copied. The glyph is
          // fixed and never varies with the Codespace state.
          if (row.querySelector('[' + ATTR.icon + ']') === null) {
            const icon = doc.createElement('span')
            icon.setAttribute(ATTR.icon, '')
            icon.setAttribute('aria-hidden', 'true')
            icon.title = t('row.cloud')
            icon.appendChild(cloudNode())
            row.insertBefore(icon, row.firstElementChild)
          }

          // (b) The action button, first child of `rowActions`.
          const actions = row.querySelector('[class*="' + ROW_ACTIONS_SUFFIX + '"]')
          if (actions === null) {
            if (!warnedMissingActions) {
              warnedMissingActions = true
              console.warn('[dsh-codespace-workspace] no [class*="' + ROW_ACTIONS_SUFFIX + '"] container in the workspace row; the row button is not installed')
            }
            return
          }
          let button = actions.querySelector(':scope > [' + ATTR.action + ']')
          // The guard counts the HOST's controls only: once ours is in place the
          // container legitimately holds three children, and re-checking against
          // two would skip every later repaint of that row.
          const hostChildren = actions.children.length - (button === null ? 0 : 1)
          if (hostChildren !== 2) {
            // Not the layout this build was written against; leave the row alone.
            return
          }
          if (button === null) {
            button = doc.createElement('button')
            button.type = 'button'
            button.setAttribute(ATTR.action, '')
            // Click behaviour. A single click is deliberately deferred for a
            // running Codespace (see `clickIntent`), so the first `click` of a
            // double-click only arms the spinner and the second cancels the timer
            // and pauses immediately instead. Cancelling a running countdown is
            // immediate, because a double-click there has nothing else to mean.
            button.addEventListener('click', (event) => {
              event.stopPropagation()
              event.preventDefault()
              const id = button.getAttribute(ATTR.for)
              const current = managedIndex().get(id)
              if (current === undefined) return
              const intent = clickIntent(current)
              if (intent === null) return
              if (intent.defer !== true) {
                act(id, current, intent.action)
                return
              }
              if (clickTimers.has(id)) return
              clickTimers.set(id, beginClickWindow(id))
              repaint(id)
            })
            button.addEventListener('dblclick', (event) => {
              event.stopPropagation()
              event.preventDefault()
              const id = button.getAttribute(ATTR.for)
              const current = managedIndex().get(id)
              if (current === undefined) return
              // "Double-click the clock" (a running row) means pause it NOW.
              // The guard is the phase, NOT the remaining countdown: the first
              // click of this double-click has already fired `pause-cancel` when
              // a countdown was running (that action is immediate by design), so
              // by the time this handler runs the remaining time can already be
              // zero — guarding on it would silently drop the double-click.
              if (phaseOf(current) !== 'running') return
              const timer = clickTimers.get(id)
              if (timer !== undefined) {
                clearTimeout(timer)
                clickTimers.delete(id)
              }
              act(id, current, ACTIONS.PAUSE_NOW)
            })
            actions.insertBefore(button, actions.firstElementChild)
          }
          button.setAttribute(ATTR.for, workspaceId)
          paintButton(button, record)

          // (c) `alwaysShowCloudButton`. OBSERVED: `rowActions` is `display:none`
          // unless the row is hovered or carries the `menuOpen` class, and a
          // `display:none` ancestor cannot be overridden from a descendant — so the
          // container is revealed, not just our button. The marker attribute is on
          // the row, so only managed rows are affected.
          const always = store.getState().settings !== null && store.getState().settings.alwaysShowCloudButton === true
          if (always) {
            if (row.getAttribute(ATTR.always) === null) row.setAttribute(ATTR.always, '')
          } else if (row.getAttribute(ATTR.always) !== null) {
            row.removeAttribute(ATTR.always)
          }
        })
      }

      /**
       * Rewrite the hover card's location line.
       *
       * The card is a portal on `document.body`, so it has no row ancestor to read
       * an id from. VERIFY: it is matched by its location text instead — the raw
       * `Managed.path` (normalized, trailing slash removed, and either side of a
       * `~` home abbreviation) first, then, only when exactly one managed record
       * carries that DSH title, by the card's title line. This is not row identity
       * (the row still matches on `data-row-key`); it only decides which card shows
       * which Codespace name. Unmatched cards are left exactly as the host drew
       * them. Only the text of the location element is rewritten; the node, its
       * class and its neighbours are untouched, and the original text is stashed so
       * the disposer can put it back.
       */
      function patchHoverCard(card, records) {
        const pathEl = card.querySelector('[class*="' + HOVER_PATH_SUFFIX + '"]')
        if (pathEl === null) return
        const raw = pathEl.textContent === null ? '' : pathEl.textContent
        const record = matchRecordByPath(raw, records) || matchRecordByTitle(card, records)
        if (record === null) return
        const wanted = codespaceLabelOf(record)
        if (wanted === '') return
        mutate(() => {
          if (pathEl.getAttribute(ATTR.original) === null) pathEl.setAttribute(ATTR.original, raw)
          if (pathEl.getAttribute(ATTR.path) === null) pathEl.setAttribute(ATTR.path, '')
          if (pathEl.textContent !== wanted) pathEl.textContent = wanted
        })
      }

      /** Normalize a displayed path for comparison. */
      function normalizePath(text) {
        return String(text === null || text === undefined ? '' : text).trim().replace(/\\/g, '/').replace(/\/+$/, '')
      }

      /** Match a hover-card location line against the managed records. */
      function matchRecordByPath(text, records) {
        const shown = normalizePath(text)
        if (shown === '') return null
        const bare = shown.charAt(0) === '~' ? shown.slice(1) : shown
        for (const record of records) {
          const path = normalizePath(record.path)
          if (path === '') continue
          if (path === shown || path === bare) return record
          if (bare.charAt(0) === '/' && path.length > bare.length && path.slice(path.length - bare.length) === bare) return record
        }
        return null
      }

      /** Fallback: a title that is unique among the managed records. */
      function matchRecordByTitle(card, records) {
        const titleEl = card.querySelector('[class*="_hoverTitle"]')
        if (titleEl === null) return null
        const title = String(titleEl.textContent === null ? '' : titleEl.textContent).trim()
        if (title === '') return null
        let found = null
        for (const record of records) {
          if (String(record.title === undefined ? '' : record.title).trim() !== title) continue
          if (found !== null) return null
          found = record
        }
        return found
      }

      /**
       * Append our row to the host's portaled workspace menu.
       *
       * OBSERVED: the row whose menu is open carries the CSS-module class
       * `.<hash>_menuOpen` (`clsx(projectRow, menuOpen && Rows_module_css_default.menuOpen)`
       * at L1286, and the same class in the reveal rule), and the open list is a
       * `role="menu"` element portaled onto `document.body` by the Menu primitive.
       * Requiring an open `_menuOpen` row is what ties the menu to *our* row rather
       * than to any other menu on the page. The host's own rows are never modified;
       * our row is appended after them and separated by a hairline.
       *
       * VERIFY: if a future build stops marking the open row with `_menuOpen`, no
       * menu is patched. The documented fallback is the settings page's "Cloud
       * workspaces" list, whose 删除 Codespace… button opens the same confirmation
       * overlay — the note under that list says so.
       */
      function patchMenu(records) {
        const openRow = doc.querySelector('[data-row-key^="' + ROW_KEY_PREFIX + '"][class*="' + MENU_OPEN_SUFFIX + '"]')
        if (openRow === null) return
        const workspaceId = workspaceIdOfRow(openRow)
        if (workspaceId === null) return
        const record = records.get(workspaceId)
        if (record === undefined) return
        const menus = doc.querySelectorAll('[role="menu"]')
        if (menus.length === 0) return
        const menu = menus[menus.length - 1]
        if (menu.getAttribute(ATTR.menu) !== null) return
        const name = codespaceNameOf(record)
        if (name === '') return
        mutate(() => {
          menu.setAttribute(ATTR.menu, '')
          const separator = doc.createElement('div')
          separator.setAttribute(ATTR.menuSeparator, '')
          separator.setAttribute('role', 'separator')
          const item = doc.createElement('button')
          item.type = 'button'
          item.setAttribute('role', 'menuitem')
          item.setAttribute(ATTR.menuItem, '')
          item.textContent = t('menu.delete')
          item.addEventListener('click', (event) => {
            event.stopPropagation()
            event.preventDefault()
            // Close the host's menu first (Escape is the menu's own close
            // command), then raise our confirmation overlay.
            doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
            ui.openDelete({ workspaceId, codespaceName: name, label: codespaceLabelOf(record) })
          })
          menu.appendChild(separator)
          menu.appendChild(item)
        })
      }

      /** Remove everything this module injected into a menu. */
      function cleanMenu(menu) {
        mutate(() => {
          const item = menu.querySelector('[' + ATTR.menuItem + ']')
          if (item !== null && item.parentNode !== null) item.parentNode.removeChild(item)
          const separator = menu.querySelector('[' + ATTR.menuSeparator + ']')
          if (separator !== null && separator.parentNode !== null) separator.parentNode.removeChild(separator)
          menu.removeAttribute(ATTR.menu)
        })
      }

      /**
       * Install the launcher into the workspace section's header icon row.
       *
       * OBSERVED (dsh-client-ui-workspace/lib/client.js, the WorkspaceBrowser
       * component ≈L150370): the section header is
       *
       *   <div class="<hash>_sectionHeader">
       *     {wide && <span class="<hash>_sectionLabel">…</span>}
       *     {wide && <div class="<hash>_searchSlot">…</div>}
       *     <div class="<hash>_headerActions">      <-- gap:4px, max-width:60px
       *       {wide && <ViewOptionsMenu/>}          <-- Tooltip > button.iconButton
       *       {flowAvailable && <Tooltip>           <-- button.iconButton, the "+"
       *         <button class="<hash>_iconButton" aria-label="添加工作区"/>
       *       </Tooltip>}
       *     </div>
       *   </div>
       *
       * The user's requirement is that the new-cloud-workspace control sits in
       * that row as a PEER of those icons, immediately LEFT of 添加工作区, rather
       * than as a separate control elsewhere. So it is inserted as a child of
       * `headerActions`, immediately before the host's own last control.
       *
       * The row is `justify-content:flex-end` with a `flex:1` search slot ahead of
       * it, so the group is right-aligned and our button takes the position that
       * puts it first in that right-hand cluster. It is a real `<button>` styled by
       * `[data-dsh-codespace-launcher]` to the host's `iconButton` metrics, so it
       * inherits the hover, focus and rail behaviour of its peers.
       *
       * A row whose last child is not the "+" control is left untouched: that only
       * happens when the directory flow is unavailable (then the host renders no
       * "+" at all), and in that case the settings page's own button still opens
       * the same window.
       *
       * @returns {boolean} whether a launcher is in place.
       */
      function patchHeader() {
        const headers = doc.querySelectorAll('[class*="' + SECTION_HEADER_SUFFIX + '"]')
        if (headers.length === 0) return false
        // The sidebar can show more than one section header (sessions vs
        // workspaces); only the one carrying the icon row is ours.
        let header = null
        for (const candidate of headers) {
          if (candidate.querySelector('[class*="' + HEADER_ACTIONS_SUFFIX + '"]') !== null) {
            header = candidate
            break
          }
        }
        if (header === null) return false
        const actions = header.querySelector('[class*="' + HEADER_ACTIONS_SUFFIX + '"]')
        if (actions === null) return false

        const existing = actions.querySelector(':scope > [' + ATTR.launcher + ']')
        if (existing !== null) {
          if (existing.parentNode !== actions) return true
          // Keep it immediately left of the host's last control, which is the "+".
          const last = actions.lastElementChild
          if (last !== existing && last !== null) mutate(() => actions.insertBefore(existing, last))
          return true
        }

        const addButton = actions.lastElementChild
        if (addButton === null || addButton.tagName !== 'BUTTON') return false

        mutate(() => {
          const button = doc.createElement('button')
          button.type = 'button'
          button.setAttribute(ATTR.launcher, '')
          button.title = t('launcher.label')
          button.setAttribute('aria-label', t('launcher.label'))
          button.appendChild(cloudNode())
          button.addEventListener('click', (event) => {
            event.stopPropagation()
            event.preventDefault()
            ui.openCreate()
          })
          actions.insertBefore(button, addButton)
          // Marks the container so the CSS above can widen it past the host's
          // three-icon `max-width:60px` without matching any other header.
          actions.setAttribute(ATTR.header, '')
        })
        return true
      }

      /** Remove the header launcher and its marker. */
      function cleanHeader() {
        for (const launcher of doc.querySelectorAll('[' + ATTR.launcher + ']')) {
          if (launcher.parentNode !== null) launcher.parentNode.removeChild(launcher)
        }
        for (const marked of doc.querySelectorAll('[' + ATTR.header + ']')) marked.removeAttribute(ATTR.header)
      }

      /** One coalesced pass over the DOM. Idempotent: it re-derives everything. */
      function sync() {
        if (!active) return
        const records = managedIndex()

        // The header launcher is independent of any managed workspace: it is how
        // the first cloud workspace gets created, so it is installed even when
        // the record list is empty.
        setOwned(patchHeader())

        // Rows: drop the marker from rows that are no longer managed.
        for (const row of doc.querySelectorAll('[' + ATTR.row + ']')) {
          const id = workspaceIdOfRow(row)
          if (id === null || !records.has(id)) {
            mutate(() => {
              const icon = row.querySelector('[' + ATTR.icon + ']')
              if (icon !== null && icon.parentNode !== null) icon.parentNode.removeChild(icon)
              const button = row.querySelector('[' + ATTR.action + ']')
              if (button !== null && button.parentNode !== null) button.parentNode.removeChild(button)
              row.removeAttribute(ATTR.row)
              row.removeAttribute(ATTR.always)
            })
          }
        }

        if (records.size > 0) {
          for (const row of doc.querySelectorAll('[data-row-key^="' + ROW_KEY_PREFIX + '"]')) {
            const id = workspaceIdOfRow(row)
            if (id === null) continue
            const record = records.get(id)
            if (record === undefined) continue
            patchRow(row, id, record)
          }
        }

        // Hover cards live in a portal on document.body, outside any row.
        const list = Array.from(records.values())
        if (list.length > 0) {
          for (const card of doc.querySelectorAll('[class*="_hoverContent"]')) patchHoverCard(card, list)
        }

        // The portaled workspace menu.
        for (const menu of doc.querySelectorAll('[' + ATTR.menu + ']')) {
          const openRow = doc.querySelector('[data-row-key^="' + ROW_KEY_PREFIX + '"][class*="' + MENU_OPEN_SUFFIX + '"]')
          const stillOpen = openRow !== null && records.has(String(workspaceIdOfRow(openRow)))
          if (!stillOpen || menu.isConnected !== true) cleanMenu(menu)
        }
        if (records.size > 0) patchMenu(records)
      }

      /** Coalesce every mutation burst into one microtask. */
      function queue() {
        if (!active || queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          if (!active) return
          sync()
          // Guard against reacting to our own writes: the pass above just made
          // every record that is still pending either our own injection or a
          // mutation this pass has already accounted for, so they are dropped.
          // A later burst — the next poll, the next hover, the next React commit —
          // arrives through `queue()` again.
          if (observer !== null) observer.takeRecords()
        })
      }

      // The store publishes on every poll and after every mutation, so the
      // augmentation re-derives from fresh host data without polling itself.
      const unsubscribe = store.subscribe(() => queue(), false)

      /**
       * The store's owner claim (docs/CONTRACT.md §6): `subscribe(listener, true)`
       * makes the first claimer trigger an immediate refresh and the last one to
       * leave stop the 4 s `workspaces` poll.
       *
       * It is held only while the workspace section is actually rendered. The
       * poll is not free — with at least one managed workspace every tick calls
       * the Codespaces list API — so claiming it from `apply()` would keep
       * hitting GitHub even with the sidebar hidden. Keying on the section
       * header reproduces the lifetime the sidebar-mounted launcher used to
       * have, without depending on a control that may not exist. It is
       * deliberately not keyed on the record list: the records are what the
       * poll produces, so that would be circular.
       */
      let claim = null
      function setOwned(wanted) {
        if (wanted === true && claim === null) {
          claim = store.subscribe(() => {}, true)
          // The row patch reads `alwaysShowCloudButton` out of the store, so the
          // settings have to be loaded by whoever renders the rows. Without this
          // the value stays `null` until the settings page is opened, and the
          // switch silently has no effect on a fresh boot. `loadSettings` is
          // memoized on `settingsLoaded`, so this costs one request per session
          // at most, and a failure is not fatal — the row simply keeps the
          // default (hidden) behaviour.
          store.loadSettings().catch(() => {})
        } else if (wanted !== true && claim !== null) {
          claim()
          claim = null
        }
      }

      sync()
      if (Observer !== undefined) {
        observer = new Observer(() => {
          if (mutating) return
          queue()
        })
        // VERIFY: the hover card is portaled onto document.body, so the observer
        // must cover the whole body rather than only the sidebar subtree. This is
        // the same scope dsh-rewind-plugin uses. The callback is coalesced, the
        // pass is idempotent, and its own records are drained, so the wider scope
        // costs work but cannot loop.
        observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key', 'class'] })
      }

      return () => {
        active = false
        if (observer !== null) {
          observer.disconnect()
          observer = null
        }
        unsubscribe()
        for (const timer of clickTimers.values()) clearTimeout(timer)
        clickTimers.clear()
        cleanHeader()
        for (const row of doc.querySelectorAll('[' + ATTR.row + ']')) {
          const icon = row.querySelector('[' + ATTR.icon + ']')
          if (icon !== null && icon.parentNode !== null) icon.parentNode.removeChild(icon)
          const button = row.querySelector('[' + ATTR.action + ']')
          if (button !== null && button.parentNode !== null) button.parentNode.removeChild(button)
          row.removeAttribute(ATTR.row)
          row.removeAttribute(ATTR.always)
        }
        for (const menu of doc.querySelectorAll('[' + ATTR.menu + ']')) cleanMenu(menu)
        for (const pathEl of doc.querySelectorAll('[' + ATTR.path + ']')) {
          const original = pathEl.getAttribute(ATTR.original)
          if (original !== null && pathEl.textContent !== original) pathEl.textContent = original
          pathEl.removeAttribute(ATTR.path)
          pathEl.removeAttribute(ATTR.original)
        }
        pending.clear()
      }
    }

    /* ------------------------------------------------------------------ *
     * 11. apply()
     * ------------------------------------------------------------------ */

    /**
     * Register every surface. All resources are owned by `ctx.effect`, so plugin
     * unload removes the styles, the observers, the timers and the slots.
     *
     * @param {object} ctx - the Cordis client context.
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const locale = ctx.get('locale')

      if (locale !== undefined && typeof locale.register === 'function') {
        try {
          ctx.effect(() => {
            // VERIFY: `locale.register(ns, {zh, en})` and the older
            // `locale.register(ns, lang, dict)` are both accepted by the builds in
            // this profile (dsh-pet/dsh-keep-awake use one, dsh-mcp-native the
            // other). The object form is tried first and the two-argument form is
            // the fallback.
            let dispose = null
            try {
              dispose = locale.register(LOCALE_NS, { zh: MESSAGES_ZH, en: MESSAGES_EN })
            } catch (error) {
              const first = locale.register(LOCALE_NS, 'zh', MESSAGES_ZH)
              const second = locale.register(LOCALE_NS, 'en', MESSAGES_EN)
              dispose = () => {
                first()
                second()
              }
            }
            return () => {
              if (typeof dispose === 'function') dispose()
            }
          }, 'dsh-codespace-workspace: dictionaries')
        } catch (error) {
          console.warn('[dsh-codespace-workspace] locale registration failed; using the inline zh dictionary', error)
        }
      }

      const t =
        locale !== undefined && typeof locale.bind === 'function'
          ? locale.bind(LOCALE_NS)
          : (key, params) => interpolate(MESSAGES_ZH[key] !== undefined ? MESSAGES_ZH[key] : key, params)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute(ATTR.style, '')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, 'dsh-codespace-workspace: styles')

      const store = createStore(rpc)
      const ui = createUiStore()
      ctx.effect(
        () => () => {
          store.dispose()
          ui.dispose()
        },
        'dsh-codespace-workspace: stores',
      )

      const SettingsSection = createSettingsSection({ store, ui, t, locale })
      const CreateFlow = createNewWorkspaceWindow({ store, ui, t, locale })
      const DeleteDialog = createDeleteDialog({ store, ui, t, locale })

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-codespace-workspace',
            order: 70,
            label: () => t('nav'),
          },
          SettingsSection,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-codespace-workspace',
            order: 900,
          },
          function CodespaceOverlay() {
            useLocaleTick(locale)
            const state = useStoreState(ui, false)
            if (state.del !== null) {
              return h(
                OverlayWindow,
                { label: t('delete.title'), onClose: () => ui.close() },
                h(DeleteDialog, { key: 'del' + String(state.del.seq), target: state.del, onClose: () => ui.close() }),
              )
            }
            if (state.create !== null) {
              return h(
                OverlayWindow,
                { label: t('window.title'), onClose: () => ui.close() },
                h(CreateFlow, { key: 'create' + String(state.create.seq), onClose: () => ui.close() }),
              )
            }
            return null
          },
        ),
      )

      // No `sidebar.footer.action` entry: the launcher lives in the workspace
      // section's own header icon row, as a peer of the host's controls (see
      // `patchHeader`). The store's owner claim — which is what keeps the 4 s
      // `workspaces` poll alive (docs/CONTRACT.md §6) — is held by the row
      // augmentation instead, so the data the sidebar needs is owned by the
      // module that actually renders it, not by a control that may not exist.
      ctx.effect(() => installRowAugmentation({ store, ui, t }), 'dsh-codespace-workspace: sidebar row augmentation')
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
