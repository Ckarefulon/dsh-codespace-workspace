/**
 * Real-browser behavioural harness for the workspace-row DOM augmentation.
 *
 * The client half's row patch is the one part that cannot be verified in Node:
 * it depends on real DOM semantics (attribute reflection, `:hover`-driven CSS,
 * `MutationObserver` coalescing, portal children on `document.body`). The
 * client builder's own jsdom-less shim had gaps, so this runs the real bundle
 * in a real browser against a faithful copy of the host's markup and CSS.
 *
 * It exercises the four button states, the click/double-click protocol, the
 * hover-card rewrite, the injected menu item, the always-show switch, and a
 * full dispose — then reports pass/fail into the page.
 */

const REPORT = []
let failures = 0

function check(cond, label, extra) {
  if (!cond) failures += 1
  REPORT.push(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond || extra === undefined ? '' : ` — ${extra}`}`)
}
function eq(label, got, want) {
  check(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
function section(name) {
  REPORT.push(`\n${name}`)
}

/**
 * Report and stop. Installed as an error handler too, so a throw anywhere below
 * still prints every assertion that ran before it instead of leaving the page
 * blank — a blank page would hide which check actually broke.
 */
let finished = false
function finish() {
  if (finished) return
  finished = true
  document.getElementById('report').innerHTML =
    REPORT.map((line) => line.startsWith('FAIL') ? `<span class="fail">${line}</span>`
      : line.startsWith('ok') ? `<span class="ok">${line}</span>`
        : `<span class="info">${line}</span>`).join('\n')
    + `\n\n${failures === 0 ? '<span class="ok">browser-dom: PASS — every assertion held</span>'
      : `<span class="fail">browser-dom: ${failures} FAILURE(S)</span>`}`
  document.title = failures === 0 ? 'PASS' : 'FAIL ' + failures
  window.__RESULT__ = { failures, report: REPORT }
}
window.addEventListener('error', (event) => {
  check(false, 'UNCAUGHT ERROR — assertions after this point did not run',
    String(event.error?.stack ?? event.message))
  finish()
})
window.addEventListener('unhandledrejection', (event) => {
  check(false, 'UNHANDLED REJECTION — assertions after this point did not run', String(event.reason?.stack ?? event.reason))
  finish()
})

/* ------------------------------------------------------------------ *
 * 0. Accelerate ONLY the poll interval.
 *
 * The store re-reads host state on a 4 s `setTimeout` chain (POLL_MS). Every
 * state transition the harness drives would otherwise cost 4 s of wall clock,
 * so any delay of 2 s or more is shortened to 60 ms. Delays below that — the
 * 260 ms deferred single click and the 320 ms double-click window — are left
 * exactly as they are, because the click protocol is behaviour under test and
 * must not be distorted. This patches the harness's environment only; no
 * product code is touched.
 * ------------------------------------------------------------------ */

const REAL_TIMEOUT = globalThis.setTimeout.bind(globalThis)
globalThis.setTimeout = (fn, ms, ...rest) =>
  REAL_TIMEOUT(fn, typeof ms === 'number' && ms >= 2000 ? 60 : ms, ...rest)

/* ------------------------------------------------------------------ *
 * 1. Load the real bundle through the real loader protocol.
 * ------------------------------------------------------------------ */

let captured = null
window.__ModuleLoader__ = { load: (registration) => { captured = registration } }

const source = await (await fetch('../../lib/client.js')).text()
// eslint-disable-next-line no-new-func
new Function(source)()

check(captured !== null, 'the bundle registered through __ModuleLoader__')
eq('the bundle id is the package name', captured?.id, 'dsh-codespace-workspace')

const React = await import('./react-lite.js').then((m) => m.default)
const exported = captured.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require ' + spec)
})
check(typeof exported.apply === 'function', 'the factory returns apply()')
eq('the client injects exactly ["slots"]', JSON.stringify(exported.inject), '["slots"]')

/* ------------------------------------------------------------------ *
 * 2. A stub host: state the harness mutates, and an RPC that records calls.
 * ------------------------------------------------------------------ */

const HASH = 'hIlkoa_'
const WORKSPACE = 'ws-1'
const CODESPACE = 'my-box'
const PLACEHOLDER = 'C:\\Users\\Vxiao\\.dsh\\codespaces\\my-box'

let record = {
  workspaceId: WORKSPACE,
  title: 'my-box',
  path: PLACEHOLDER,
  codespace: { name: CODESPACE, displayName: 'my-box', state: 'Shutdown' },
  state: 'Shutdown',
  busy: false,
  autoPauseRemainingMs: 0,
}

let settings = {
  githubUsername: 'octocat', defaultBranch: 'main', autoPauseMinutes: 30,
  sshKeyPath: '', alwaysShowCloudButton: false, autoInitEmptyRepo: true, readmeContent: '',
}

const rpcCalls = []
function rpcResponse(body) {
  rpcCalls.push(body.action)
  const ok = (data) => ({ status: 200, ok: true, json: async () => Object.assign({ ok: true }, data) })
  if (body.action === 'workspaces') return ok({ workspaces: [record] })
  if (body.action === 'get-settings') return ok({ settings, secrets: { githubToken: { set: false }, sshKeyPath: { set: false } } })
  if (body.action === 'status') return ok({ gh: { installed: false, version: '', authenticated: false, login: '' }, tokenSource: 'none', configured: false, secrets: {} })
  if (body.action === 'list-repos') return ok({ repos: [], truncated: false })
  if (body.action === 'set-settings') {
    settings = { ...settings, ...body.patch }
    return ok({ settings, secrets: { githubToken: { set: false }, sshKeyPath: { set: false } } })
  }
  if (body.action === 'pause-cancel') { record = { ...record, autoPauseRemainingMs: 0 }; return ok({}) }
  if (body.action === 'pause-now') { record = { ...record, autoPauseRemainingMs: 0, codespace: { ...record.codespace, state: 'ShuttingDown' } }; return ok({}) }
  if (body.action === 'stop') { record = { ...record, codespace: { ...record.codespace, state: 'ShuttingDown' } }; return ok({ codespace: record.codespace }) }
  if (body.action === 'start') { record = { ...record, codespace: { ...record.codespace, state: 'Starting' } }; return ok({ codespace: record.codespace }) }
  return ok({})
}
globalThis.__DSH_TRANSPORT__ = { fetch: async (_url, init) => rpcResponse(JSON.parse(init.body)) }

/* ------------------------------------------------------------------ *
 * 3. Apply the bundle to a Cordis-shaped context.
 * ------------------------------------------------------------------ */

const registrations = []
const effects = []
const ctx = {
  slots: {
    inject: (key, fn) => { registrations.push({ key, fn }); return () => {} },
    register: (options, component) => ({ options, component }),
    getVersion: () => 0,
    subscribe: () => () => {},
  },
  get: (name) => (name === 'slots' ? ctx.slots : undefined),
  effect: (fn) => { const d = fn(); effects.push(d); return () => { if (typeof d === 'function') d() } },
  on: () => () => {},
  locale: undefined,
}

exported.apply(ctx)
eq('two slots were injected', registrations.length, 2)
eq('the slot keys are the documented two',
  JSON.stringify(registrations.map((r) => r.key)),
  JSON.stringify(['settings.section', 'shell.overlay']))

/**
 * Mount a registered slot's component, as the shell would.
 *
 * The overlay must be mounted for the launcher click to mean anything: the
 * bundle has ONE `shell.overlay` entry that reads the UI store, so without a
 * consumer `ui.openCreate()` would only change state nothing observes.
 */
function mountSlot(key, props) {
  const registration = registrations.find((r) => r.key === key)
  if (registration === undefined) throw new Error('no registration for ' + key)
  return React.mount(registration.fn().component, props ?? {})
}

const overlay = mountSlot('shell.overlay')

/** Wait for the poll, the microtask-coalesced sync, and a paint. */
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait until `predicate()` is true, or give up.
 *
 * Fixed sleeps are the wrong tool here: the store only adopts new host state on
 * its next poll, and the poll is a real timer chain whose completion is not
 * synchronized with the harness's own awaits. Every state transition below is
 * therefore awaited on the OBSERVABLE consequence instead of on a guessed
 * duration. A timeout is reported as a failure, never silently ignored.
 *
 * @returns {Promise<boolean>} whether the predicate became true.
 */
async function until(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let hit = false
    try { hit = predicate() === true } catch (error) { hit = false }
    if (hit) return true
    if (Date.now() >= deadline) {
      check(false, `timed out waiting for: ${label}`)
      return false
    }
    await settle(20)
  }
}
await settle(160)

/* ------------------------------------------------------------------ *
 * 4. The section-header launcher.
 * ------------------------------------------------------------------ */

section('section-header launcher')

const header = document.querySelector('[class*="_sectionHeader"]')
const headerActions = header.querySelector('[class*="_headerActions"]')
const launcher = headerActions.querySelector('[data-dsh-codespace-launcher]')

check(launcher !== null, 'the launcher was injected into the header icon row')
check(launcher !== null && launcher.tagName === 'BUTTON', 'the launcher is a real <button>')
check(launcher !== null && launcher.parentElement === headerActions,
  'the launcher is a child of the icon row, not a separate control')
check(headerActions.lastElementChild?.getAttribute('aria-label') === '添加工作区',
  'the host add-workspace control is still last')
check(launcher !== null && launcher.nextElementSibling === headerActions.lastElementChild,
  'the launcher sits immediately LEFT of 添加工作区')
eq('the icon row is [viewOptions, ours, addWorkspace]', headerActions.children.length, 3)
eq('  ↳ order', [...headerActions.children].map((c) => c.getAttribute('aria-label')).join(' | '),
  '视图选项 | 新建云端工作区 | 添加工作区')
check(headerActions.getAttribute('data-dsh-codespace-header') !== null,
  'the icon row is marked so the CSS can widen it')
eq('the launcher carries the accessible name', launcher.getAttribute('aria-label'), '新建云端工作区')
eq('the launcher has a tooltip', launcher.getAttribute('title'), '新建云端工作区')
check(launcher.querySelector('svg') !== null, 'the launcher holds the cloud svg')

// Metrics: it must match the host's iconButton, and not be clipped by max-width.
const launcherBox = launcher.getBoundingClientRect()
const addBox = headerActions.lastElementChild.getBoundingClientRect()
eq('the launcher is 16x16 like its peers', `${Math.round(launcherBox.width)}x${Math.round(launcherBox.height)}`, '16x16')
eq('the host add control is 16x16 too', `${Math.round(addBox.width)}x${Math.round(addBox.height)}`, '16x16')
check(launcherBox.right <= addBox.left + 1, 'the launcher is laid out to the left of the add control',
  `launcher.right=${Math.round(launcherBox.right)} add.left=${Math.round(addBox.left)}`)
check(launcherBox.left >= headerActions.getBoundingClientRect().left - 1,
  'the launcher is inside the icon row (not clipped off its leading edge)')
check(headerActions.scrollWidth <= headerActions.clientWidth + 1,
  'nothing in the icon row overflows (the container was widened past 60px)',
  `scrollWidth=${headerActions.scrollWidth} clientWidth=${headerActions.clientWidth}`)
eq('the host max-width was overridden', getComputedStyle(headerActions).maxWidth, 'none')

// The host's own collapse while the search box is expanded must still win.
headerActions.classList.add('_9lTDKa_headerActionsHidden')
await settle(30)
check(getComputedStyle(headerActions).maxWidth === '0px',
  'the search-expanded collapse still applies (our rule does not beat it)',
  getComputedStyle(headerActions).maxWidth)
headerActions.classList.remove('_9lTDKa_headerActionsHidden')
await settle(30)
eq('and the widened max-width returns afterwards', getComputedStyle(headerActions).maxWidth, 'none')

// Clicking it opens the create window. The overlay is mounted, so this asserts
// the real path: DOM click → ui.openCreate() → the store → the overlay renders
// the single multi-step window (which fetches the repository list on mount).
rpcCalls.length = 0
launcher.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await settle(120)
const overlayTree = overlay.tree
check(overlayTree !== null && overlayTree !== undefined,
  'clicking the launcher renders the overlay window', JSON.stringify(overlayTree))
check(rpcCalls.includes('list-repos'), 'the create window loads the repository list', rpcCalls.join(','))

// Rail mode: the host enlarges its controls, so ours must follow.
document.getElementById('sidebar').classList.add('_9lTDKa_rail')
await settle(30)
const railBox = launcher.getBoundingClientRect()
eq('rail mode: the launcher grows to 36x36 with its peers',
  `${Math.round(railBox.width)}x${Math.round(railBox.height)}`, '36x36')
document.getElementById('sidebar').classList.remove('_9lTDKa_rail')
await settle(30)

/* ------------------------------------------------------------------ *
 * 5. The row patch.
 * ------------------------------------------------------------------ */

const row = document.querySelector('[data-row-key="workspace:' + WORKSPACE + '"]')
const otherRow = document.querySelector('[data-row-key="workspace:ws-local"]')
const sessionRow = document.querySelector('[data-row-key="session:s-1"]')
const actions = row.querySelector('[class*="_rowActions"]')

check(row.hasAttribute('data-dsh-codespace-row'), 'the managed row is marked')
check(!otherRow.hasAttribute('data-dsh-codespace-row'), 'the unmanaged row is NOT marked')
check(!sessionRow.hasAttribute('data-dsh-codespace-row'), 'the session row is NOT marked')

const icon = row.querySelector('[data-dsh-codespace-icon]')
check(icon !== null, 'the cloud marker was injected')
check(icon !== null && row.firstElementChild === icon, 'the cloud marker is the row’s first child')
check(icon !== null && icon.querySelector('svg') !== null, 'the cloud marker holds an inline svg')

// The host's own nodes must all survive: React owns them and would throw on unmount.
check(row.querySelector('[class*="_folder"]') !== null, 'the host folder span was NOT removed')
check(row.querySelector('[class*="_chevron"]') !== null, 'the host chevron span was NOT removed')
check(row.querySelector('[class*="_title"]') !== null, 'the host title span was NOT removed')

const button = row.querySelector('[data-dsh-codespace-action]')
check(button !== null, 'the action button was injected')
check(button !== null && actions.firstElementChild === button,
  'the action button is the FIRST child of rowActions (third from last overall)')
eq('rowActions now holds [ours, Menu, NewSession]', actions.children.length, 3)
check(actions.children[1]?.getAttribute('aria-label') === 'Workspace actions',
  'the host Menu button follows ours')
check(actions.children[2]?.getAttribute('aria-label') === 'New session',
  'the host New Session button is still last')

/* ---- button states ---- */

section('button states')

function glyph() {
  const span = button.querySelector('[data-dsh-codespace-glyph]')
  return span === null ? null : span.textContent
}

/** Wait until the row's button has adopted a given glyph kind. */
const untilGlyph = (kind) => until(
  () => button.getAttribute('data-dsh-codespace-glyph-kind') === kind,
  `the button to show the "${kind}" glyph`)

// stopped
eq('stopped → ▶️', glyph(), '▶️')
eq('stopped → tooltip', button.getAttribute('title'), '启动 Codespace')
eq('stopped → aria-label', button.getAttribute('aria-label'), '启动 Codespace')
eq('stopped → not disabled', button.disabled, false)

// running
record = { ...record, codespace: { ...record.codespace, state: 'Available' } }
await untilGlyph('stop')
eq('running → ⏸️', glyph(), '⏸️')
eq('running → tooltip', button.getAttribute('title'), '暂停 Codespace')

// counting down
record = { ...record, autoPauseRemainingMs: 25 * 60 * 1000 }
await untilGlyph('countdown')
eq('counting down → 🕐', glyph(), '🕐')
eq('counting down → tooltip carries the minutes', button.getAttribute('title'), '还剩 25 分钟自动暂停')

// starting: spinner, disabled
record = { ...record, autoPauseRemainingMs: 0, codespace: { ...record.codespace, state: 'Provisioning' } }
await untilGlyph('pending')
check(button.querySelector('[data-dsh-codespace-glyph]') === null, 'starting → no glyph')
check(button.querySelector('.dcw-spin') !== null, 'starting → spinner shown')
eq('starting → disabled', button.disabled, true)
eq('starting → tooltip', button.getAttribute('title'), '正在切换状态…')

// error
record = { ...record, codespace: { ...record.codespace, state: 'Failed' } }
await untilGlyph('error')
eq('error → ⚠️', glyph(), '⚠️')
eq('error → tooltip names the state', button.getAttribute('title'), '状态异常：Failed')

/* ---- the click protocol ---- */

section('click protocol')

const click = (detail) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: detail ?? 1 }))

// (a) stopped → one click starts immediately. There is no double-click meaning
// to wait for, so nothing is deferred.
record = { ...record, autoPauseRemainingMs: 0, codespace: { ...record.codespace, state: 'Shutdown' } }
await untilGlyph('start')
rpcCalls.length = 0
click()
await settle(60)
check(rpcCalls.includes('start'), 'a click on a stopped Codespace starts it immediately', rpcCalls.join(','))

// (b) running WITHOUT a countdown → the single click is DEFERRED, because a
// second click would mean "pause now". While the window is open the button shows
// the spinner but stays ENABLED — disabling it would swallow the second click.
record = { ...record, autoPauseRemainingMs: 0, codespace: { ...record.codespace, state: 'Available' } }
await untilGlyph('stop')
rpcCalls.length = 0
click()
await settle(20)
check(button.querySelector('.dcw-spin') !== null, 'the first click arms the spinner while the window is open')
eq('the armed button stays clickable (so the 2nd click can land)', button.disabled, false)
check(!rpcCalls.includes('stop'), 'the single click has not fired yet — it is waiting out the window', rpcCalls.join(','))
// ...and it resolves into the pause once the window closes.
await until(() => rpcCalls.includes('stop'), 'the deferred single click to pause the Codespace')
check(rpcCalls.includes('stop'), 'the deferred single click pauses the Codespace', rpcCalls.join(','))

// (c) running WITH a countdown → one click cancels the countdown immediately
// (a double-click there would mean "pause now", which the cancel does not
// pre-empt, so there is nothing to defer).
// The state is set explicitly: the stub `stop` above left it `ShuttingDown`, and
// a scenario must not inherit a leftover lifecycle state from the previous one.
record = { ...record, autoPauseRemainingMs: 25 * 60 * 1000, codespace: { ...record.codespace, state: 'Available' } }
await untilGlyph('countdown')
rpcCalls.length = 0
click()
await until(() => rpcCalls.includes('pause-cancel'), 'the clock click to cancel the countdown')
check(rpcCalls.includes('pause-cancel'), 'a click on the clock cancels the countdown immediately', rpcCalls.join(','))

// (d) double-click on a counting-down row → pause NOW, and the deferred single
// click must not also fire.
record = { ...record, autoPauseRemainingMs: 25 * 60 * 1000, codespace: { ...record.codespace, state: 'Available' } }
await untilGlyph('countdown')
rpcCalls.length = 0
click(1)
await settle(20)
click(2)
button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
await until(() => rpcCalls.includes('pause-now'), 'the double-click to pause now')
await settle(420)
check(rpcCalls.includes('pause-now'), 'a double-click pauses immediately', rpcCalls.join(','))
eq('the double-click did not also fire a deferred stop', rpcCalls.filter((a) => a === 'stop').length, 0)

// (e) double-click on a running row with NO countdown → also pause now.
record = { ...record, autoPauseRemainingMs: 0, codespace: { ...record.codespace, state: 'Available' } }
await untilGlyph('stop')
rpcCalls.length = 0
click(1)
await settle(20)
click(2)
button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
await until(() => rpcCalls.includes('pause-now'), 'the second double-click to pause now')
await settle(420)
check(rpcCalls.includes('pause-now'), 'a double-click without a countdown also pauses immediately', rpcCalls.join(','))
eq('and that one did not fire a stop either', rpcCalls.filter((a) => a === 'stop').length, 0)

/* ---- the always-show switch ---- */

section('always-show switch')

record = { ...record, autoPauseRemainingMs: 0, codespace: { ...record.codespace, state: 'Available' } }
await settle()
check(!row.hasAttribute('data-dsh-codespace-always'), 'the always marker is off by default')
const hiddenByDefault = getComputedStyle(actions).display === 'none'
check(hiddenByDefault, 'rowActions is hidden while not hovered (the host’s rule)')

// The switch is driven through the real settings page: mount it, find the real
// `role="switch"` vnode, and call its `onClick` — the same handler the browser
// would call — so the write goes through `setField` → `saveSettings` → the RPC.
//
// (The mini-renderer walks components but does not materialize host elements, so
// the control is reached in the vnode tree rather than through the DOM. The
// click handler under test is the bundle's own.)
const settingsPage = mountSlot('settings.section')

/** The rendered `role="switch"` for the always-show setting. */
const findSwitch = () => settingsPage.search(
  (node) => node.props?.className === 'dcw-switch' && node.props?.['aria-label'] === '始终显示云端工作区按钮')[0]

/**
 * The page's own Save button. The switch only edits a local draft — the real
 * page requires Save to commit it — so a faithful test has to press both.
 *
 * It must be matched on `data-variant="primary"`: the page also renders a
 * SECOND 保存 button for the write-only SSH key, which is `default`-variant and
 * stays disabled until that input has text. Matching on the label alone finds
 * the wrong one.
 */
const findSave = () => settingsPage.search(
  (node) => node.props?.className === 'dcw-button' && node.props?.['data-variant'] === 'primary')[0]

// The page loads its own settings on mount, and only builds its draft once that
// has landed. Wait for the control to exist rather than guessing a duration.
await until(() => findSwitch() !== undefined, 'the settings page to render its switch')

const switchNode = findSwitch()
check(switchNode !== undefined, 'the always-show switch is rendered by the settings page')
eq('the switch reflects the stored value', switchNode?.props?.['aria-checked'], 'false')
check(typeof switchNode?.props?.onClick === 'function', 'the switch has a click handler')

switchNode.props.onClick()
await until(() => findSave()?.props?.disabled === false, 'Save to become enabled once the draft is dirty')
eq('toggling the switch alone does not write to the host yet', settings.alwaysShowCloudButton, false)
eq('the switch is on in the draft', findSwitch()?.props?.['aria-checked'], 'true')
check(findSave() !== undefined, 'the settings page renders a Save button')
check(findSave()?.props?.disabled === false, 'Save becomes enabled once the draft is dirty')

findSave().props.onClick()
await until(() => settings.alwaysShowCloudButton === true, 'Save to reach the host as a settings patch')
eq('pressing Save reached the host as a settings patch', settings.alwaysShowCloudButton, true)
await until(() => row.hasAttribute('data-dsh-codespace-always'), 'the always marker to turn on')
check(row.hasAttribute('data-dsh-codespace-always'), 'the always marker turns on with the setting')
check(getComputedStyle(actions).display !== 'none', 'rowActions is revealed by the always-show rule')
check(getComputedStyle(button).display !== 'none', 'our button is visible when always-show is on')

findSwitch().props.onClick()
await until(() => findSave()?.props?.disabled === false, 'Save to become enabled again')
findSave().props.onClick()
await until(() => settings.alwaysShowCloudButton === false, 'the second Save to reach the host')
eq('saving again turned it back off', settings.alwaysShowCloudButton, false)
await until(() => !row.hasAttribute('data-dsh-codespace-always'), 'the always marker to turn back off')
check(!row.hasAttribute('data-dsh-codespace-always'), 'the always marker turns back off')
check(getComputedStyle(actions).display === 'none', 'rowActions is hidden again')

/* ---- the hover card ---- */

section('hover card')

const card = document.querySelector('#hovercard')
card.style.display = ''
const pathLine = card.querySelector('[class*="_hoverPath"]')
await settle(140)
eq('the location line now shows the Codespace name', pathLine.textContent, CODESPACE)
eq('the original path is stashed for undo', pathLine.getAttribute('data-dsh-codespace-original'), PLACEHOLDER)
eq('the title line is untouched', card.querySelector('[class*="_hoverTitle"]').textContent, 'my-box')

/* ---- the injected menu item ---- */

section('workspace menu')

// The host opens the menu by adding `menuOpen` to the row and portaling the
// menu onto document.body. Reproduce exactly that.
row.classList.add(HASH + 'menuOpen')
const menu = document.createElement('div')
menu.className = HASH + 'menu'
menu.setAttribute('role', 'menu')
menu.innerHTML = '<button type="button" role="menuitem" class="' + HASH + 'menuItem">重命名</button>'
  + '<button type="button" role="menuitem" class="' + HASH + 'menuItem">删除工作区</button>'
document.body.appendChild(menu)
await settle(140)

const menuItem = menu.querySelector('[data-dsh-codespace-menu-item]')
check(menuItem !== null, 'our menu item was appended')
eq('our item is labelled unambiguously', menuItem?.textContent, '删除 Codespace…')
eq('our item is a menuitem', menuItem?.getAttribute('role'), 'menuitem')
check(menu.querySelector('[data-dsh-codespace-menu-separator]') !== null, 'a separator precedes it')
check(menu.lastElementChild === menuItem, 'our item is last')
check(menu.querySelectorAll('button').length === 3, 'the host’s two items survive', String(menu.querySelectorAll('button').length))

// Closing the menu must remove our nodes and leave the host's alone.
row.classList.remove(HASH + 'menuOpen')
menu.remove()
await settle(140)
check(document.querySelector('[data-dsh-codespace-menu-item]') === null, 'closing the menu removes our item')
check(document.querySelector('[data-dsh-codespace-menu-separator]') === null, 'closing the menu removes our separator')

/* ---- dispose ---- */

section('dispose')

for (const dispose of effects) {
  try { if (typeof dispose === 'function') dispose() } catch (error) { check(false, 'a disposer threw', String(error)) }
}
await settle(80)

check(document.querySelector('[data-dsh-codespace-row]') === null, 'the row marker was removed')
check(document.querySelector('[data-dsh-codespace-always]') === null, 'the always marker was removed')
check(document.querySelector('[data-dsh-codespace-icon]') === null, 'the cloud marker was removed')
check(document.querySelector('[data-dsh-codespace-action]') === null, 'the action button was removed')
check(document.querySelector('[data-dsh-codespace-launcher]') === null, 'the header launcher was removed')
check(document.querySelector('[data-dsh-codespace-header]') === null, 'the header marker was removed')
eq('the icon row is back to the host’s two controls',
  document.querySelector('[class*="_headerActions"]').children.length, 2)
check(document.querySelector('[class*="_headerActions"]').lastElementChild.getAttribute('aria-label') === '添加工作区',
  'the host add-workspace control survives')
eq('the widened max-width is released', getComputedStyle(document.querySelector('[class*="_headerActions"]')).maxWidth, '60px')
eq('rowActions is back to the host’s two controls',
  document.querySelector('[data-row-key="workspace:' + WORKSPACE + '"] [class*="_rowActions"]').children.length, 2)
check(document.querySelector('[data-row-key="workspace:' + WORKSPACE + '"] [class*="_iconButton"]') !== null,
  'the host ellipsis and new-session buttons survive')
eq('the hover card path was restored',
  document.querySelector('#hovercard [class*="_hoverPath"]').textContent, PLACEHOLDER)
check(document.querySelector('#hovercard [class*="_hoverPath"]').getAttribute('data-dsh-codespace-original') === null,
  'the stashed original was cleaned up')
eq('the unmanaged row is still untouched',
  document.querySelector('[data-row-key="workspace:ws-local"]').querySelectorAll('button').length, 2)

/* ------------------------------------------------------------------ */

finish()
