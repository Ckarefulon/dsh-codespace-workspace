/**
 * End-to-end check of the REAL remote tool definitions against a live
 * Codespace: the same objects `installRemoteTools()` registers, executed
 * through the same transport the agent uses.
 *
 *   node test/live-tools.mjs <codespace-name>
 *
 * Unlike `live-channel.mjs` (which pins the channel protocol), this pins what
 * the MODEL sees: `bash background: true` → a job id, `job_status` → the tail,
 * `job_cancel` → stopped, and `codespace_doctor` → a passing report.
 */
import { installRemoteTools } from '../lib/host/remote-tools.js'
import { defaultRun } from '../lib/host/gh.js'

const name = process.argv[2]
if (name === undefined) {
  console.log('SKIP: pass a running Codespace name, e.g. `node test/live-tools.mjs <name>`')
  process.exit(0)
}

let failures = 0
const ok = (label, detail = '') => console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failures += 1
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}
const assert = (condition, label, detail) => (condition ? ok(label, detail) : bad(label, detail))

// A stand-in agent context: `inject` resolves synchronously with a tools service
// that records definitions, exactly the seam `installRemoteTools` expects.
const definitions = new Map()
const toolsService = {
  register: (definition) => {
    definitions.set(definition.name, definition)
    return () => {}
  },
  restrict: () => () => {},
  get: () => undefined,
}
const agentCtx = {
  effect: (fn) => { fn(); return () => {} },
  inject: (_names, cb) => { cb({ tools: toolsService }); return { dispose: () => {} } },
}

const target = { kind: 'gh', codespace: name }
const dispose = installRemoteTools({ id: 'live', ctx: agentCtx }, {
  manager: { log: (level, msg) => console.log(`  [${level}] ${msg}`), run: undefined },
  workspaceId: 'live-ws',
  target,
  localToolNames: [],
})
// `run` defaults to the manager's, which is `defaultRun` in the real
// composition; supply it explicitly so the channel path is taken.
const live = installRemoteTools({ id: 'live2', ctx: agentCtx }, {
  manager: { log: () => {} },
  workspaceId: 'live-ws2',
  target,
  localToolNames: [],
  run: defaultRun,
})

const doctor = definitions.get('codespace_doctor')
const bash = definitions.get('bash')
const jobStatus = definitions.get('job_status')
const jobCancel = definitions.get('job_cancel')

try {
  console.log('surface')
  assert(definitions.has('codespace_doctor'), 'codespace_doctor is registered')
  assert(definitions.has('job_status') && definitions.has('job_cancel'), 'job tools are registered')

  console.log('doctor')
  const report = await doctor.execute({}, {})
  for (const check of report.checks) {
    console.log(`  ${check.status === 'pass' ? 'PASS' : check.status.toUpperCase()} ${check.name}: ${check.detail.slice(0, 110)}`)
  }
  assert(report.checks.some((check) => check.name === 'connection' && check.status === 'pass'), 'doctor reports a working connection')
  assert(report.checks.some((check) => check.name === 'container sshd' && check.status === 'pass'), 'doctor confirms the container sshd')
  assert(report.ok, 'doctor reports ok overall')

  console.log('bash')
  const plain = await bash.execute({ command: 'echo hello-from-tool', description: 'say hello' }, {})
  assert(plain.exitCode === 0 && plain.stdout.includes('hello-from-tool'), 'foreground bash works', JSON.stringify(plain.stdout.trim()))

  const failing = await bash.execute({ command: 'exit 9', description: 'fail deliberately' }, {})
  assert(failing.exitCode === 9, 'a non-zero exit is reported, not thrown', String(failing.exitCode))

  console.log('background jobs')
  const started = await bash.execute({
    command: 'for i in 1 2 3; do echo tick-$i; sleep 1; done; echo BYE; exit 3',
    description: 'count three ticks',
    background: true,
  }, {})
  assert(typeof started.jobId === 'string' && started.jobId.length > 0, 'background bash returns a job id', started.jobId)
  assert(bash.output.render({}, started)[0].text.includes(started.jobId), 'the rendered card names the job')

  const early = await jobStatus.execute({ jobId: started.jobId }, {})
  assert(early.state === 'running', 'job_status reports a running job', early.state)

  await new Promise((resolve) => setTimeout(resolve, 5500))
  const settled = await jobStatus.execute({ jobId: started.jobId }, {})
  assert(settled.state === 'finished', 'job_status sees it finish', settled.state)
  assert(settled.exitCode === 3, 'the real exit code is preserved', String(settled.exitCode))
  assert(settled.stdout.includes('BYE'), 'the full stdout tail is returned', JSON.stringify(settled.stdout.trim().slice(0, 60)))
  assert(jobStatus.output.render({}, settled)[0].text.includes('exit code 3'), 'the rendered status names the exit code')

  const long = await bash.execute({ command: 'sleep 120', description: 'sleep long', background: true }, {})
  await new Promise((resolve) => setTimeout(resolve, 900))
  const stopped = await jobCancel.execute({ jobId: long.jobId }, {})
  assert(stopped.cancelled === true, 'job_cancel stops a running job')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const killed = await jobStatus.execute({ jobId: long.jobId }, {})
  assert(killed.state === 'finished' && killed.exitCode === 143, 'a cancelled job reports as finished (SIGTERM)', String(killed.exitCode))

  const ghost = await jobStatus.execute({ jobId: 'abcdefabcdef' }, {})
  assert(ghost.state === 'missing', 'an unknown job id is reported as missing, not as an error')

  console.log('speed')
  const t0 = Date.now()
  for (let i = 0; i < 5; i += 1) await bash.execute({ command: 'echo t', description: 'timing probe' }, {})
  const perCall = Math.round((Date.now() - t0) / 5)
  console.log(`  avg ${perCall} ms per foreground bash call over the channel`)
  assert(perCall < 1500, 'foreground calls reuse the channel instead of reconnecting', `${perCall} ms`)
} catch (error) {
  bad('unexpected failure', error instanceof Error ? `${error.code ?? ''} ${error.message}` : String(error))
} finally {
  dispose()
  live()
}

console.log(failures === 0 ? '\nall remote tool checks passed' : `\n${failures} remote tool check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
