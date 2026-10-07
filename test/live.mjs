/**
 * Live control-plane test: the plugin's real `api()` against the real GitHub
 * API, with a real token from `gh auth token`.
 *
 * It exists because the offline suites cannot see the one failure that actually
 * broke this plugin on a real machine: a TLS-intercepting proxy whose root CA is
 * in the OS trust store but not in Node's bundled list, so `fetch` dies with
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` while everything else about the machine
 * looks healthy. `api()` now falls back to a request through the OS store; this
 * asserts both that the call succeeds *and* that the fallback was the reason
 * when the direct path is genuinely broken.
 *
 * SKIPs (exit 0) when there is no token, so it stays safe in CI.
 *
 * Run: node test/live.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

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

section('token')

let token = ''
try {
  token = (await run('gh', ['auth', 'token'])).stdout.trim()
} catch {
  token = ''
}
if (token.length === 0) {
  console.log('live: SKIP -- no token (install and authenticate `gh`, or set GITHUB_TOKEN).')
  process.exit(0)
}
check(token.length > 0, 'a token is available (its value is never printed)')

const { listRepos, getViewer, listCodespaces, GithubError } = await import(new URL('../lib/host/github.js', import.meta.url).href)

section('is the direct fetch path usable on this machine?')

let directFails = false
try {
  await fetch('https://api.github.com/user', {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'probe' },
    signal: AbortSignal.timeout(15000),
  })
} catch (error) {
  directFails = true
  console.log(`     direct fetch failed with cause ${String(error?.cause?.code ?? error?.message)}`)
}
console.log(`     direct fetch usable = ${String(!directFails)}`)
console.log('     (false means the OS-trust-store fallback is what has to carry this machine)')

section('the control plane works either way')

const viewer = await getViewer(token)
eq('getViewer reaches the API', viewer.login.length > 0, true)

let repos = []
try {
  repos = await listRepos(token)
} catch (error) {
  check(false, 'listRepos reaches the API',
    error instanceof GithubError ? `${error.code}: ${error.message}` : String(error?.message))
}
if (repos.length > 0) {
  eq('listRepos returns rows', Array.isArray(repos), true)
  const first = repos[0]
  check(typeof first.nameWithOwner === 'string' && first.nameWithOwner.includes('/'),
    'a row carries owner/name', first.nameWithOwner)
  check(typeof first.defaultBranch === 'string' && first.defaultBranch.length > 0,
    'a row carries a default branch', first.defaultBranch)
  console.log(`     ${String(repos.length)} repos, first = ${first.nameWithOwner}`)
} else {
  check(false, 'listRepos returned at least one repository')
}

section('codespace listing (needs the codespace scope)')

try {
  const codespaces = await listCodespaces(token)
  check(Array.isArray(codespaces), 'listCodespaces returns an array')
  console.log(`     ${String(codespaces.length)} codespace(s) on this account`)
} catch (error) {
  // A missing `codespace` scope is a real, actionable answer -- not a crash.
  const code = error instanceof GithubError ? error.code : 'E_UNKNOWN'
  check(code === 'E_AUTH', 'a scope problem is reported as E_AUTH rather than thrown raw', `${code}: ${error.message}`)
}

console.log(`\n${failures === 0 ? 'live: PASS -- every assertion held' : `live: ${String(failures)} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
