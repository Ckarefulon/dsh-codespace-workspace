/**
 * Shutdown auto-stop: the reliability test.
 *
 * Stopping every managed Codespace when DSH exits is the one piece of this
 * plugin whose failure the user cannot see and cannot recover from -- a
 * Codespace left running bills by the hour. It also runs inside the harness's
 * hardest budget (5s before `process.exit()`, 2s on the crash path), through a
 * teardown path that awaits the disposer.
 *
 * So it is tested against the REAL `CodespaceManager` with only `fetch` stubbed,
 * asserting the properties that actually matter:
 *
 *   1. every managed Codespace is asked to stop, concurrently (not serially)
 *   2. the disposer RESOLVES even when the API fails, times out or 500s -- a
 *      rejected disposer becomes an AggregateError out of `runProfile`, which
 *      would turn "we could not stop a Codespace" into "DSH will not quit"
 *   3. it finishes well inside the 5s budget even when nothing answers
 *   4. it is idempotent: a second call issues no further requests
 *   5. a stop that did not confirm is persisted, so the next boot's leftover
 *      prompt can still offer it
 *
 * Run: node test/shutdown.mjs
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const load = (relative) => import(new URL(relative, import.meta.url).href)

let failures = 0
let checks = 0
function check(cond, label, extra) {
  checks += 1
  if (!cond) failures += 1
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond || extra === undefined ? '' : ' -- ' + extra}`)
}
function section(name) {
  console.log(`\n${name}`)
}

const { CodespaceManager } = await load('../lib/host/codespaces.js')

/**
 * Build a manager over a throwaway home, with `fetch` stubbed.
 *
 * @param {(url: string, init: object) => Promise<object>} responder - the stub.
 * @param {object} [options] - extra manager options.
 */
function makeManager(responder, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dcw-shutdown-'))
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    return responder(String(url), init ?? {})
  }
  const manager = new CodespaceManager(
    { logger: { warn() {}, info() {}, debug() {} } },
    {
      profileHome: home,
      getSettings: () => ({ githubToken: 'ghp_test_token_not_real', autoPauseMinutes: 30 }),
      run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      ...options,
    },
  )
  // Register two managed workspaces directly: the map is the manager's own
  // persistence format, so this is exactly what a previous session would leave.
  manager.ensureLoaded()
  manager.records.set('ws-one', { workspaceId: 'ws-one', name: 'alpha-1234', title: 'Alpha', path: join(home, 'codespaces', 'alpha-1234'), addedAt: 1 })
  manager.records.set('ws-two', { workspaceId: 'ws-two', name: 'beta-5678', title: 'Beta', path: join(home, 'codespaces', 'beta-5678'), addedAt: 2 })
  return {
    manager,
    calls,
    home,
    restore() { globalThis.fetch = original },
    pendingFile: join(home, 'codespaces', 'pending-stop.json'),
  }
}

/** A GitHub-shaped JSON response. */
function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  }
}

/* ------------------------------------------------------------------ *
 * 1. The happy path.
 * ------------------------------------------------------------------ */

section('shutdown stops every managed Codespace')

{
  const stub = makeManager(() => json({ name: 'ok', state: 'ShuttingDown' }))
  try {
    const started = Date.now()
    const result = await stub.manager.stopAll('shutdown')
    const elapsed = Date.now() - started

    const stops = stub.calls.filter((call) => call.url.endsWith('/stop'))
    check(stops.length === 2, 'both managed Codespaces were asked to stop', `saw ${stops.length}`)
    check(stops.some((c) => c.url.includes('alpha-1234')), '  -> including alpha-1234')
    check(stops.some((c) => c.url.includes('beta-5678')), '  -> including beta-5678')
    check(stops.every((c) => c.method === 'POST'), '  -> each with POST')
    check(!stub.calls.some((c) => c.url.includes('ghp_test_token_not_real')),
      'the token never appears in a request URL')
    check(result.stopped === 2 && result.pending.length === 0,
      'the result reports 2 stopped, 0 pending', JSON.stringify(result))
    check(elapsed < 1000, 'it is fast when the API answers', `${elapsed}ms`)
    check(!existsSync(stub.pendingFile), 'no pending marker is written when everything stopped')
  } finally {
    stub.restore()
    rmSync(stub.home, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * 2. Concurrency: the whole point of doing it in parallel.
 * ------------------------------------------------------------------ */

section('stops run concurrently, not serially')

{
  const stub = makeManager(async () => {
    await new Promise((r) => setTimeout(r, 300))
    return json({ name: 'ok', state: 'ShuttingDown' })
  })
  try {
    const started = Date.now()
    await stub.manager.stopAll('shutdown')
    const elapsed = Date.now() - started
    // Two serial 300ms stops would be >= 600ms. Concurrency keeps it near 300.
    check(elapsed < 550, 'two 300ms stops finish in under 550ms (i.e. overlapped)', `${elapsed}ms`)
  } finally {
    stub.restore()
    rmSync(stub.home, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * 3. Failure paths must still resolve.
 * ------------------------------------------------------------------ */

section('a failing stop never rejects')

{
  const stub = makeManager(() => json({ message: 'boom' }, 500))
  try {
    const result = await stub.manager.stopAll('shutdown')
    check(result.attempted === 2, 'both were attempted', JSON.stringify(result))
    check(result.stopped === 0, 'neither is reported as stopped')
    check(result.pending.length === 2, 'both are reported pending')
    check(existsSync(stub.pendingFile), 'a pending marker was written')
    if (existsSync(stub.pendingFile)) {
      const parsed = JSON.parse(readFileSync(stub.pendingFile, 'utf8'))
      const names = JSON.stringify(parsed)
      check(names.includes('alpha-1234') && names.includes('beta-5678'),
        '  -> naming both Codespaces', names)
      check(!names.includes('ghp_test_token_not_real'), '  -> and never the token')
    }
  } finally {
    stub.restore()
    rmSync(stub.home, { recursive: true, force: true })
  }
}

{
  // A transport failure: fetch itself throws.
  const stub = makeManager(() => { throw new Error('ECONNREFUSED') })
  try {
    const result = await stub.manager.stopAll('shutdown')
    check(result.stopped === 0 && result.pending.length === 2,
      'a transport failure is reported, not thrown', JSON.stringify(result))
  } finally {
    stub.restore()
    rmSync(stub.home, { recursive: true, force: true })
  }
}

{
  // A hang: the API accepts the connection and never answers. The per-request
  // budget must cut it off, and the whole thing must still land inside the
  // harness's 5s.
  //
  // This case deliberately uses a REAL socket rather than a stubbed `fetch`.
  // A stub that returns a never-settling promise holds no ref'd handle, and
  // Node's `AbortSignal.timeout()` timer is unref'd — so the process would
  // simply exit before the abort could fire, and the test would hang or die
  // instead of measuring the timeout. Here the stub forwards the real `init`
  // (signal included) to the real `fetch` against a local silent server, so
  // undici's own abort handling is what is under test.
  const silent = createServer(() => { /* deliberately never replies */ })
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const { port } = silent.address()
  const realFetch = globalThis.fetch

  const stub = makeManager((_url, init) => realFetch(`http://127.0.0.1:${port}/stop`, init))
  try {
    const started = Date.now()
    const result = await stub.manager.stopAll('shutdown')
    const elapsed = Date.now() - started
    check(result.pending.length === 2, 'a hanging API is reported as pending', JSON.stringify(result))
    check(elapsed < 5000, 'and is cut off inside the 5s process budget', `${elapsed}ms`)
    check(elapsed >= 3000, '  -> but only after the per-request budget (not instantly)', `${elapsed}ms`)
  } finally {
    stub.restore()
    silent.close()
    rmSync(stub.home, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * 4. Idempotence: teardown can run twice.
 * ------------------------------------------------------------------ */

section('stopAll is idempotent')

{
  const stub = makeManager(() => json({ name: 'ok', state: 'ShuttingDown' }))
  try {
    await stub.manager.stopAll('shutdown')
    const afterFirst = stub.calls.filter((c) => c.url.endsWith('/stop')).length
    const second = await stub.manager.stopAll('shutdown')
    const afterSecond = stub.calls.filter((c) => c.url.endsWith('/stop')).length
    check(afterFirst === 2, 'the first call issued 2 stops', String(afterFirst))
    check(afterSecond === 2, 'the second call issued NO further stops', String(afterSecond))
    check(second.stopped === 2, 'and reports the same result', JSON.stringify(second))
  } finally {
    stub.restore()
    rmSync(stub.home, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * 5. Nothing to do, and no token.
 * ------------------------------------------------------------------ */

section('degenerate cases')

{
  const stub = makeManager(() => json({}))
  try {
    stub.manager.records.clear()
    const result = await stub.manager.stopAll('shutdown')
    check(result.attempted === 0 && stub.calls.length === 0,
      'with no managed workspaces it makes no requests', JSON.stringify(result))
  } finally {
    stub.restore()
    rmSync(stub.home, { recursive: true, force: true })
  }
}

{
  // No token anywhere: the stop cannot even be attempted, so every name must be
  // recorded for the next boot rather than silently forgotten.
  const stub = makeManager(() => json({}), {
    getSettings: () => ({}),
    run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
  })
  const savedToken = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    const result = await stub.manager.stopAll('shutdown')
    check(result.stopped === 0, 'without a token nothing is reported as stopped')
    check(result.pending.length === 2, 'both are recorded as pending instead')
    check(stub.calls.length === 0, 'and no request is attempted')
  } finally {
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken
    stub.restore()
    rmSync(stub.home, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * 6. The wiring: the effect disposer must actually await this.
 * ------------------------------------------------------------------ */

section('the shutdown hook is wired to a disposer')

{
  const source = readFileSync(new URL('../lib/host/session.js', import.meta.url), 'utf8')
  check(/ctx\.effect\(\(\) => \(\) =>/.test(source),
    'the shutdown hook is an effect disposer (the only guaranteed teardown hook)')
  check(/manager\.stopAll\('shutdown'\)/.test(source),
    '  -> and it calls stopAll("shutdown")')
  check(/\.catch\(/.test(source.slice(source.indexOf("manager.stopAll('shutdown')"))),
    '  -> with a catch, so it can never reject')
  check(!/process\.on\(\s*['"]SIGTERM/.test(source),
    'it does NOT register its own SIGTERM handler (the harness owns that)')
  check(/manager\.dispose\(\)/.test(source),
    'the disposer also clears the auto-pause timers')
}

console.log(`\n${failures === 0 ? `shutdown-check: PASS -- ${checks} checks` : `shutdown-check: ${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
