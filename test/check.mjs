/**
 * Node-side acceptance check for dsh-codespace-workspace.
 *
 * Runs everything that does NOT need a browser or a live DSH:
 *   1. package manifest / exports resolve to real files, client bundle shape
 *   2. the host half imports and its Config schema binds all 8 fields
 *   3. lib/shared.js contract literals agree with the client bundle's copies
 *   4. the RPC route's own guards (method, origin, content-type, action)
 *   5. `shq()` quoting is injection-safe
 *   6. the client bundle parses, uses no ESM syntax, and needs only `react`
 *   7. the two locales have identical keys, and every t() key exists
 *
 * Output is deliberately ASCII-only: this script is run through a PowerShell
 * host whose console encoding is not UTF-8, and mangled text is unreadable.
 *
 * Run: node test/check.mjs
 */
import { readFileSync, existsSync, statSync, mkdirSync, symlinkSync, rmdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/**
 * Import a file inside the repo. Windows absolute paths are not valid ESM
 * specifiers, so every dynamic import goes through a file:// URL.
 */
const load = (relative) => import(new URL(relative, import.meta.url).href)

/**
 * The host half imports its PEER dependencies (`@deepseek-ai/schemastery` and,
 * through it, `@deepseek-ai/cordis`). This repo deliberately does not vendor
 * them -- DSH supplies them at runtime. Node's resolver only walks up from the
 * importing file, so the profile's own `@deepseek-ai` scope is linked into the
 * repo for the duration of this check and removed again afterwards. The
 * published package has no dependency on that link; it exists so the check can
 * exercise the real module instead of a stub.
 */
const PEER_ROOTS = [
  'C:/Users/Vxiao/.dsh/profiles/desktop/node_modules/@deepseek-ai',
  'C:/Users/Vxiao/.dsh/profiles/cscheck/node_modules/@deepseek-ai',
]
const linkPath = join(root, 'node_modules', '@deepseek-ai')
let createdLink = false

function ensurePeers() {
  if (existsSync(linkPath)) return true
  const source = PEER_ROOTS.find((p) => existsSync(p))
  if (source === undefined) return false
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(source, linkPath, 'junction')
  createdLink = true
  return true
}

let failures = 0
let checks = 0
function check(cond, label, extra) {
  checks += 1
  if (!cond) failures += 1
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond || extra === undefined ? '' : ' -- ' + extra}`)
}
function eq(label, got, want) {
  check(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
function section(name) {
  console.log(`\n${name}`)
}

try {

/* ------------------------------------------------------------------ *
 * 1. Manifest.
 * ------------------------------------------------------------------ */

section('package manifest')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
eq('name', pkg.name, 'dsh-codespace-workspace')
eq('type is module (the host half is ESM)', pkg.type, 'module')
// This package is published to npm, and npm refuses to publish a manifest that
// still carries `private: true`. Asserting the field is ABSENT (rather than
// equal to false) catches the mistake the moment someone copies it back in.
eq('private', pkg.private, undefined)
eq('publishConfig.registry', pkg.publishConfig?.registry, 'https://registry.npmjs.org/')

for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value !== 'string' || key === './package.json') continue
  const target = join(root, value)
  check(existsSync(target) && statSync(target).isFile(),
    `exports["${key}"] -> ${value} is a real file`)
}
check(typeof pkg.exports?.['./client'] === 'string',
  'exports["./client"] is a plain string (a condition object would abort Host startup)')
check(pkg.dsh?.bundle?.patch !== undefined, 'dsh.bundle.patch is declared')
eq('dsh.client.platform', pkg.dsh?.client?.platform, 'web')
check(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
  'dsh.client.inject is a non-empty array')
// The section header lives in `dsh-client-ui-workspace` (verified: 54 hits for
// `WorkspaceBrowser` there, 0 in `dsh-client-ui-sidebar`). `ui-sidebar` was only
// ever needed for the `sidebar.footer.action` slot, which the launcher no longer
// uses, so it must not linger as a dependency.
check(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'),
  'ui-sidebar is not injected (the footer slot is no longer used)')
check(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'),
  'ui-workspace IS injected (it owns the section header we augment)')
check(pkg.dsh?.engines?.dsh !== undefined, 'dsh.engines.dsh is declared')

// Every file the manifest POINTS AT must survive packaging.
//
// `files` is the npm/pnpm pack whitelist, and the profile installs this package
// from a GitHub tarball 鈥?which applies that whitelist. `icon.svg` was missing
// from it while `"icon": "./icon.svg"` still pointed at it, so the installed copy
// had no icon and DSH reported
// `ENOENT ... lstat '.../dsh-codespace-workspace/icon.svg'` when reading plugin
// metadata. The repo looked fine; only the packed copy was broken.
{
  const listed = Array.isArray(pkg.files) ? pkg.files : []
  check(listed.length > 0, 'the manifest declares a files whitelist')
  // `files` entries are paths relative to the package root; npm treats a bare
  // name as "this file or this directory". Compare the leading segment.
  const covered = (relative) => listed.some((entry) => {
    const clean = String(entry).replace(/^\.\//, '').replace(/\/+$/, '')
    return relative === clean || relative.startsWith(clean + '/')
  })
  for (const field of ['main', 'icon']) {
    const value = pkg[field]
    if (typeof value !== 'string') continue
    const relative = value.replace(/^\.\//, '')
    check(existsSync(join(root, relative)), `${field} -> ${value} exists in the repo`)
    check(covered(relative), `  -> and "${relative}" is covered by files (else it is absent after packing)`)
  }
  for (const value of Object.values(pkg.exports ?? {})) {
    if (typeof value !== 'string') continue
    const relative = value.replace(/^\.\//, '')
    // `package.json` is always packed regardless of `files`, so it needs no entry.
    if (relative === 'package.json') continue
    check(covered(relative), `exports target "${relative}" is covered by files`)
  }
  // `dsh.bundle.patch` is read by the host at load time, so it has to ship too.
  const patchPath = typeof pkg.dsh?.bundle?.patch === 'string' ? pkg.dsh.bundle.patch.replace(/^\.\//, '') : null
  if (patchPath !== null) check(covered(patchPath), `dsh.bundle.patch "${patchPath}" is covered by files`)
}

/* ------------------------------------------------------------------ *
 * 2. The patch row.
 * ------------------------------------------------------------------ */

section('cordis.patch.yml')

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
check(patch.includes('name: dsh-codespace-workspace'),
  'the patch inserts a row whose name is the FULL package name')
check(/id:\s*dsh-codespace-workspace/.test(patch), 'the patch row carries an id')
check(!/^\s*githubToken\s*:/m.test(patch),
  'the patch does not carry a token (every field is volatile, set through settings)')

/* ------------------------------------------------------------------ *
 * 3. shared.js is the single source of truth for the wire literals.
 * ------------------------------------------------------------------ */

section('shared.js vs client bundle')

const shared = await load('../lib/shared.js')
eq('RPC_ROUTE', shared.RPC_ROUTE, '/api/dsh-codespace-workspace/rpc')
eq('PLUGIN_ID', shared.PLUGIN_ID, 'dsh-codespace-workspace')
eq('ACTIONS has 16 entries', Object.keys(shared.ACTIONS).length, 16)

const clientSource = readFileSync(join(root, 'lib/client.js'), 'utf8')
check(clientSource.includes(`'${shared.RPC_ROUTE}'`), 'the client bundle uses the same RPC route literal')
const absentActions = Object.entries(shared.ACTIONS).filter(([, v]) => !clientSource.includes(`'${v}'`))
check(absentActions.length === 0, 'every action literal appears in the client bundle',
  absentActions.map(([k, v]) => `${k}="${v}"`).join(', '))

/* ------------------------------------------------------------------ *
 * 4. The host half imports, and Config binds every field.
 * ------------------------------------------------------------------ */

section('host half')

if (!ensurePeers()) {
  check(false, 'a DSH profile with the peer dependencies was found', PEER_ROOTS.join(', '))
} else {
  const host = await load('../lib/index.js')
  eq('the host exports a name', host.name, 'dsh-codespace-workspace')
  check(typeof host.apply === 'function', 'the host exports apply()')
  check(Array.isArray(host.inject), 'the host declares inject')
  check(host.Config !== undefined, 'the host exports Config')

  // A schemastery schema is a CLASS, not a value: the resolved config comes from
  // `new Config({}).get()`. Reading `Config.someField` or spreading `Config`
  // yields nothing, which is easy to mistake for "the defaults are missing".
  const instance = new host.Config({})
  const snapshot = typeof instance.get === 'function' ? instance.get() : instance
  const EXPECTED = {
    githubUsername: '', githubToken: '', defaultBranch: 'main', autoPauseMinutes: 30,
    sshKeyPath: '', alwaysShowCloudButton: false, autoInitEmptyRepo: true, readmeContent: '',
  }
  for (const [key, want] of Object.entries(EXPECTED)) eq(`Config.${key} default`, snapshot?.[key], want)
  eq('Config binds exactly the 8 documented fields',
    Object.keys(snapshot ?? {}).sort().join(','), Object.keys(EXPECTED).sort().join(','))
  eq('Config is volatile (settings are user-owned, not patch-owned)',
    host.Config.meta?.volatile, true)
  eq('Config.meta.default is an empty object (nothing is written into the patch)',
    JSON.stringify(host.Config.meta?.default), '{}')

  /* ---------------------------------------------------------------- *
   * 5. The RPC surface.
   *
   * Two layers, and they are not the same function:
   *   - `createRpcHandler` returns `dispatch(parsedBody)`, which owns the
   *     ACTION table and always resolves `{ok:true,...}` / throws a coded error.
   *   - `installRoutes` owns the HTTP guards (method, loopback, same-origin,
   *     content-type, body parse) and wraps `dispatch` so nothing ever throws
   *     across the wire.
   * Testing only the first would leave every guard unexercised, so both run.
   * ---------------------------------------------------------------- */

  section('RPC action table')

  const { createRpcHandler, installRoutes } = await load('../lib/host/routes.js')
  check(typeof createRpcHandler === 'function', 'createRpcHandler is exported')
  check(typeof installRoutes === 'function', 'installRoutes is exported')

  const manager = {
    listWorkspaces: async () => [],
    listRepos: async () => [],
    status: async () => ({ gh: { installed: false }, tokenSource: 'none', configured: false, secrets: {} }),
  }
  const dispatch = createRpcHandler({}, manager, { logger: { warn() {}, info() {} } })

  const unknown = await dispatch({ action: 'nope' }).then(() => null, (e) => e)
  eq('an unknown action throws E_UNKNOWN_ACTION', unknown?.code, 'E_UNKNOWN_ACTION')

  const badArg = await dispatch({ action: shared.ACTIONS.START }).then(() => null, (e) => e)
  eq('a missing required argument throws E_INVALID', badArg?.code, 'E_INVALID')

  const okBody = await dispatch({ action: shared.ACTIONS.WORKSPACES })
  eq('a valid action resolves ok:true', okBody.ok, true)
  check(Array.isArray(okBody.workspaces), '  -> and returns the documented shape')

  // Secrets must never cross the wire: only boolean markers.
  const settingsBody = await dispatch({ action: shared.ACTIONS.GET_SETTINGS })
  eq('get-settings resolves ok:true', settingsBody.ok, true)
  check(settingsBody.settings?.githubToken === undefined,
    'the token is NOT present in the settings payload')
  eq('  -> it is reported as a set-marker instead', settingsBody.secrets?.githubToken?.set, false)

  section('RPC http guards')

  // Build a fake host ctx, capturing whichever carrier the module chooses.
  // `get` mirrors cordis's ungated service accessor; `inject` mirrors the
  // optional-service callback.
  const captured = { webServer: null, fetch: null }
  const fakeHostCtx = ({ withConnection = true } = {}) => {
    // Reset first: `captured` is shared, so a stale route from an earlier
    // scenario would read as "this carrier registered" when it did not.
    captured.webServer = null
    captured.fetch = null
    const services = {
      webServer: { register: (options) => { captured.webServer = options; return () => {} } },
      ...(withConnection
        ? { connection: { fetch: { register: (route) => { captured.fetch = route; return () => {} } } } }
        : {}),
    }
    const ctx = {
      logger: { warn() {}, info() {} },
      settings: { describe: async () => [] },
      // cordis's `ctx.get(name, strict = true)`; `false` skips the inject gate.
      get: (name) => services[name],
    }
    // The injected sub-context keeps the same accessors plus the injected ones.
    ctx.inject = (names, cb) => {
      cb({ ...ctx, effect: (fn) => fn(), webServer: services.webServer })
    }
    return ctx
  }

  /*
   * The PREFERRED carrier is the connection's Fetch registry, and the reason is
   * security, not convenience: DSH's own `/api` prefix route serves that
   * registry, and its handler calls `connection.admit(req)` 鈥?the Host/Origin
   * fence AND the browser-auth cookie check 鈥?before dispatching to any
   * registered Fetch route. Registering here inherits the harness policy.
   *
   * A `webServer` exact route on the same path is matched BEFORE the `/api`
   * prefix route (`dsh-host-webserver` `match()` tries the exact table first),
   * so it SHADOWS the `/api` route and silently drops both the fence and the
   * authentication. That was a real defect here: `/api/dsh-codespace-workspace/rpc`
   * answered 200 with no session cookie, while DSH's own `/api` paths answered
   * 401. This assertion is what keeps that from coming back.
   */
  const disposePreferred = installRoutes(fakeHostCtx(), manager, { logger: { warn() {}, info() {} } })
  check(captured.fetch !== null, 'the rpc route registers on connection.fetch (inherits the /api fence + auth)')
  eq('  -> and does NOT also register a shadowing webServer exact route', captured.webServer, null)
  eq('  -> on the documented path', captured.fetch?.path, shared.RPC_ROUTE)
  eq('  -> accepting only POST', JSON.stringify(captured.fetch?.methods), JSON.stringify(['POST']))
  eq('  -> with a buffered request body', captured.fetch?.requestBody, 'buffered')

  const post = (body) => captured.fetch.fetch(new Request(`http://127.0.0.1:19387${shared.RPC_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

  const badRes = await post({ action: 'nope' })
  eq('the fetch carrier answers HTTP 200 even for a bad action', badRes.status, 200)
  const badBody = await badRes.json()
  eq('  -> with ok:false', badBody.ok, false)
  eq('  -> and the documented code', badBody.error?.code, 'E_UNKNOWN_ACTION')

  const goodRes = await post({ action: shared.ACTIONS.WORKSPACES })
  eq('the fetch carrier resolves a valid action', (await goodRes.json()).ok, true)

  const unparseable = await captured.fetch.fetch(new Request(`http://127.0.0.1:19387${shared.RPC_ROUTE}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  }))
  eq('an unparseable body is still HTTP 200', unparseable.status, 200)
  eq('  -> reporting E_BAD_REQUEST', (await unparseable.json()).error?.code, 'E_BAD_REQUEST')

  disposePreferred()
  check(true, 'the fetch-carrier disposer ran without throwing')

  // Fallback for a composition with no connection service: the module must
  // still serve the route, and because an exact route shadows the harness fence
  // it must apply the fence itself. These are the guard tests.
  let routeHandler = null
  const disposeRoutes = installRoutes(fakeHostCtx({ withConnection: false }), manager, { logger: { warn() {}, info() {} } })
  routeHandler = captured.webServer?.handler
  check(typeof routeHandler === 'function', 'with no connection service the webServer fallback registers')
  eq('  -> on the documented path', captured.webServer?.path, shared.RPC_ROUTE)
  eq('  -> as an exact route', captured.webServer?.kind, 'exact')
  eq('  -> and the fetch carrier is not used', captured.fetch, null)

  /**
   * Drive the registered HTTP handler.
   *
   * The route reads its body with `for await (const chunk of req)`, so the stub
   * must be a real async iterable 鈥?an EventEmitter-shaped `on('data')` stub
   * silently yields an EMPTY body, which looks exactly like a bad action.
   */
  function drive({ method = 'POST', remoteAddress = '127.0.0.1', host = '127.0.0.1:19387', origin = 'http://127.0.0.1:19387', type = 'application/json', body = {}, dropOrigin = false, secFetchSite } = {}) {
    return new Promise((done) => {
      const headers = { host, 'content-type': type }
      if (!dropOrigin) headers.origin = origin
      if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
      const text = JSON.stringify(body)
      const req = {
        method,
        headers,
        socket: { remoteAddress },
        setEncoding() {},
        async *[Symbol.asyncIterator]() {
          if (text.length > 0) yield text
        },
      }
      const chunks = []
      const res = {
        statusCode: 0,
        setHeader() {},
        writeHead(code) { this.statusCode = code },
        write(chunk) { chunks.push(String(chunk)) },
        end(chunk) {
          if (chunk !== undefined) chunks.push(String(chunk))
          done({ status: this.statusCode, body: chunks.join('') })
        },
      }
      routeHandler(req, res)
    })
  }

  eq('GET is rejected with 405', (await drive({ method: 'GET' })).status, 405)
  eq('a non-loopback peer is rejected with 403',
    (await drive({ remoteAddress: '10.0.0.5' })).status, 403)
  eq('a non-loopback Host is rejected with 403',
    (await drive({ host: 'evil.example', origin: 'http://evil.example' })).status, 403)
  eq('a cross-origin Origin is rejected with 403',
    (await drive({ origin: 'http://evil.example' })).status, 403)
  eq('Sec-Fetch-Site: cross-site is rejected with 403',
    (await drive({ dropOrigin: true, secFetchSite: 'cross-site' })).status, 403)
  eq('a non-JSON content-type is rejected with 415', (await drive({ type: 'text/plain' })).status, 415)

  // A request with NO Origin must be ACCEPTED. This is the desktop shell
  // carrier's shape: it reaches the host through the connection's internal
  // fetch, which attaches neither Origin nor Fetch-Metadata. DSH's own fence
  // (`isTrustedApiRequest` in dsh-client-connection) returns true for a missing
  // Origin, because the load-bearing check is the HOST -- the one header DNS
  // rebinding cannot forge. An earlier revision of this route demanded an
  // Origin and 403'd the whole desktop app with "Requests must be same-origin"
  // while the Web GUI worked; this assertion is what pins that shut.
  const noOrigin = await drive({ dropOrigin: true, body: { action: shared.ACTIONS.WORKSPACES } })
  eq('a request with no Origin is ACCEPTED (the desktop carrier sends none)', noOrigin.status, 200)
  eq('  -> and still resolves the action', JSON.parse(noOrigin.body).ok, true)

  // 127/8 is loopback in full, not just 127.0.0.1, and localhost / [::1] count.
  eq('another 127/8 address is accepted', (await drive({ host: '127.0.0.7:19387', origin: 'http://127.0.0.7:19387' })).status, 200)
  eq('localhost is accepted', (await drive({ host: 'localhost:19387', origin: 'http://localhost:19387' })).status, 200)
  eq('the IPv6 loopback is accepted', (await drive({ host: '[::1]:19387', origin: 'http://[::1]:19387' })).status, 200)
  // A mismatched origin is still refused even though the Host is fine.
  eq('a different loopback port in Origin is refused',
    (await drive({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:9999' })).status, 403)

  const unknownRes = await drive({ body: { action: 'nope' } })
  eq('an action failure is answered with HTTP 200 (never a 4xx/5xx)', unknownRes.status, 200)
  eq('  -> reporting ok:false', JSON.parse(unknownRes.body).ok, false)
  eq('  -> with the documented code', JSON.parse(unknownRes.body).error?.code, 'E_UNKNOWN_ACTION')

  const okRes = await drive({ body: { action: shared.ACTIONS.WORKSPACES } })
  eq('a valid action is answered with HTTP 200', okRes.status, 200)
  eq('  -> ok:true', JSON.parse(okRes.body).ok, true)

  disposeRoutes()
  check(true, 'the route disposer ran without throwing')

  /*
   * The carrier choice must be self-healing, not a one-shot decision: service
   * load order is not guaranteed, and settling for the weaker fallback because
   * `connection` happened to be late would silently drop the harness fence and
   * auth for the rest of the process.
   */
  section('rpc carrier upgrade')

  const late = { webServer: null, fetch: null }
  let fireConnectionInject = null
  let webServerRouteDisposed = false
  // A mutable registry read *through* the closure, so a context spread earlier
  // still observes a service that is provided afterwards -- which is exactly
  // the situation this section exists to cover.
  const lateServices = {}
  const lateBase = {
    logger: { warn() {}, info() {} },
    settings: { describe: async () => [] },
    get: (name) => lateServices[name],
  }
  lateBase.inject = (names, cb) => {
    cb({
      ...lateBase,
      effect: (fn) => fn(),
      webServer: {
        register: (options) => {
          late.webServer = options
          return () => { webServerRouteDisposed = true }
        },
      },
      // Mirrors cordis: fires immediately if the service exists, else later.
      inject: (more, ready) => { fireConnectionInject = ready },
    })
  }
  const disposeLate = installRoutes(lateBase, manager, { logger: { warn() {}, info() {} } })
  check(late.webServer !== null, 'with connection late, the fallback registers first')
  eq('  -> and nothing is on the fetch carrier yet', late.fetch, null)

  // `connection` arrives only now, after the fallback is already installed.
  lateServices.connection = { fetch: { register: (route) => { late.fetch = route; return () => {} } } }
  check(typeof fireConnectionInject === 'function', 'the late-injection hook was registered')
  fireConnectionInject()

  check(late.fetch !== null, 'when connection arrives the fetch carrier is registered')
  eq('  -> on the documented path', late.fetch?.path, shared.RPC_ROUTE)
  check(webServerRouteDisposed, '  -> and the shadowing webServer fallback is torn down')
  eq('  -> leaving exactly one carrier (fetch)', late.fetch !== null && webServerRouteDisposed, true)

  disposeLate()
  check(true, 'the late-upgrade disposer ran without throwing')

  /* ---------------------------------------------------------------- *
   * 5b. installRemoteTools must WAIT for the agent's tools service.
   *
   * The bug this pins: reading `agent.ctx.tools` at `agent/created` time and
   * returning a no-op when it was undefined. The tools service is not always
   * provided that early, and the old code then installed NOTHING while logging
   * nothing -- so a Codespace session kept its local read/glob/pwsh and scanned
   * the empty placeholder directory on Windows while the system prompt claimed
   * it was in the cloud. Nothing surfaced because there was no error to see.
   * ---------------------------------------------------------------- */

  section('remote tools wiring')

  const { installRemoteTools } = await load('../lib/host/remote-tools.js')
  check(typeof installRemoteTools === 'function', 'installRemoteTools is exported')

  /**
   * Build a fake agent whose `tools` service arrives only when `inject` fires.
   *
   * @param {{toolsReady?: boolean}} [options] - whether `tools` exists up front.
   */
  function fakeAgent({ toolsReady = false } = {}) {
    const registered = []
    const restricted = []
    const toolsService = {
      register: (definition) => { registered.push(definition.name); return () => {} },
      restrict: (filter) => { restricted.push(filter); return () => {} },
      get: () => ({ name: 'present' }),
    }
    const injected = []
    const agentCtx = {
      effect: (fn) => { fn(); return () => {} },
      ...(toolsReady ? { tools: toolsService } : {}),
      // Mirrors cordis: `inject(names, cb)` starts a fiber once the service is
      // available, and hands the callback a scope that carries it.
      inject: (names, cb) => {
        injected.push(names.join(','))
        if (toolsReady) cb({ tools: toolsService })
        return { dispose: () => {} }
      },
    }
    return {
      agent: { id: 'agent-1', ctx: agentCtx },
      registered,
      restricted,
      injected,
      /** Fire the deferred injection, as cordis would when the service appears. */
      arrive: () => { cbHolder.cb({ tools: toolsService }) },
      toolsService,
    }
  }
  // `arrive` needs the callback; capture it through the inject spy.
  const cbHolder = { cb: null }

  const remoteManager = { recordOf: () => ({ path: '/workspace' }), log: () => {} }

  // (a) The service is already there: register immediately.
  {
    const fake = fakeAgent({ toolsReady: true })
    const dispose = installRemoteTools(fake.agent, {
      manager: remoteManager, workspaceId: 'ws-1', target: { kind: 'gh', codespace: 'cs', cwd: '/workspace' },
      localToolNames: ['read', 'glob', 'bash', 'pwsh'],
    })
    eq('with tools ready, all six remote tools are registered',
      fake.registered.join(','), 'read,write,edit,glob,grep,bash')
    check(fake.restricted.length === 1, 'and the local counterparts are restricted away')
    eq('  -> the deny list covers the local names',
      JSON.stringify(fake.restricted[0].deny), JSON.stringify(['read', 'glob', 'bash', 'pwsh']))
    dispose()
    check(true, 'the disposer ran without throwing')
  }

  // (b) The service is NOT there yet: the fix must defer, not give up.
  {
    const fake = fakeAgent({ toolsReady: false })
    // Capture the callback so the test can deliver the service late.
    fake.agent.ctx.inject = (names, cb) => {
      fake.injected.push(names.join(','))
      cbHolder.cb = cb
      return { dispose: () => {} }
    }
    const dispose = installRemoteTools(fake.agent, {
      manager: remoteManager, workspaceId: 'ws-2', target: { kind: 'gh', codespace: 'cs', cwd: '/workspace' },
      localToolNames: ['read', 'glob', 'bash', 'pwsh'],
    })
    eq('with tools late, it waits on the tools service', fake.injected.join(','), 'tools')
    eq('  -> and registers nothing yet', fake.registered.length, 0)

    // The service appears; the deferred callback must now do the work.
    cbHolder.cb({ tools: fake.toolsService })
    eq('when tools arrives, the remote surface is installed',
      fake.registered.join(','), 'read,write,edit,glob,grep,bash')
    check(fake.restricted.length === 1, '  -> and the local tools are hidden')
    dispose()
    check(true, 'the deferred disposer ran without throwing')
  }

  // (c) No agent context at all: a no-op, but never a throw.
  {
    const dispose = installRemoteTools({}, { manager: remoteManager, workspaceId: 'ws-3', target: { kind: 'gh', codespace: 'cs', cwd: '/' } })
    eq('an agent without a context installs nothing', typeof dispose, 'function')
    dispose()
  }

  section('remote working directory')

  const { buildTarget } = await load('../lib/host/session.js')
  /** Temp profile homes this section creates; removed alongside the readiness ones. */
  const cwdHomes = []
  const { deriveRemoteCwd, normalizeCodespace } = await load('../lib/host/github.js')
  const { remoteResolve } = await load('../lib/host/transport.js')

  const ghReady = { gh: { installed: true, authenticated: true, login: 'x', version: '2' } }
  const placeholder = 'C:\\Users\\someone\\.dsh\\codespaces\\demo-cs'

  eq('the in-container checkout is derived from the repository name',
    deriveRemoteCwd('Ckarefulon/app.ckarefulon.main'), '/workspaces/app.ckarefulon.main')
  eq('  -> a bare name works too', deriveRemoteCwd('repo'), '/workspaces/repo')
  eq('  -> a trailing slash is trimmed', deriveRemoteCwd('owner/repo/'), '/workspaces/repo')
  eq('  -> an unknown repository yields empty, never "/workspaces/undefined"', deriveRemoteCwd(''), '')
  eq('  -> a non-string yields empty', deriveRemoteCwd(null), '')
  eq('  -> a path with no name component yields empty', deriveRemoteCwd('/'), '')

  eq('normalizeCodespace reports the running Codespace sessionPath',
    normalizeCodespace({ name: 'n', repository: { full_name: 'o/r' }, connection: { sessionPath: '/workspaces/r' } }).remoteCwd,
    '/workspaces/r')
  eq('  -> and leaves it empty while stopped (only the API knows then)',
    normalizeCodespace({ name: 'n', repository: { full_name: 'o/r' } }).remoteCwd, '')

  // The bug this whole section exists for: the record's `path` is the LOCAL
  // placeholder, and using it as a remote cwd resolves every relative path
  // against `/`. Teeth: revert buildTarget to `record?.path` and the next two
  // checks flip.
  eq('a Windows placeholder path resolves relative paths against "/" (the bug)',
    remoteResolve(placeholder, 'README.md'), '/README.md')
  eq('a POSIX checkout path resolves them correctly',
    remoteResolve('/workspaces/app.ckarefulon.main', 'README.md'), '/workspaces/app.ckarefulon.main/README.md')

  eq('buildTarget prefers the resolved remote cwd',
    buildTarget(ghReady, {}, { name: 'demo-cs', path: placeholder, remoteCwd: '/workspaces/app.main' }).cwd,
    '/workspaces/app.main')
  eq('  -> it never falls back to the placeholder path',
    buildTarget(ghReady, {}, { name: 'demo-cs', path: placeholder }).cwd, '/')
  eq('  -> a non-absolute remoteCwd is rejected the same way',
    buildTarget(ghReady, {}, { name: 'demo-cs', path: placeholder, remoteCwd: 'C:\\x' }).cwd, '/')
  eq('the ssh transport gets the same cwd',
    buildTarget({ gh: { installed: false } }, { sshKeyPath: 'cs-demo' }, { name: 'demo-cs', path: placeholder, remoteCwd: '/workspaces/app.main' }).cwd,
    '/workspaces/app.main')

  // And the manager resolves it from the live Codespace, falling back to the
  // repository layout for a stopped one.
  {
    const { CodespaceManager: CwdManager } = await load('../lib/host/codespaces.js')
    const home = mkdtempSync(join(tmpdir(), 'cs-cwd-'))
    cwdHomes.push(home)
    const manager = new CwdManager({
      logger: { info: () => {}, warn: () => {} },
      profileHome: home,
      getSettings: () => ({ ...shared.SETTINGS_DEFAULTS }),
    }, {})
    manager.listCodespaces = async () => ([
      { name: 'cs-running', repository: 'o/r', state: 'Available', remoteCwd: '/workspaces/r' },
      { name: 'cs-asleep', repository: 'o/sleeper', state: 'Shutdown', remoteCwd: '' },
    ])
    manager.records.set('ws-1', { workspaceId: 'ws-1', name: 'cs-running', title: 'r', path: join(manager.root, 'cs-running'), addedAt: 0 })
    manager.records.set('ws-2', { workspaceId: 'ws-2', name: 'cs-asleep', title: 's', path: join(manager.root, 'cs-asleep'), addedAt: 0 })

    eq('a running Codespace reports its sessionPath',
      await manager.remoteCwdFor('ws-1'), '/workspaces/r')
    eq('a stopped one falls back to the clone layout',
      await manager.remoteCwdFor('ws-2'), '/workspaces/sleeper')
    eq('an unmanaged workspace has no remote cwd', await manager.remoteCwdFor('ws-none'), '/')

    // Unreachable GitHub must not lose the workspace: the repository is
    // remembered from the last successful list call.
    manager.listCodespaces = async () => { throw new Error('offline') }
    manager.remoteCwds.clear()
    eq('an unreachable GitHub still yields a usable path',
      await manager.remoteCwdFor('ws-1'), '/workspaces/r')
    manager.dispose()
  }

  /* ---------------------------------------------------------------- *
   * 5d. The registered definitions must PASS the harness's own schema gate.
   *
   * This is the bug that made the plugin "not work" in the real GUI: the tool
   * definitions carried authoring shorthand (`required: true` on a property
   * node) but `tools.register()` takes a REGISTRY-READY raw JSON Schema and
   * runs `assertSupportedJsonSchema()` on it. Every registration threw, the
   * per-tool catch swallowed it into a single `warn`, and the agent silently
   * kept its LOCAL tools while the prompt said it was in the cloud.
   *
   * The gate below is a faithful miniature of
   * `@deepseek-ai/dsh-tools`' `assertSupportedJsonSchema` (the plugin cannot
   * import the real one: it is not a dependency and does not resolve from the
   * installed package). Teeth: reverting to `tools.register(definition)`
   * (bypassing `registryDefinition`) turns every case here red.
   * ---------------------------------------------------------------- */

  section('registered tool schemas pass the registry gate')

  const { registryDefinition, registrySchema, parameterSchema } = await load('../lib/host/schema.js')

  /**
   * The supported keyword subset, and which node types each keyword belongs to.
   * Mirrors `SCHEMA_TYPES` + `allowedFor` in the harness's json-schema module.
   */
  const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  const ALLOWED_FOR = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  }
  const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', '$comment'])
  const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

  /**
   * Collect every violation the harness gate would report for one schema.
   *
   * @param {unknown} schema - candidate raw JSON Schema.
   * @returns {string[]} violations; empty means the registry would accept it.
   */
  function gateViolations(schema) {
    const violations = []
    const walk = (node, path) => {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        violations.push(`${path} must be a schema object`)
        return
      }
      for (const key of Object.keys(node)) {
        if (['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'].includes(key)) continue
        if (ANNOTATIONS.has(key)) continue
        violations.push(`${path}.${key} is not a supported keyword`)
      }
      const hasType = Object.hasOwn(node, 'type')
      const hasOneOf = Object.hasOwn(node, 'oneOf')
      if (hasType && hasOneOf) {
        violations.push(`${path} cannot declare both type and oneOf`)
        return
      }
      if (!hasType && !hasOneOf) {
        for (const key of ONE_OF_SIBLINGS) {
          if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
        }
        return
      }
      if (hasOneOf) {
        if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${path}.oneOf must have at least two schemas`)
        else node.oneOf.forEach((member, index) => walk(member, `${path}.oneOf[${index}]`))
        return
      }
      const type = node.type
      if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
        violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
        return
      }
      for (const [key, types] of Object.entries(ALLOWED_FOR)) {
        if (Object.hasOwn(node, key) && !types.includes(type)) {
          violations.push(`${path}.${key} is not supported on type "${type}"`)
        }
      }
      if (type === 'object') {
        if (Object.hasOwn(node, 'required')) {
          const required = node.required
          if (!Array.isArray(required) || required.some((name) => typeof name !== 'string')) {
            violations.push(`${path}.required must be an array of strings`)
          }
        }
        if (Object.hasOwn(node, 'properties')) {
          if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
            violations.push(`${path}.properties must be an object of schemas`)
          } else {
            for (const [name, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${name}`)
          }
        }
        // Every name in `required` must actually be declared.
        if (Array.isArray(node.required) && node.properties !== undefined) {
          for (const name of node.required) {
            if (!Object.hasOwn(node.properties, name)) {
              violations.push(`${path}.required names undeclared property "${name}"`)
            }
          }
        }
      }
      if (type === 'array' && Object.hasOwn(node, 'items')) walk(node.items, `${path}.items`)
      if (Object.hasOwn(node, 'enum') && (!Array.isArray(node.enum) || node.enum.length === 0)) {
        violations.push(`${path}.enum must be a non-empty array`)
      }
    }
    walk(schema, 'schema')
    return violations
  }

  // The gate itself has teeth: the OLD shape (property-level `required`) is
  // rejected, and the new one is accepted. If this ever stops failing, the
  // cases below stop proving anything.
  check(gateViolations({ type: 'object', properties: { a: { type: 'string', required: true } } }).length > 0,
    'the replica gate rejects a property-level `required` (mirrors the real one)')
  eq('  -> and accepts the object-level form',
    JSON.stringify(gateViolations({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })), '[]')

  eq('registrySchema lifts a property-level required to the object level',
    JSON.stringify(registrySchema({ type: 'object', properties: { a: { type: 'string', required: true }, b: { type: 'string' } } })),
    JSON.stringify({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] }))
  eq('  -> and omits `required` entirely when nothing is required',
    JSON.stringify(registrySchema({ type: 'object', properties: { a: { type: 'string' } } })),
    JSON.stringify({ type: 'object', properties: { a: { type: 'string' } } }))
  eq('registrySchema recurses into array items and drops `required` beside oneOf',
    JSON.stringify(registrySchema({
      type: 'object',
      properties: {
        before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        list: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer', required: true } } } },
      },
    })),
    JSON.stringify({
      type: 'object',
      properties: {
        before: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        list: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
      },
      required: ['before'],
    }))
  eq('parameterSchema builds the implicit object root the wire expects',
    JSON.stringify(parameterSchema({ file_path: { type: 'string', required: true }, limit: { type: 'number' } })),
    JSON.stringify({ type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } }, required: ['file_path'] }))

  // Now the real thing: install the surface into a fake registry that applies
  // the gate exactly as `ToolsService.register()` does, and require ZERO
  // violations 鈥?not "at most a warn".
  {
    const accepted = []
    const rejected = []
    const gatedTools = {
      view: () => ({ restrictableNames: new Set(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'read_image']) }),
      get: (name) => (['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'read_image'].includes(name) ? { name } : undefined),
      register: (definition) => {
        if (definition.output === undefined || typeof definition.output.render !== 'function') {
          rejected.push(`${definition.name}: missing output.render`)
          throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`)
        }
        // This is the line the plugin used to lose on, in the real harness.
        const violations = gateViolations(definition.output.schema)
        if (violations.length > 0) {
          rejected.push(`${definition.name}: ${violations.join('; ')}`)
          throw new Error(`unsupported JSON schema: ${violations.join('; ')}`)
        }
        // `parameters` is projected to the model verbatim; it must already be
        // a raw schema, not the authoring map.
        if (definition.parameters?.type !== 'object' || definition.parameters?.properties === undefined) {
          rejected.push(`${definition.name}: parameters are not a raw object schema`)
          throw new Error('parameters must be a raw object schema')
        }
        accepted.push(definition.name)
        return () => {}
      },
      restrict: () => () => {},
    }
    const agentCtx = {
      effect: (fn) => { fn(); return () => {} },
      inject: (_names, cb) => { cb({ tools: gatedTools }); return { dispose: () => {} } },
    }
    const warnings = []
    installRemoteTools({ id: 'agent-gate', ctx: agentCtx }, {
      manager: { recordOf: () => ({ path: '/workspace' }), log: (level, message) => warnings.push(`${level}: ${message}`) },
      workspaceId: 'ws-gate',
      target: { kind: 'gh', codespace: 'cs', cwd: '/workspace' },
      localToolNames: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'read_image'],
    })
    eq('every remote tool passes the registry gate', accepted.join(','), 'read,write,edit,glob,grep,bash')
    eq('  -> and none was rejected', JSON.stringify(rejected), '[]')
    eq('  -> and no warning was logged', JSON.stringify(warnings), '[]')
  }

  /* ---------------------------------------------------------------- *
   * 6. Workspace naming.
   * ---------------------------------------------------------------- */

  section('workspace naming')

  // The row is titled after the REPOSITORY, because a Codespace's own name is
  // machine-generated (`psychic-goggles-7v9974jwpwr5fpqxq`) and says nothing
  // about which project the row is.
  const { titleForCodespace } = await load('../lib/host/codespaces.js')
  check(typeof titleForCodespace === 'function', 'titleForCodespace is exported')
  eq('owner/name -> the repository short name',
    titleForCodespace({ repository: 'Ckarefulon/app.ckarefulon.main', name: 'psychic-goggles-7v9974jwpwr5fpqxq' }),
    'app.ckarefulon.main')
  eq('a bare name is used as-is', titleForCodespace({ repository: 'app.main', name: 'cs-1' }), 'app.main')
  eq('the LAST slash splits it (an org path cannot be mistaken for the name)',
    titleForCodespace({ repository: 'org/sub/name', name: 'cs-1' }), 'name')
  eq('an unknown repository falls back to displayName, then name',
    titleForCodespace({ repository: '', displayName: 'My Box', name: 'cs-1' }), 'My Box')
  eq('  -> and to the Codespace name when there is no displayName',
    titleForCodespace({ repository: '', displayName: '', name: 'cs-1' }), 'cs-1')
  eq('the machine-generated Codespace name is never chosen over a repository',
    titleForCodespace({ repository: 'o/r', displayName: 'o/r', name: 'cs-1' }), 'r')
  eq('a whitespace-only repository is treated as unknown',
    titleForCodespace({ repository: '   ', displayName: '', name: 'cs-1' }), 'cs-1')
  eq('a repository with a trailing slash still yields a name',
    titleForCodespace({ repository: 'owner/name/', name: 'cs-1' }), 'name')
  eq('nothing known yields an empty string, never "undefined"', titleForCodespace({}), '')
  eq('a non-object is handled', titleForCodespace(null), '')

  /* ---------------------------------------------------------------- *
   * 7. Codespace readiness (the "wait for it to start" path).
   * ---------------------------------------------------------------- */

  section('codespace readiness')

  const { CodespaceManager } = await load('../lib/host/codespaces.js')
  check(typeof CodespaceManager === 'function', 'CodespaceManager is exported')

  const roots = []
  /**
   * A manager whose GitHub calls are scripted.
   *
   * `states` is what `listCodespaces` reports on successive calls; the LAST value
   * repeats forever, which is how the timeout case is expressed. Each listing
   * advances the sequence and `start` does not, because it is the listing that
   * observes a state 鈥?a real `start` changes GitHub's state, not our cursor.
   *
   * @param {string[]} states - the state sequence.
   * @param {{missing?: boolean, startFails?: boolean, listFails?: boolean}} [options] - failure switches.
   * @returns {{manager: object, calls: {listed: number, started: number}}} the fake.
   */
  function readinessManager(states, options = {}) {
    const home = mkdtempSync(join(tmpdir(), 'dcw-ready-'))
    roots.push(home)
    const manager = new CodespaceManager({}, { profileHome: home })
    manager.records.set('ws-1', {
      workspaceId: 'ws-1', name: 'cs-1', title: 'app', path: join(home, 'cs-1'), addedAt: 0,
    })
    manager.loaded = true
    const calls = { listed: 0, started: 0 }
    let cursor = 0
    manager.listCodespaces = async () => {
      calls.listed += 1
      if (options.listFails === true) throw new Error('offline')
      const state = states[Math.min(cursor, states.length - 1)]
      cursor += 1
      return options.missing === true ? [] : [{ name: 'cs-1', state }]
    }
    manager.start = async (name) => {
      calls.started += 1
      if (options.startFails === true) throw new Error('start rejected')
      return { name, state: states[Math.min(cursor, states.length - 1)] }
    }
    return { manager, calls }
  }

  const FAST = { pollMs: 1, timeoutMs: 400 }

  // Already running: no start request, and the state is remembered.
  {
    const { manager, calls } = readinessManager(['Available'])
    const first = await manager.ensureRunning('ws-1', FAST)
    check(first.ok === true, 'a running Codespace is ready')
    eq('  -> and nothing was started', calls.started, 0)
    eq('  -> after exactly one listing', calls.listed, 1)
    const second = await manager.ensureRunning('ws-1', FAST)
    eq('a second call within the memo window does not re-list', calls.listed, 1)
    eq('  -> and reports why', second.reason, 'remembered')
    manager.forgetRunning('cs-1')
    await manager.ensureRunning('ws-1', FAST)
    eq('forgetting the memo makes it check again', calls.listed, 2)
  }

  // Stopped: it is started, and the wait polls until the state settles.
  {
    const { manager, calls } = readinessManager(['Shutdown', 'Provisioning', 'Available'])
    const outcome = await manager.ensureRunning('ws-1', FAST)
    check(outcome.ok === true, 'a stopped Codespace is started and then waited for')
    eq('  -> exactly one start request', calls.started, 1)
    eq('  -> and the outcome says it was started', outcome.reason, 'started')
  }

  // Already transitioning: NOT started again, just waited out.
  {
    const { manager, calls } = readinessManager(['Provisioning', 'Available'])
    const outcome = await manager.ensureRunning('ws-1', FAST)
    check(outcome.ok === true, 'a Codespace already coming up is waited for')
    eq('  -> without a second start request', calls.started, 0)
    eq('  -> and the outcome says so', outcome.reason, 'became-running')
  }

  // Never settles: bounded, and reported rather than thrown.
  {
    const { manager } = readinessManager(['Provisioning'])
    const outcome = await manager.ensureRunning('ws-1', FAST)
    check(outcome.ok === false, 'a Codespace that never settles gives up')
    eq('  -> saying why', outcome.reason, 'timeout')
    eq('  -> and carrying the last state', outcome.state, 'Provisioning')
  }

  // A terminal failure stops the wait immediately.
  {
    const { manager } = readinessManager(['Shutdown', 'Failed'])
    const outcome = await manager.ensureRunning('ws-1', FAST)
    eq('a failed transition is reported, not waited out', outcome.reason, 'failed')
  }

  // Every "cannot" path is a value, never a throw -- the turn must still run.
  {
    const unmanaged = await readinessManager(['Available']).manager.ensureRunning('nope', FAST)
    eq('an unmanaged workspace is reported', unmanaged.reason, 'unmanaged')
    const missing = await readinessManager(['Available'], { missing: true }).manager.ensureRunning('ws-1', FAST)
    eq('a Codespace GitHub no longer has is reported', missing.reason, 'missing')
    const offline = await readinessManager(['Available'], { listFails: true }).manager.ensureRunning('ws-1', FAST)
    eq('an unreachable API is reported', offline.reason, 'unreachable')
    const refused = await readinessManager(['Shutdown'], { startFails: true }).manager.ensureRunning('ws-1', FAST)
    eq('a refused start is reported', refused.reason, 'start-failed')
  }

  // An aborted turn stops waiting immediately (that is the user cancelling).
  {
    const { manager } = readinessManager(['Shutdown', 'Provisioning'])
    const controller = new AbortController()
    controller.abort()
    const outcome = await manager.ensureRunning('ws-1', { ...FAST, signal: controller.signal })
    eq('an abort stops the wait', outcome.reason, 'aborted')
  }
  {
    // Aborting mid-wait must not require the full poll to elapse.
    const { manager } = readinessManager(['Shutdown', 'Provisioning'])
    const controller = new AbortController()
    const started = Date.now()
    const pending = manager.ensureRunning('ws-1', { signal: controller.signal, pollMs: 5000, timeoutMs: 60000 })
    setTimeout(() => controller.abort(), 20)
    const outcome = await pending
    eq('aborting mid-wait returns immediately', outcome.reason, 'aborted')
    check(Date.now() - started < 3000, '  -> without waiting out the poll interval',
      `${Date.now() - started}ms`)
  }

  /* ---------------------------------------------------------------- *
   * 8. The pre-step gate (what makes the message actually wait).
   * ---------------------------------------------------------------- */

  section('pre-step readiness gate')

  const { installSessionWiring } = await load('../lib/host/session.js')
  {
    const handlers = new Map()
    const effects = []
    const fakeCtx = {
      effect: (fn) => {
        const dispose = fn()
        effects.push(dispose)
        return () => { if (typeof dispose === 'function') dispose() }
      },
      on: (name, handler) => {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
      logger: { info() {}, warn() {}, error() {} },
    }
    const gateCalls = []
    const gateManager = {
      isCodespacePath: (cwd) => (cwd === '/cloud' ? 'ws-1' : undefined),
      ensureRunning: async (id, options) => {
        gateCalls.push({ id, signal: options?.signal })
        return { ok: true, reason: 'running' }
      },
      dispose() {},
      stopAll: async () => ({ attempted: 0, stopped: 0, pending: [] }),
    }

    const teardown = installSessionWiring(fakeCtx, gateManager, { getSettings: () => ({}) })
    const gate = handlers.get('agent/pre-step')
    check(typeof gate === 'function', 'installSessionWiring registers an agent/pre-step handler')

    const okNext = async () => ({ kind: 'enter', messages: ['kept'] })
    let passed = 0
    const next = async () => { passed += 1; return okNext() }

    // A local session must not be delayed at all.
    const local = await gate({ agent: { session: { header: { cwd: '/local' } } } }, next)
    eq('a local session skips the gate', gateCalls.length, 0)
    eq('  -> and the decision chain still runs', local.kind, 'enter')

    // A Codespace session waits, and the agent's signal is forwarded.
    const controller = new AbortController()
    const before = passed
    await gate({ agent: { session: { header: { cwd: '/cloud' } } }, signal: controller.signal }, next)
    eq('a Codespace session asks for readiness', gateCalls.length, 1)
    eq('  -> for the right workspace', gateCalls[0].id, 'ws-1')
    check(gateCalls[0].signal === controller.signal, '  -> forwarding the turn鈥檚 abort signal')
    eq('  -> and the decision chain still runs', passed, before + 1)

    // A failure inside the gate must not break the turn.
    gateManager.ensureRunning = async () => { throw new Error('boom') }
    const survived = await gate({ agent: { session: { header: { cwd: '/cloud' } } } }, next)
    eq('a gate that throws still lets the turn run', survived.kind, 'enter')

    teardown()
    check(handlers.get('agent/pre-step') === undefined, 'teardown removes the gate')
  }

  /* ---------------------------------------------------------------- *
   * 9. Shell quoting.
   * ---------------------------------------------------------------- */

  section('shell quoting')

  const { shq } = await load('../lib/host/gh.js')
  check(typeof shq === 'function', 'shq is exported')
  eq('a plain word is single-quoted', shq('main'), "'main'")
  eq('an embedded quote is escaped POSIX-correctly', shq("a'b"), "'a'\\''b'")
  eq('a semicolon cannot break out', shq('x; rm -rf /'), "'x; rm -rf /'")
  eq('a backtick cannot break out', shq('`whoami`'), "'`whoami`'")
  eq('a dollar sign cannot expand', shq('$HOME'), "'$HOME'")
  eq('an empty string still quotes', shq(''), "''")

  /* ---------------------------------------------------------------- *
   * 5c. Classification of `gh codespace ssh` failures.
   *
   * Two very different situations look identical on the wire — exit code -1
   * with a stderr paragraph — and they need OPPOSITE advice:
   *   · the Codespace is asleep        -> press Start
   *   · the container has no sshd      -> edit devcontainer.json and rebuild
   * Telling a user to "start" a running Codespace sends them in a circle, so
   * the two predicates must not overlap.
   *
   * Real stderr of the second case, captured from gh 2.102.0 against a Java
   * devcontainer built from a custom Dockerfile: the RPC detail is EMPTY and
   * only gh's generic advice follows the header.
   * ---------------------------------------------------------------- */

  section('gh failure classification')

  const { isNotRunning, needsSSHServer } = await load('../lib/host/gh.js')
  check(typeof needsSSHServer === 'function', 'needsSSHServer is exported')

  const noSSHDOutput = {
    exitCode: -1,
    stderr: 'error getting ssh server details: failed to start SSH server: \n'
      + 'Please check if an SSH server is installed in the container.\n'
      + 'If the docker image being used for the codespace does not have an SSH server,\n'
      + 'install it in your Dockerfile or, for codespaces that use Debian-based images,\n'
      + 'you can add the following to your devcontainer.json:\n\n'
      + '"features": { "ghcr.io/devcontainers/features/sshd:1": { "version": "latest" } }\n',
  }
  const asleepOutput = {
    exitCode: -1,
    stderr: 'error: codespace is not running, please start the codespace and try again',
  }

  check(needsSSHServer(noSSHDOutput), 'an sshd-less container is classified as such')
  check(!isNotRunning(noSSHDOutput), '  -> and NOT as "not running" (a running box would send the user in a circle)')
  check(isNotRunning(asleepOutput), 'a stopped Codespace is classified as not running')
  check(!needsSSHServer(asleepOutput), '  -> and NOT as "no sshd"')
  check(!needsSSHServer({ stderr: '' }), 'an unrelated failure matches neither')
  check(!needsSSHServer({}), 'a result without stderr matches neither')

  const { remoteExec } = await load('../lib/host/transport.js')
  const ghTarget = { kind: 'gh', codespace: 'cs-no-sshd', cwd: '/workspace' }

  const noSSHDError = await remoteExec(ghTarget, 'true', {
    run: async () => ({ ...noSSHDOutput }),
  }).then(() => null, (error) => error)
  check(noSSHDError !== null, 'a no-sshd transport failure is surfaced, not swallowed')
  eq('  -> with its own actionable code', noSSHDError?.code, 'E_REMOTE_NO_SSHD')
  check(noSSHDError?.message.includes('features') === true,
    '  -> the message names the devcontainer feature that fixes it', noSSHDError?.message)
  check(noSSHDError?.message.includes('rebuild') === true,
    '  -> and says the Codespace has to be rebuilt', noSSHDError?.message)

  const asleepError = await remoteExec(ghTarget, 'true', {
    run: async () => ({ ...asleepOutput }),
  }).then(() => null, (error) => error)
  eq('a sleeping Codespace keeps its own code', asleepError?.code, 'E_REMOTE_NOT_RUNNING')

  /* ---------------------------------------------------------------- *
   * 5e. The remote stat must actually parse.
   *
   * GNU `stat -c` does not interpret backslash escapes (only `--printf`
   * does), and the format reaches it through a double-quoted shell word, so
   * `stat -c "%F\t%s\t%Y"` prints one field with literal backslash-t runs.
   * Splitting on a real tab then found nothing, `remoteStat` returned `null`,
   * and every caller reads `null` as "the path does not exist" — `read`
   * answered "not found" for files that were plainly there, while the very
   * same file read through `remoteReadText` succeeded.
   *
   * Captured from the real container (GNU coreutils 9.1):
   *   stat -c "%F\t%s\t%Y" f  ->  regular file\t10094\t1794644544
   * ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- *
   * 5e-bis. The data plane must not depend on a caller remembering `run`.
   *
   * `remoteExec`'s `gh` branch used to THROW `E_REMOTE_TARGET: the gh
   * transport requires an injected executor` whenever `run` was absent, while
   * `ghInfo()` and `CodespaceManager` both defaulted to `defaultRun`. That
   * asymmetry shipped in 0.1.3: `lib/index.js` called
   * `installSessionWiring(ctx, manager, { getSettings })` without forwarding
   * `run`, so all six remote tools registered perfectly and then EVERY single
   * call failed. The control plane (status/start/stop) stayed green, so nothing
   * looked broken until a model actually touched a file.
   *
   * Two directions are asserted:
   *   a. the transport invents the process executor when none is injected,
   *   b. `lib/index.js` still forwards the manager's executor.
   * ---------------------------------------------------------------- */

  section('executor wiring')

  {
    const { remoteExec } = await import(new URL('../lib/host/transport.js', import.meta.url))

    // (a) No `run` at all: the call must get PAST the executor check. `gh` may
    // not be installed and the Codespace may not exist, so the assertion is on
    // the failure KIND, never on success: anything but E_REMOTE_TARGET proves
    // an executor was resolved.
    let kind = 'resolved'
    let message = ''
    try {
      const result = await remoteExec(
        { kind: 'gh', codespace: 'dsh-nonexistent-probe', cwd: '/' },
        'echo hi',
        { timeoutMs: 5000 },
      )
      kind = result.exitCode === 0 ? 'ran' : `exit ${result.exitCode}`
      message = result.stderr ?? ''
    } catch (error) {
      kind = error?.code ?? 'threw'
      message = error?.message ?? ''
    }
    check(kind !== 'E_REMOTE_TARGET',
      'an absent executor defaults to the process runner instead of throwing',
      `${kind}: ${message}`)
    check(!/requires an injected executor/.test(message),
      '  -> the old "requires an injected executor" message is gone', message)

    // A supplied executor must still win, so tests and custom spawners keep
    // working instead of being silently overridden by the default.
    let seen = 0
    const result = await remoteExec(
      { kind: 'gh', codespace: 'cs-fake', cwd: '/' },
      'echo hi',
      { run: async () => { seen += 1; return { stdout: 'hi\n', stderr: '', exitCode: 0 } } },
    )
    eq('an injected executor is still used when supplied', seen, 1)
    eq('  -> and its output is returned', result.stdout, 'hi\n')
  }

  {
    // (b) `lib/index.js` must hand the manager's executor to session wiring.
    // A source assertion is the only cheap way to catch this: the wiring is
    // built inside `apply()`, which needs a live Cordis context. The regex
    // tolerates the multi-line object literal the call is written with.
    const indexSource = readFileSync(resolve(here, '..', 'lib', 'index.js'), 'utf8')
    const call = indexSource.replace(/\s+/g, ' ')
    check(/installSessionWiring\([^)]*\{[^}]*\brun\b/.test(call),
      'lib/index.js forwards `run` into installSessionWiring',
      indexSource.split('\n').filter((l) => l.includes('installSessionWiring')).join(' | '))
  }

  section('remote stat parsing')

  const { remoteStat } = await load('../lib/host/transport.js')
  const statTarget = { kind: 'gh', codespace: 'cs-stat', cwd: '/' }

  const regularFile = await remoteStat(statTarget, '/tmp/x', {
    run: async () => ({ stdout: 'regular file|10094|1794644544\n', stderr: '', exitCode: 0 }),
  })
  eq('a pipe-separated regular file parses', JSON.stringify(regularFile),
    JSON.stringify({ type: 'file', size: 10094, mtimeMs: 1794644544000 }))

  const directory = await remoteStat(statTarget, '/tmp/x', {
    run: async () => ({ stdout: 'directory|4096|1794644544\n', stderr: '', exitCode: 0 }),
  })
  eq('  -> a directory is recognized', directory?.type, 'dir')

  const literalTabs = await remoteStat(statTarget, '/tmp/x', {
    // Exactly what the old `\t` format produced on GNU stat.
    run: async () => ({ stdout: 'regular file\\t10094\\t1794644544\n', stderr: '', exitCode: 0 }),
  })
  eq('the old backslash-t shape yields null (which callers read as "missing")', literalTabs, null)

  const missing = await remoteStat(statTarget, '/tmp/x', {
    run: async () => ({ stdout: 'DSH_MISSING\n', stderr: '', exitCode: 0 }),
  })
  eq('DSH_MISSING is reported as absent', missing, null)

  const failed = await remoteStat(statTarget, '/tmp/x', {
    run: async () => ({ stdout: '', stderr: 'boom', exitCode: 2 }),
  })
  eq('a failed stat is absent, not a throw', failed, null)

  const { shq: shqForStat } = await load('../lib/host/gh.js')
  const builtForStat = shqForStat('/tmp/x')
  check(builtForStat.startsWith("'") && builtForStat.endsWith("'"),
    'the stat path is quoted', builtForStat)

  /* ---------------------------------------------------------------- *
   * 5f. Search must not report a false "no matches".
   *
   * A stock Codespace image has no `rg`. The old grep command was
   * `rg … 2>/dev/null | head`, so a missing rg produced empty stdout and exit
   * 0 — every search answered "(no matches)". Verified in the real container:
   * `command -v rg` prints nothing there.
   * ---------------------------------------------------------------- */

  section('remote search fallbacks')

  const { installRemoteTools: installForSearch } = await load('../lib/host/remote-tools.js')
  const searchCommands = []
  const searchTools = {
    view: () => ({ restrictableNames: new Set() }),
    get: () => undefined,
    register: (definition) => {
      searchCommands.push(definition)
      return () => {}
    },
    restrict: () => () => {},
  }
  installForSearch({ id: 'search', ctx: {
    effect: (fn) => { fn(); return () => {} },
    inject: (_n, cb) => { cb({ tools: searchTools }); return { dispose: () => {} } },
  } }, {
    manager: { recordOf: () => ({ path: '/workspaces/app' }), log: () => {} },
    workspaceId: 'ws-search',
    target: { kind: 'gh', codespace: 'cs-search', cwd: '/workspaces/app' },
    localToolNames: [],
    // Capture the command line each tool builds without touching a network.
    run: async (_cmd, args) => {
      searchCommands.push(args[args.length - 1])
      // Records are NUL-separated: `<path>\0<line>:<text>\n`. `grep -Z` and
      // `rg --null` both emit this, and it is the only delimiter that survives
      // a matching line containing colons.
      return { stdout: 'package.json\u00003:  "name": "x"\n', stderr: '', exitCode: 0 }
    },
  })

  const grepTool = searchCommands.find((d) => d.name === 'grep')
  const globTool = searchCommands.find((d) => d.name === 'glob')
  check(grepTool !== undefined, 'the grep tool is registered for the search probe')
  await grepTool.execute({ pattern: 'name', include: '*.json' }, {})
  await globTool.execute({ pattern: '**/*.json' }, {})

  const grepCommand = searchCommands.find((c) => typeof c === 'string' && c.includes('grep'))
  const globCommand = searchCommands.find((c) => typeof c === 'string' && c.includes('find . -type f'))
  check(grepCommand !== undefined && grepCommand.includes('command -v rg'),
    'grep branches on whether rg exists', grepCommand)
  check(grepCommand !== undefined && grepCommand.includes('grep -rEn'),
    '  -> and falls back to a recursive grep', grepCommand)
  check(globCommand !== undefined && globCommand.includes('|| true'),
    'glob tolerates an unreadable subdirectory', globCommand)

  /* ---------------------------------------------------------------- *
   * 5f-bis. A matching LINE may contain colons.
   *
   * The parsed record used to be located by taking the last two colons of the
   * line. That is correct only when the matched text has none, which is not the
   * common case in this very repository: the whole point of the search is
   * usually something like `ghcr.io/devcontainers/features/sshd:1`. Such a
   * match was parsed as path `.../devcontainer.json:20:    "ghcr.io/.../sshd`
   * and then DISCARDED because the trailing field was not a number — a silent
   * false negative on precisely the hits worth finding. Verified live: a
   * cwd-rooted search for the sshd feature returned 0 matches before the fix
   * and 3 after.
   * ---------------------------------------------------------------- */

  section('grep record parsing')

  {
    const registered = []
    let captured = ''
    const tools = {
      view: () => ({ restrictableNames: new Set() }),
      get: () => undefined,
      register: (definition) => { registered.push(definition); return () => {} },
      restrict: () => () => {},
    }
    const { installRemoteTools: installForColon } = await load('../lib/host/remote-tools.js')
    installForColon({ id: 'colon', ctx: {
      effect: (fn) => { fn(); return () => {} },
      inject: (_n, cb) => { cb({ tools }); return { dispose: () => {} } },
    } }, {
      manager: { recordOf: () => ({ path: '/workspaces/app' }), log: () => {} },
      workspaceId: 'ws-colon',
      target: { kind: 'gh', codespace: 'cs-colon', cwd: '/workspaces/app' },
      localToolNames: [],
      run: async (_cmd, args) => {
        captured = args[args.length - 1]
        // Three records whose matched TEXT contains colons, in the shapes this
        // repository actually produces.
        return {
          stdout: '.devcontainer/devcontainer.json\u000014:    "sshd:1": {\n'
            + '.devcontainer/devcontainer.json\u000020:    "ghcr.io/x/sshd:1": {\n'
            + 'docs/a.md\u00007:url = "https://example.com:8443/x"\n',
          stderr: '',
          exitCode: 0,
        }
      },
    })

    const colonGrep = registered.find((d) => d.name === 'grep')
    check(colonGrep !== undefined, 'the grep tool is registered for the colon probe')

    const parsed = await colonGrep.execute({ pattern: 'sshd' }, {})
    eq('a line containing colons survives parsing', parsed.matches.length, 3)
    eq('  -> the path keeps its directory', parsed.matches[0]?.path, '.devcontainer/devcontainer.json')
    eq('  -> the line number is intact', parsed.matches[0]?.lineNumber, 14)
    eq('  -> and the text keeps every colon', parsed.matches[1]?.line,
      '    "ghcr.io/x/sshd:1": {')
    eq('a URL port in the matched text does not break the record either',
      parsed.matches[2]?.line, 'url = "https://example.com:8443/x"')

    // The command must ask for NUL-separated records, or none of the above holds.
    check(captured.includes('--null') && captured.includes('-rEnZ'),
      'the grep command requests NUL-separated records from both searchers', captured)
  }

  // The readiness fakes each made a throwaway profile home.
  for (const home of [...roots, ...cwdHomes]) {
    try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/* ------------------------------------------------------------------ *
 * 7. The client bundle's shape.
 * ------------------------------------------------------------------ */

section('client bundle')

check(clientSource.includes('__ModuleLoader__'), 'the bundle registers through __ModuleLoader__')
check(clientSource.includes("id: 'dsh-codespace-workspace'"), 'the bundle id is the package name')
check(!/^\s*export\s/m.test(clientSource), 'the bundle has no ESM export statement')
check(!/^\s*import\s+[^(]/m.test(clientSource), 'the bundle has no ESM import statement')
const requires = [...clientSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
eq('react is the only module the bundle requires',
  JSON.stringify([...new Set(requires)]), JSON.stringify(['react']))

// The runner's dynamic context proxy gates DIRECT service access (`ctx.locale`)
// on the plugin's `inject` declaration, but `ctx.get(name)` is ungated
// (`readService(name, false)` in `dsh-cordis-client-runner/lib/client.js`). Our
// client reads `locale` optionally through `ctx.get`, so it must NOT be listed
// as a hard inject: doing so would park the whole package whenever the locale
// provider is absent, for a dictionary we already carry an inline fallback for.
const declaresLocale = /inject\s*=\s*\[[^\]]*'locale'/.test(clientSource)
check(!declaresLocale, 'the client does not hard-inject "locale" (it is read optionally via ctx.get)')
check(clientSource.includes("ctx.get('locale')"),
  '  -> and it does read locale through the ungated ctx.get')
check(/ctx\.get\('slots'\)/.test(clientSource) || /ctx\.slots\b/.test(clientSource),
  'the client reaches the slots service')

try {
  new vm.Script(clientSource)
  check(true, 'the bundle parses as a classic script')
} catch (error) {
  check(false, 'the bundle parses as a classic script', String(error))
}

// A Temporal Dead Zone hazard the browser actually caught once: the stylesheet
// reads the CSS-module suffix constants, so they must be declared before it.
const cssIndex = clientSource.indexOf('const CSS = [')
const suffixDecl = clientSource.indexOf('const HEADER_ACTIONS_SUFFIX')
check(suffixDecl !== -1 && suffixDecl < cssIndex,
  'the CSS-module suffix constants are declared before the stylesheet that uses them')

/* ------------------------------------------------------------------ *
 * 8. Locale parity.
 * ------------------------------------------------------------------ */

section('locale parity')

const zh = JSON.parse(readFileSync(join(root, 'locale/zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(root, 'locale/en.json'), 'utf8'))
const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([key, value]) =>
  value !== null && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`])
const zhKeys = flatten(zh).sort()
const enKeys = flatten(en).sort()
eq('the two locales have the same key count', zhKeys.length, enKeys.length)
const missing = zhKeys.filter((k) => !enKeys.includes(k))
const extra = enKeys.filter((k) => !zhKeys.includes(k))
check(missing.length === 0 && extra.length === 0, 'the two locales have identical keys',
  `missing in en: [${missing.join(',')}] extra in en: [${extra.join(',')}]`)
check(zhKeys.length >= 100, 'the locale has a realistic number of keys', String(zhKeys.length))

// Every t('...') key the client uses must exist in the locale. `nav` and the
// settings section title are supplied by the host, so they are exempt.
const used = [...clientSource.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1])
const absentKeys = [...new Set(used)].filter((key) => !zhKeys.includes(key))
check(absentKeys.length === 0, 'every t() key used by the client exists in the locale', absentKeys.join(', '))

// The reverse direction: a key nothing reads is dead weight, and dead keys
// accumulate quietly after a UI change (this caught one after the launcher
// moved out of the sidebar footer). `nav` is exempt because the HOST reads it
// for the settings nav entry, not the client.
const HOST_SUPPLIED = new Set(['nav'])
const unusedKeys = zhKeys.filter((key) => {
  if (HOST_SUPPLIED.has(key)) return false
  if (clientSource.includes(`'${key}'`)) return false
  // Dynamic keys: t('prefix.' + value) 鈥?the literal prefix is what to look for.
  const dot = key.lastIndexOf('.')
  if (dot > 0 && clientSource.includes(`'${key.slice(0, dot + 1)}`)) return false
  return true
})
check(unusedKeys.length === 0, 'the locale has no keys the client never reads', unusedKeys.join(', '))

// The client bundle carries its OWN copy of both dictionaries, used when no
// `locale` service is present (the browser harness runs that way). Nothing above
// compares those two copies against `locale/*.json`, so a key added to only one
// side ships a literal `row.hoverRepo` to the user 鈥?which is exactly what
// happened once. Extract both inline tables and require them to match the JSON.
{
  const inlineTables = [...clientSource.matchAll(/MESSAGES_(ZH|EN) = \{([\s\S]*?)\n    \}/g)]
  eq('both inline dictionaries are found in the bundle', inlineTables.length, 2)
  for (const [, lang, body] of inlineTables) {
    const keys = [...body.matchAll(/'([a-zA-Z0-9_.]+)':/g)].map((m) => m[1]).sort()
    // `nav` is read by the HOST for the settings nav entry, never by the client,
    // so the inline tables legitimately omit it.
    const expected = (lang === 'ZH' ? zhKeys : enKeys).filter((k) => !HOST_SUPPLIED.has(k))
    const absent = expected.filter((k) => !keys.includes(k))
    const stray = keys.filter((k) => !expected.includes(k))
    check(absent.length === 0 && stray.length === 0,
      `the inline ${lang} dictionary matches locale/${lang === 'ZH' ? 'zh' : 'en'}.json`,
      `missing inline: [${absent.join(',')}] stray inline: [${stray.join(',')}]`)
  }
}

} finally {
  // Remove the junction WITHOUT recursing. `rmSync(..., {recursive:true})` on a
  // Windows directory junction follows it and deletes the TARGET's contents 鈥?  // which here is the user's live DSH profile. `rmdirSync` unlinks the junction
  // itself and leaves the target untouched, which is the only safe way to undo
  // this. The parent is then removed only if it is empty.
  if (createdLink) {
    try { rmdirSync(linkPath) } catch (error) { /* best effort */ }
    try { rmdirSync(join(root, 'node_modules')) } catch (error) { /* non-empty: leave it */ }
  }
}

/* ------------------------------------------------------------------ */

console.log(`\n${failures === 0 ? `node-check: PASS -- ${checks} checks` : `node-check: ${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
