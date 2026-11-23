/**
 * Background jobs on a Codespace: start a long command, poll it, kill it.
 *
 * WHY A FILE-BASED DESIGN — the alternative (a long-lived remote shell process
 * this plugin holds a handle to) fails in exactly the situation where a long
 * build matters most: the channel drops, DSH restarts, or the host reboots
 * mid-build. Then the work is gone AND so is any record that it existed.
 *
 * So a job is three files under a fixed directory inside the Codespace:
 *
 *   <root>/jobs/<id>/cmd     the command, verbatim
 *   <root>/jobs/<id>/stdout  appended by the running process
 *   <root>/jobs/<id>/stderr  appended by the running process
 *   <root>/jobs/<id>/exit    the exit code, written once the process ends
 *   <root>/jobs/<id>/pid     the pid, for status reporting and cancellation
 *
 * The launcher is `setsid … &`, so the process survives the connection dropping
 * (that is the whole point) and writes its own exit code on the way out.
 * `job_status` is then just `cat` of a few small files, which costs one fast
 * channel round trip and works even against a *different* channel than the one
 * that launched the job.
 *
 * DELIBERATE LIMIT: output is appended to a file without a cap. A build that
 * prints gigabytes would fill the disk, and the Codespace has ~24 GB free.
 * `job_status` therefore returns the tail, not the whole log, and reports the
 * total size so the model can tell it truncated.
 */

import { shq } from './gh.js'

/** Directory (inside the Codespace workspace root) holding job state. */
const JOBS_DIR = '.dsh-jobs'

/** How much of a job's output `job_status` returns, in bytes, per stream. */
const TAIL_BYTES = 24 * 1024

/** Ids are generated here and must stay shell-safe and path-safe. */
const ID_PATTERN = /^[a-z0-9]{6,32}$/

/**
 * Generate a job id.
 *
 * @returns {string} 12 lowercase alphanumeric characters.
 */
export function newJobId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 12; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return id
}

/** Validate an id coming back from the model. */
export function isJobId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** Absolute path of a job's directory, POSIX-quoted where needed by callers. */
function jobDir(root, id) {
  return `${root}/${JOBS_DIR}/${id}`
}

/**
 * Build the shell line that launches a job detached.
 *
 * @param {string} root - the Codespace workspace root.
 * @param {string} id - the job id.
 * @param {string} command - the command to run.
 * @param {string} [workdir] - working directory, defaults to the root.
 * @returns {string} a POSIX shell command line.
 */
export function launchScript(root, id, command, workdir) {
  const dir = jobDir(root, id)
  const cwd = typeof workdir === 'string' && workdir.length > 0 ? workdir : root
  /*
   * The command never appears in any shell string: it is decoded from base64
   * into `cmd`, and the only thing quoted into the launcher is the *path*. A
   * command containing newlines, quotes, `$()` or a heredoc therefore needs no
   * escaping at all — it is data, read by bash as a script file.
   *
   * `run.sh` is what makes the detach reliable: `setsid` puts it in its own
   * session so the channel's death cannot signal it, and the wrapper writes the
   * exit code itself, because `setsid … &` hands back a pid whose own exit
   * status nobody observes.
   */
  const runSh = [
    '#!/bin/bash',
    `: > ${shq(`${dir}/stderr`)}`,
    `bash ${shq(`${dir}/cmd`)} </dev/null >>${shq(`${dir}/stdout`)} 2>>${shq(`${dir}/stderr`)}`,
    `echo $? > ${shq(`${dir}/exit`)}`,
  ].join('\n')
  return [
    `mkdir -p ${shq(dir)}`,
    `printf '%s' ${shq(Buffer.from(command, 'utf8').toString('base64'))} | base64 -d > ${shq(`${dir}/cmd`)}`,
    `printf '%s' ${shq(Buffer.from(runSh, 'utf8').toString('base64'))} | base64 -d > ${shq(`${dir}/run.sh`)}`,
    `: > ${shq(`${dir}/stdout`)}`,
    `: > ${shq(`${dir}/stderr`)}`,
    `rm -f ${shq(`${dir}/exit`)} ${shq(`${dir}/pid`)}`,
    `cd ${shq(cwd)} || exit 1`,
    `if command -v setsid >/dev/null 2>&1; then`,
    `  setsid bash ${shq(`${dir}/run.sh`)} </dev/null >/dev/null 2>&1 &`,
    `else`,
    `  nohup bash ${shq(`${dir}/run.sh`)} </dev/null >/dev/null 2>&1 &`,
    `fi`,
    `echo $! > ${shq(`${dir}/pid`)}`,
    `echo "JOB=$(cat ${shq(`${dir}/pid`)})"`,
  ].join('\n')
}

/**
 * Query one job's state.
 *
 * @param {string} root - the Codespace workspace root.
 * @param {string} id - the job id.
 * @returns {string} a shell line that prints a single `KEY=value` record set.
 */
export function statusScript(root, id) {
  const dir = jobDir(root, id)
  // `wc -c` first so the caller can decide whether the tail was truncated.
  // `ps -p` deliberately reports only liveness, never the command line: the
  // command text may contain a token.
  return [
    `d=${shq(dir)}`,
    'if [ ! -d "$d" ]; then echo "MISSING=1"; exit 0; fi',
    'echo "MISSING=0"',
    'if [ -f "$d/exit" ]; then echo "DONE=1"; echo "EXIT=$(cat "$d/exit" 2>/dev/null)"; else echo "DONE=0"; echo "EXIT="; fi',
    'if [ -f "$d/pid" ]; then p=$(cat "$d/pid" 2>/dev/null); echo "PID=$p"; if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "RUNNING=1"; else echo "RUNNING=0"; fi; else echo "PID="; echo "RUNNING=0"; fi',
    'echo "OUT_BYTES=$(wc -c < "$d/stdout" 2>/dev/null | tr -d " ")"',
    'echo "ERR_BYTES=$(wc -c < "$d/stderr" 2>/dev/null | tr -d " ")"',
    `echo "OUT_TAIL<<DSH_EOF"`,
    `tail -c ${TAIL_BYTES} "$d/stdout" 2>/dev/null`,
    'echo',
    'echo "DSH_EOF"',
    `echo "ERR_TAIL<<DSH_EOF"`,
    `tail -c ${TAIL_BYTES} "$d/stderr" 2>/dev/null`,
    'echo',
    'echo "DSH_EOF"',
  ].join('\n')
}

/**
 * Parse the record set printed by {@link statusScript}.
 *
 * @param {string} text - the raw stdout.
 * @returns {{missing: boolean, done: boolean, running: boolean, exitCode: number|null, pid: number|null, stdout: string, stderr: string, stdoutBytes: number, stderrBytes: number}} the parsed state.
 */
export function parseStatus(text) {
  const lines = String(text).split('\n')
  const fields = new Map()
  const tails = { OUT: [], ERR: [] }
  let current = null
  for (const line of lines) {
    if (current !== null) {
      if (line === 'DSH_EOF') {
        current = null
        continue
      }
      tails[current].push(line)
      continue
    }
    const match = /^([A-Z_]+)=(.*)$/.exec(line)
    if (match !== null) {
      fields.set(match[1], match[2])
      continue
    }
    const block = /^(OUT|ERR)_TAIL<<DSH_EOF$/.exec(line)
    if (block !== null) current = block[1]
  }
  const number = (name, fallback) => {
    const raw = fields.get(name)
    if (raw === undefined || raw.trim().length === 0) return fallback
    const value = Number(raw)
    return Number.isFinite(value) ? value : fallback
  }
  const joinTail = (lines2) => {
    // `tail -c` may split a UTF-8 sequence at the cut point — the decode then
    // shows one replacement character, which is the honest representation of a
    // truncated byte boundary. The final `echo` in the script added one newline.
    return lines2.join('\n').replace(/\n$/, '')
  }
  return {
    missing: fields.get('MISSING') === '1',
    done: fields.get('DONE') === '1',
    running: fields.get('RUNNING') === '1',
    exitCode: number('EXIT', null),
    pid: number('PID', null),
    stdoutBytes: number('OUT_BYTES', 0),
    stderrBytes: number('ERR_BYTES', 0),
    stdout: joinTail(tails.OUT),
    stderr: joinTail(tails.ERR),
  }
}

/**
 * Build the shell line that stops a job.
 *
 * Kills the whole process group when possible (a build spawns children that
 * would otherwise keep the runner busy after the wrapper dies), then writes the
 * exit code so the job does not look "running forever" to a later poll.
 *
 * @param {string} root - the Codespace workspace root.
 * @param {string} id - the job id.
 * @returns {string} a POSIX shell command line.
 */
export function cancelScript(root, id) {
  const dir = jobDir(root, id)
  return [
    `d=${shq(dir)}`,
    'if [ ! -d "$d" ]; then echo "MISSING=1"; exit 0; fi',
    'p=$(cat "$d/pid" 2>/dev/null || true)',
    'if [ -z "${p:-}" ]; then echo "KILLED=0"; exit 0; fi',
    'if kill -0 "$p" 2>/dev/null; then',
    '  kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true',
    '  for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$p" 2>/dev/null || break; sleep 0.3; done',
    '  if kill -0 "$p" 2>/dev/null; then kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true; fi',
    '  echo "KILLED=1"',
    'else',
    '  echo "KILLED=0"',
    'fi',
    `[ -f "$d/exit" ] || echo 143 > "$d/exit"`,
    'echo "OK=1"',
  ].join('\n')
}

/** The directory jobs live in, relative to the workspace root. */
export const JOBS_SUBDIR = JOBS_DIR
