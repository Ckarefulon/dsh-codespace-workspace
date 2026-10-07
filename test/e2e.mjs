/**
 * REAL end-to-end carrier test for the RPC route.
 *
 * Unlike `check.mjs` (which drives fakes), this boots the actual
 * `@deepseek-ai/dsh-host-webserver` and `@deepseek-ai/dsh-client-connection`
 * plugins from the installed Harness, registers the plugin's real route through
 * `installRoutes`, and then speaks real HTTP to the listening socket.
 *
 * The point is to prove the three things that fake-based tests cannot:
 *   1. the route is reachable through DSH's own `/api` prefix route,
 *   2. an UNAUTHENTICATED request is refused by the harness (401) -- i.e. the
 *      route does not shadow the fence/auth,
 *   3. an AUTHENTICATED request (real launch-token exchange -> real signed
 *      cookie) reaches the plugin and gets `{ok:true}`.
 *
 * Run: node test/e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ *
 * Locate the installed Harness packages.
 * ------------------------------------------------------------------ */

/** Candidate roots that may contain the real `@deepseek-ai` scope. */
function findHarnessRoot() {
  const candidates = [
    process.env.DSH_DESKTOP_MODULES,
    // The repo sits inside a `Github/` workspace, and the extracted app.asar
    // lives beside the repo rather than inside it.
    resolve(here, '..', '..', 'tmp', 'desktop-main', 'dsh', 'node_modules'),
    resolve(here, '..', 'tmp', 'desktop-main', 'dsh', 'node_modules'),
    'C:\\Users\\Vxiao\\.dsh\\profiles\\desktop\\node_modules',
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const root of candidates) {
    if (existsSync(resolve(root, '@deepseek-ai', 'dsh-host-webserver'))) return root
  }
  return null
}

const harnessRoot = findHarnessRoot()
if (harnessRoot === null) {
  console.log('e2e: SKIP -- the installed Harness packages were not found.')
  console.log('e2e: set DSH_DESKTOP_MODULES to a node_modules root containing @deepseek-ai/*.')
  process.exit(0)
}

// Import a real Harness package by resolving its package.json through Node's
// own resolver, then loading the requested file as a file: URL (a bare dynamic
// `import()` of a Windows absolute path fails with ERR_UNSUPPORTED_ESM_URL_SCHEME).
const require = createRequire(resolve(harnessRoot, 'noop.js'))
function loadPackage(name, subpath = 'lib/index.js') {
  const pkgDir = dirname(require.resolve(`${name}/package.json`))
  return import(pathToFileUrl(resolve(pkgDir, subpath)))
}
function pathToFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/')
}

const { Context } = await loadPackage('@deepseek-ai/cordis')
const { WebServer } = await loadPackage('@deepseek-ai/dsh-host-webserver')
const connection = await loadPackage('@deepseek-ai/dsh-client-connection')
const { LocalCredentialProvider } = await loadPackage('@deepseek-ai/dsh-credentials-local')

/* ------------------------------------------------------------------ *
 * Reporting.
 * ------------------------------------------------------------------ */

let failures = 0
function check(cond, label, extra) {
  if (!cond) failures += 1
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond || extra === undefined ? '' : ` -- ${extra}`}`)
}
function eq(label, got, want) {
  check(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
function section(name) {
  console.log(`\n${name}`)
}

/* ------------------------------------------------------------------ *
 * Boot a real app: credentials -> webServer -> connection -> our route.
 * ------------------------------------------------------------------ */

section('boot')

const app = new Context()
await app.start?.()

// A real credentials provider, rooted in a throwaway home.
const home = resolve(here, '..', 'tmp-e2e-home')
app.plugin(LocalCredentialProvider, { home })

// The real web server on an OS-assigned loopback port.
app.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await new Promise((resolve) => setTimeout(resolve, 200))

const webServer = app.get('webServer')
check(webServer !== undefined, 'the real webServer service is up')
check(Number.isInteger(webServer?.port) && webServer.port > 0, 'it bound a real port', String(webServer?.port))

// The real Connection, which owns the `/api` route, the fence and browser auth.
app.plugin({ name: connection.name, inject: connection.inject, Config: connection.Config, apply: connection.apply })
await new Promise((resolve) => setTimeout(resolve, 400))

const conn = app.get('connection')
check(conn !== undefined, 'the real connection service is up')

/* ------------------------------------------------------------------ *
 * Register OUR real route through the real installRoutes.
 * ------------------------------------------------------------------ */

const { installRoutes } = await import(new URL('../lib/host/routes.js', import.meta.url).href)

// `TOKEN_QUERY` in @deepseek-ai/dsh-client-connection.
const TOKEN_PARAM = 'token'

const manager = {
  listWorkspaces: async () => [],
  listRepos: async () => [],
  status: async () => ({ gh: { installed: false, version: '', authenticated: false, login: '' }, tokenSource: 'none', configured: false, secrets: {} }),
}
const disposeRoutes = installRoutes(app, manager, { logger: { warn() {}, info() {} } })
await new Promise((resolve) => setTimeout(resolve, 150))

const RPC = '/api/dsh-codespace-workspace/rpc'
const base = `http://127.0.0.1:${String(webServer.port)}`

section('the route does NOT shadow the harness fence')

// No cookie. Before the fix, our own `webServer` exact route matched first and
// answered 200 here; now the request must fall through to DSH's `/api` route.
const anon = await fetch(base + RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'workspaces' }),
})
eq('a request with no session cookie is refused by the harness', anon.status, 401)
const anonText = await anon.text()
check(!anonText.includes('"ok"'), '  -> and it never reaches the plugin body', anonText.slice(0, 60))

section('a cross-site / rebound request is refused by the fence')

const crossSite = await fetch(base + RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
  body: JSON.stringify({ action: 'workspaces' }),
})
check(crossSite.status === 403 || crossSite.status === 401,
  'a cross-site request is refused (403 fence or 401 auth)', String(crossSite.status))

section('the shadowing hazard, demonstrated')

// Register the OLD, WRONG carrier on purpose: a `webServer` exact route on the
// same path. `match()` prefers the exact table, so it captures the request
// before DSH's `/api` route and answers it with no session at all. This is what
// the plugin used to do, and it is why the assertion above has teeth: if the
// implementation ever regresses to an exact route, the anonymous request stops
// being a 401.
const shadow = webServer.register({
  kind: 'exact',
  path: RPC,
  handler: (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, shadowed: true }))
  },
})
const shadowed = await fetch(base + RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'workspaces' }),
})
eq('an exact route on /api/... really does bypass the harness fence', shadowed.status, 200)
eq('  -> proving the anon-request assertion is sensitive to the carrier',
  (await readJson(shadowed))?.shadowed, true)
shadow()
const unshadowed = await fetch(base + RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'workspaces' }),
})
eq('  -> and removing it restores the 401', unshadowed.status, 401)

/* ------------------------------------------------------------------ *
 * Authenticate for real: launch-token exchange -> signed cookie,
 * then replay it on a real HTTP request.
 * ------------------------------------------------------------------ */

section('authenticated request reaches the plugin')

const launchUrl = new URL(conn.authenticatedUrl(base))
check(launchUrl.searchParams.size > 0, 'authenticatedUrl() carries a launch token')

// Mint a REAL signed cookie through Connection's own public authorizeIndex().
// In a full profile the index route (`/`) calls this; this harness does not load
// the frontend, so we drive the same public entry point directly. The cookie is
// still signed and verified by the real implementation.
const launchToken = [...launchUrl.searchParams.values()][0]
const cookie = mintCookie(conn, webServer.port, launchToken)
check(typeof cookie === 'string' && cookie.length > 0, 'authorizeIndex() minted a real session cookie',
  String(cookie).slice(0, 24))

const authed = await fetch(base + RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ action: 'workspaces' }),
})
eq('an authenticated request reaches the plugin', authed.status, 200)
const body = await readJson(authed)
eq('  -> and resolves through the RPC dispatcher', body?.ok, true)
check(Array.isArray(body?.workspaces), '  -> returning the documented shape')

const authedUnknown = await fetch(base + RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ action: 'definitely-not-an-action' }),
})
eq('an unknown action is still HTTP 200', authedUnknown.status, 200)
eq('  -> with E_UNKNOWN_ACTION', (await readJson(authedUnknown))?.error?.code, 'E_UNKNOWN_ACTION')

section('teardown')

disposeRoutes()
const afterDispose = await fetch(base + RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ action: 'workspaces' }),
})
check(afterDispose.status === 404 || afterDispose.status === 401,
  'after dispose the route is gone (404) and the fence still guards it', String(afterDispose.status))

await app.stop?.()

console.log(`\n${failures === 0 ? 'e2e: PASS -- every assertion held' : `e2e: ${String(failures)} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

/* ------------------------------------------------------------------ *
 * Helpers.
 * ------------------------------------------------------------------ */

/** Read JSON defensively: a refusal is plain text, not a JSON envelope. */
async function readJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, error: { code: 'E_NOT_JSON', message: text.slice(0, 60) } }
  }
}

/**
 * Drive Connection's public authorizeIndex() to exchange the per-process launch
 * token for the signed browser cookie the harness will accept.
 *
 * @returns the `name=value` cookie pair, or '' when the exchange was refused.
 */
function mintCookie(connectionService, port, token) {
  let captured = ''
  const req = {
    method: 'GET',
    url: `/?${new URLSearchParams({ [TOKEN_PARAM]: token }).toString()}`,
    headers: { host: `127.0.0.1:${String(port)}` },
  }
  const res = {
    writeHead(_status, headers) {
      const value = headers?.['set-cookie']
      if (typeof value === 'string') captured = value
      else if (Array.isArray(value) && typeof value[0] === 'string') captured = value[0]
    },
    end() {},
  }
  connectionService.authorizeIndex(req, res)
  return captured.split(';')[0]
}
