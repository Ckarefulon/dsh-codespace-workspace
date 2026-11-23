/**
 * Live verification of the channel + jobs layer against a real Codespace.
 *
 * This is deliberately NOT part of `npm test`: it spawns `gh`, needs an
 * authenticated account and a running Codespace, and it writes files inside
 * that Codespace. It mirrors `test/live.mjs`'s contract (SKIP rather than fail
 * when there is nothing to talk to).
 *
 *   node test/live-channel.mjs [codespace-name]
 *
 * What it pins, one assertion each:
 *   1. a channel opens and its warm-up round trip completes;
 *   2. the SECOND command is fast (the whole point of the channel);
 *   3. stdout, stderr and the exit code all survive the framing;
 *   4. a command containing newlines, quotes and `$()` arrives intact;
 *   5. a remote `cat` cannot swallow the protocol stream;
 *   6. unicode survives both directions;
 *   7. a background job starts, runs detached, and is reported by status;
 *   8. `job_status` sees the exit code after the job finishes;
 *   9. `job_cancel` kills a job that is still running;
 *  10. a job survives an explicit channel close (that is the point of files).
 */

import { channelFor, closeAllChannels } from '../lib/host/channel.js'
import { cancelScript, launchScript, newJobId, parseStatus, statusScript } from '../lib/host/jobs.js'

let failures = 0
const ok = (label, detail = '') => console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failures += 1
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}
const assert = (condition, label, detail) => (condition ? ok(label, detail) : bad(label, detail))

const name = process.argv[2]
if (name === undefined) {
  console.log('SKIP: pass a running Codespace name, e.g. `node test/live-channel.mjs <name>`')
  process.exit(0)
}

const target = { kind: 'gh', codespace: name }
const channel = channelFor(target, { log: (level, msg) => console.log(`  [${level}] ${msg}`) })

try {
  console.log('channel')
  const t0 = Date.now()
  const warm = await channel.exec('echo READY', { timeoutMs: 60000 })
  const connectMs = Date.now() - t0
  assert(warm.exitCode === 0 && warm.stdout.trim() === 'READY', 'warm-up answers', `${connectMs} ms`)

  const t1 = Date.now()
  const second = await channel.exec('echo AGAIN')
  const fastMs = Date.now() - t1
  assert(second.exitCode === 0 && second.stdout.trim() === 'AGAIN', 'second command answers', `${fastMs} ms`)
  assert(fastMs < connectMs / 4, 'the channel is much faster than the connect', `${fastMs} ms vs ${connectMs} ms`)

  console.log('framing')
  const mixed = await channel.exec("echo OUT; echo ERR >&2; exit 7")
  assert(mixed.exitCode === 7, 'exit code survives', String(mixed.exitCode))
  assert(mixed.stdout.trim() === 'OUT', 'stdout survives', JSON.stringify(mixed.stdout))
  assert(mixed.stderr.trim() === 'ERR', 'stderr survives', JSON.stringify(mixed.stderr))

  const tricky = await channel.exec("printf '%s\\n' \"a 'b' \\\"c\\\" $(echo sub) \" '\\n''end'")
  assert(tricky.exitCode === 0, 'quoting-heavy command exits 0')
  assert(tricky.stdout.includes('sub') && tricky.stdout.includes("a 'b'"), 'quoting-heavy command arrives intact', JSON.stringify(tricky.stdout.slice(0, 60)))

  const cat = await channel.exec('cat; echo after-cat')
  assert(cat.stdout.includes('after-cat'), 'a remote `cat` cannot swallow the protocol stream')

  const unicode = await channel.exec('echo "中文 🎉 ok"')
  assert(unicode.stdout.trim() === '中文 🎉 ok', 'unicode survives both directions')

  console.log('jobs')
  const root = (await channel.exec('pwd')).stdout.trim()
  const id = newJobId()
  const launched = await channel.exec(launchScript(root, id, 'sleep 3; echo finished-marker; echo warn >&2; exit 5'))
  assert(launched.exitCode === 0, 'job launches', JSON.stringify(launched.stdout.trim().slice(0, 40)))

  const first = parseStatus((await channel.exec(statusScript(root, id))).stdout)
  assert(!first.missing && !first.done, 'a freshly launched job is not done', `running=${first.running}`)

  await new Promise((resolve) => setTimeout(resolve, 4500))
  const done = parseStatus((await channel.exec(statusScript(root, id))).stdout)
  assert(done.done === true, 'the job finishes on its own')
  assert(done.exitCode === 5, 'the job records its real exit code', String(done.exitCode))
  assert(done.stdout.includes('finished-marker'), 'the job stdout is on disk')
  assert(done.stderr.includes('warn'), 'the job stderr is on disk')

  const id2 = newJobId()
  await channel.exec(launchScript(root, id2, 'sleep 60'))
  await new Promise((resolve) => setTimeout(resolve, 800))
  const cancelled = await channel.exec(cancelScript(root, id2))
  assert(/KILLED=1/.test(cancelled.stdout), 'a running job can be killed')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const afterKill = parseStatus((await channel.exec(statusScript(root, id2))).stdout)
  assert(afterKill.done === true, 'a killed job reports as finished', `exit=${afterKill.exitCode}`)

  console.log('durability')
  const id3 = newJobId()
  await channel.exec(launchScript(root, id3, 'sleep 2; echo survived'))
  channel.close()
  assert(channel.alive === false, 'the channel is closed')
  const reopened = await channel.exec(statusScript(root, id3))
  const survived = parseStatus(reopened.stdout)
  assert(!survived.missing, 'the job still exists after the channel dies')
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const finished = parseStatus((await channel.exec(statusScript(root, id3))).stdout)
  assert(finished.stdout.includes('survived'), 'the job kept running while the channel was gone')
} catch (error) {
  bad('unexpected failure', error instanceof Error ? `${error.code ?? ''} ${error.message}` : String(error))
} finally {
  closeAllChannels()
}

console.log(failures === 0 ? '\nall channel checks passed' : `\n${failures} channel check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
