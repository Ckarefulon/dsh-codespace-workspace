/**
 * Live check of `codespace_doctor({ setupGh: true })`: installs `gh` in the
 * container, authenticates it, and proves `git push` becomes possible.
 *
 *   node test/live-setup-gh.mjs <codespace-name>
 *
 * It asserts the OBSERVABLE outcome, not the script's exit code: after setup,
 * `gh auth status` succeeds inside the container and `git ls-remote` against the
 * workspace's own `origin` (an HTTPS remote with no credential helper) works.
 * That is the exact wall this feature exists to remove.
 */
import { installRemoteTools } from '../lib/host/remote-tools.js'
import { defaultRun } from '../lib/host/gh.js'

const name = process.argv[2]
if (name === undefined) {
  console.log('SKIP: pass a running Codespace name, e.g. `node test/live-setup-gh.mjs <name>`')
  process.exit(0)
}

let failures = 0
const ok = (label, detail = '') => console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failures += 1
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}
const assert = (condition, label, detail) => (condition ? ok(label, detail) : bad(label, detail))

const token = (await defaultRun('gh', ['auth', 'token'], { timeoutMs: 10000 })).stdout.trim()
assert(token.length > 0, 'a token is available on the host')

const definitions = new Map()
const toolsService = {
  register: (definition) => { definitions.set(definition.name, definition); return () => {} },
  restrict: () => () => {},
  get: () => undefined,
}
const agentCtx = {
  effect: (fn) => { fn(); return () => {} },
  inject: (_names, cb) => { cb({ tools: toolsService }); return { dispose: () => {} } },
}

const dispose = installRemoteTools({ id: 'setup-gh', ctx: agentCtx }, {
  manager: { log: () => {} },
  workspaceId: 'setup-gh-ws',
  target: { kind: 'gh', codespace: name },
  localToolNames: [],
  run: defaultRun,
  getToken: async () => token,
  getLogin: async () => (await defaultRun('gh', ['api', '/user', '--jq', '.login'], { timeoutMs: 15000 })).stdout.trim(),
})

const doctor = definitions.get('codespace_doctor')
const bash = definitions.get('bash')

try {
  console.log('setupGh')
  const report = await doctor.execute({ setupGh: true }, {})
  for (const check of report.checks) {
    if (!/container (gh|git)/.test(check.name)) continue
    console.log(`  ${check.status === 'pass' ? 'PASS' : check.status.toUpperCase()} ${check.name}: ${check.detail}`)
  }
  assert(report.checks.some((c) => c.name === 'container gh' && c.status === 'pass'), 'gh is present in the container')
  assert(report.checks.some((c) => c.name === 'container gh auth' && c.status === 'pass'), 'gh is authenticated in the container')
  assert(report.checks.some((c) => c.name === 'container git credential' && c.status === 'pass'), 'the git credential helper is installed')

  console.log('observable outcome')
  const status = await bash.execute({ command: 'gh auth status 2>&1 | head -4', description: 'check gh auth' }, {})
  assert(/Logged in|account/i.test(status.stdout), 'gh auth status reports a login inside the container', status.stdout.split('\n')[0])

  // The real wall: `origin` inside the Codespace is an HTTPS remote with no
  // credential helper, so `git ls-remote` fails with "could not read Username".
  // Run it INSIDE the checkout — from `$HOME` there is no repository at all and
  // the command fails for the wrong reason (which read as a pass once).
  const repo = await bash.execute({ command: 'ls -d /workspaces/*/ 2>/dev/null | head -1', description: 'locate the checkout' }, {})
  const checkout = repo.stdout.trim().replace(/\/$/, '')
  assert(checkout.length > 0, 'the Codespace has a checkout', checkout)
  if (checkout.length > 0) {
    const lsRemote = await bash.execute({
      command: `cd ${checkout} && git ls-remote --heads origin 2>&1 | head -3`,
      description: 'probe the git remote with credentials',
    }, {})
    assert(
      lsRemote.exitCode === 0 && !/could not read Username|Authentication failed/i.test(lsRemote.stdout + lsRemote.stderr),
      'git talks to origin without a credential prompt',
      (lsRemote.stdout || lsRemote.stderr).trim().split('\n')[0] ?? '',
    )
  }

  const whoami = await bash.execute({ command: 'gh api /user --jq .login', description: 'confirm the token identity' }, {})
  assert(whoami.exitCode === 0 && whoami.stdout.trim().length > 0, 'gh api works with the container token', whoami.stdout.trim())
} catch (error) {
  bad('unexpected failure', error instanceof Error ? `${error.code ?? ''} ${error.message}` : String(error))
} finally {
  dispose()
}

console.log(failures === 0 ? '\ngh setup checks passed' : `\n${failures} gh setup check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
