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

  // Capture the route handler that `installRoutes` registers on the browser
  // carrier, then drive it directly.
  let routeHandler = null
  const fakeCtx = {
    logger: { warn() {}, info() {} },
    settings: { describe: async () => [] },
    inject: (names, cb) => {
      cb({
        effect: (fn) => fn(),
        webServer: { register: (options) => { routeHandler = options.handler; return () => {} } },
        connection: { fetch: { register: () => () => {} } },
      })
    },
  }
  const disposeRoutes = installRoutes(fakeCtx, manager, { logger: { warn() {}, info() {} } })
  check(typeof routeHandler === 'function', 'installRoutes registered the browser route handler')

  /**
   * Drive the registered HTTP handler.
   *
   * The route reads its body with `for await (const chunk of req)`, so the stub
   * must be a real async iterable — an EventEmitter-shaped `on('data')` stub
   * silently yields an EMPTY body, which looks exactly like a bad action.
   */
  function drive({ method = 'POST', remoteAddress = '127.0.0.1', host = '127.0.0.1:19387', origin = 'http://127.0.0.1:19387', type = 'application/json', body = {}, dropOrigin = false } = {}) {
    return new Promise((done) => {
      const headers = { host, 'content-type': type }
      if (!dropOrigin) headers.origin = origin
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
  eq('a request with no Origin is rejected with 403', (await drive({ dropOrigin: true })).status, 403)
  eq('a cross-origin request is rejected with 403',
    (await drive({ origin: 'http://evil.example' })).status, 403)
  eq('a non-JSON content-type is rejected with 415', (await drive({ type: 'text/plain' })).status, 415)

  const unknownRes = await drive({ body: { action: 'nope' } })
  eq('an action failure is answered with HTTP 200 (never a 4xx/5xx)', unknownRes.status, 200)
  eq('  -> reporting ok:false', JSON.parse(unknownRes.body).ok, false)
  eq('  -> with the documented code', JSON.parse(unknownRes.body).error?.code, 'E_UNKNOWN_ACTION')

  const okRes = await drive({ body: { action: shared.ACTIONS.WORKSPACES } })
  eq('a valid action is answered with HTTP 200', okRes.status, 200)
  eq('  -> ok:true', JSON.parse(okRes.body).ok, true)

  disposeRoutes()
  check(true, 'the route disposer ran without throwing')

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
