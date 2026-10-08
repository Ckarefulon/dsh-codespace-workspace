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
import { readFileSync, existsSync, statSync, mkdirSync, symlinkSync, rmdirSync } from 'node:fs'
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
eq('private', pkg.private, true)

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
   * registry, and its handler calls `connection.admit(req)` — the Host/Origin
   * fence AND the browser-auth cookie check — before dispatching to any
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
   * must be a real async iterable — an EventEmitter-shaped `on('data')` stub
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

  /* ---------------------------------------------------------------- *
   * 6. Shell quoting.
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
  // Dynamic keys: t('prefix.' + value) — the literal prefix is what to look for.
  const dot = key.lastIndexOf('.')
  if (dot > 0 && clientSource.includes(`'${key.slice(0, dot + 1)}`)) return false
  return true
})
check(unusedKeys.length === 0, 'the locale has no keys the client never reads', unusedKeys.join(', '))

} finally {
  // Remove the junction WITHOUT recursing. `rmSync(..., {recursive:true})` on a
  // Windows directory junction follows it and deletes the TARGET's contents —
  // which here is the user's live DSH profile. `rmdirSync` unlinks the junction
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
