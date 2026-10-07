/**
 * GitHub CLI (`gh`) detection and invocation for dsh-codespace-workspace.
 *
 * `gh` is the *preferred* data plane, not a required one: it is not installed
 * on every machine (it is absent on the one this plugin was developed on), so
 * every entry point here degrades to a plain, actionable result rather than
 * throwing. The caller decides what to do when `gh` is unavailable.
 *
 * The `run` executor is injected so this module stays testable and so the
 * caller owns timeouts, cancellation, and process policy.
 *
 * @module dsh-codespace-workspace/host/gh
 */

import { spawn } from 'node:child_process'
import { redact } from '../shared.js'

/** Detection must return quickly even when `gh` is present but wedged. */
const DETECT_TIMEOUT_MS = 5000

/** Default ceiling for one remote command. */
const EXEC_TIMEOUT_MS = 60000

/** Captured output is bounded; a runaway command must not exhaust memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Spawn one program and capture its output.
 *
 * This is the default `run` implementation. It never rejects on a non-zero
 * exit status — a non-zero exit is a result, not an exception — and it
 * rejects only when the process could not be started at all, which is the
 * case {@link ghInfo} needs to distinguish "absent" from "failed".
 *
 * @param {string} command - executable name or path.
 * @param {string[]} args - argument vector.
 * @param {{timeoutMs?: number, signal?: AbortSignal, cwd?: string}} [options] - execution options.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>} the captured result.
 */
export function defaultRun(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
      fn(value)
    }

    const kill = () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }

    function onAbort() {
      kill()
      finish(reject, new Error('gh invocation aborted'))
    }

    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : EXEC_TIMEOUT_MS
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        kill()
        finish(resolve, { stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]`, exitCode: 124 })
      }, timeoutMs)
    }

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => finish(resolve, { stdout, stderr, exitCode: code ?? 0 }))
  })
}

/**
 * Detect `gh` and, when present, its version, auth state, and login.
 *
 * @param {Function} [run] - injected executor.
 * @returns {Promise<{installed: boolean, version: string, authenticated: boolean, login: string, error?: string}>} the detection result.
 */
export async function ghInfo(run = defaultRun) {
  const absent = { installed: false, version: '', authenticated: false, login: '' }

  let version
  try {
    version = await run('gh', ['--version'], { timeoutMs: DETECT_TIMEOUT_MS })
  } catch {
    // ENOENT (not installed) and any other spawn failure land here. Both mean
    // "no usable gh"; the difference is not actionable for the user, so it is
    // not reported as an error.
    return absent
  }

  if (!version || version.exitCode !== 0) return absent

  // `gh version 2.40.0 (2024-01-01)` — the first token after the word "version".
  const first = String(version.stdout ?? '').split('\n')[0] ?? ''
  const match = /version\s+(\S+)/i.exec(first)
  const reported = match?.[1] ?? first.trim()

  const info = { installed: true, version: reported, authenticated: false, login: '' }

  try {
    const status = await run('gh', ['auth', 'status'], { timeoutMs: DETECT_TIMEOUT_MS })
    // `gh auth status` writes its report to stderr and exits non-zero when not
    // logged in; both streams are scanned so the message shape does not matter.
    const text = `${status?.stdout ?? ''}\n${status?.stderr ?? ''}`
    info.authenticated = status?.exitCode === 0
    const login = /Logged in to \S+ account ([^\s(]+)/i.exec(text)
    if (login?.[1] !== undefined) info.login = login[1]
  } catch {
    // Auth state is informational: an absent answer leaves both fields false.
  }

  return info
}

/**
 * Whether `gh` can be used as a data plane.
 *
 * @param {{installed?: boolean, authenticated?: boolean}} info - a {@link ghInfo} result.
 * @returns {boolean} true when `gh` is installed and logged in.
 */
export function ghAvailable(info) {
  return info !== undefined && info !== null && info.installed === true && info.authenticated === true
}

/**
 * Quote one string as a single POSIX shell word.
 *
 * This is the only place a value becomes part of a command line. Wrapping in
 * single quotes makes every byte literal — spaces, `$`, backticks, newlines,
 * glob characters — and an embedded single quote is closed, escaped, and
 * reopened (`'\''`), which is the one sequence that cannot be expressed
 * inside single quotes directly.
 *
 * @param {unknown} value - the value to quote.
 * @returns {string} a single-quoted shell word.
 */
export function shq(value) {
  return `'${String(value).split("'").join("'\\''")}'`
}

/**
 * Run one command inside a Codespace through `gh codespace ssh`.
 *
 * The remote command is single-quoted by {@link shq} and passed as one argv
 * element after `sh -lc`, so it survives `gh`'s argv forwarding and the remote
 * shell receives it verbatim instead of re-splitting it on spaces.
 *
 * VERIFY: `gh` is not installed on this machine, so the exact argv forwarding
 * of `gh codespace ssh -c <name> -- sh -lc '<cmd>'` could not be exercised.
 * Tolerant branch: a forwarding difference shows up as a non-zero exit with
 * `gh`'s own stderr text, which the caller surfaces verbatim; it cannot
 * silently run a *different* command, because the quoting is applied here
 * rather than left to the remote shell.
 *
 * @param {Function} run - injected executor.
 * @param {string} codespaceName - target Codespace.
 * @param {string} command - the complete POSIX shell command line, unquoted.
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] - execution options.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>} the result, with `exitCode: -1` when `gh` could not start.
 */
export async function ghExec(run, codespaceName, command, options = {}) {
  const args = ['codespace', 'ssh', '-c', String(codespaceName), '--', 'sh', '-lc', shq(command)]
  try {
    const result = await run('gh', args, {
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : EXEC_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    return {
      stdout: String(result?.stdout ?? ''),
      stderr: redact(String(result?.stderr ?? '')),
      exitCode: Number.isFinite(result?.exitCode) ? result.exitCode : 0,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { stdout: '', stderr: redact(`gh codespace ssh failed: ${reason}`), exitCode: -1 }
  }
}

/**
 * Whether a failed `gh` invocation means the Codespace is not running.
 *
 * The UI offers to start it instead of showing a bare failure.
 *
 * @param {{stderr?: string, exitCode?: number}} result - a {@link ghExec} result.
 * @returns {boolean} true when the message names a non-running Codespace.
 */
export function isNotRunning(result) {
  const text = String(result?.stderr ?? '')
  return /not\s+running|is\s+shutdown|is\s+stopped|start\s+the\s+codespace/i.test(text)
}

/**
 * Create a Codespace through the CLI.
 *
 * VERIFY: the flag set below is taken from the `gh codespace create` manual
 * (`-R/--repo`, `-b/--branch`, `-m/--machine`, `-d/--display-name`,
 * `--idle-timeout` as a *duration* such as `30m`, `--default-permissions`).
 * It could not be exercised here because `gh` is not installed on this
 * machine. Tolerant branch: the REST path is the one this plugin actually
 * uses for creation, so a wrong flag degrades to "the CLI path failed" and
 * never to a wrong Codespace.
 *
 * @param {Function} run - injected executor.
 * @param {{repo: string, branch?: string, machine?: string, displayName?: string, idleTimeoutMinutes?: number}} options - creation inputs.
 * @returns {Promise<{name: string, stdout: string, stderr: string, exitCode: number}>} the new Codespace name when it succeeded.
 */
export async function ghCreate(run, options) {
  const args = ['codespace', 'create', '-R', String(options.repo)]
  if (typeof options.branch === 'string' && options.branch.trim().length > 0) {
    args.push('-b', options.branch.trim())
  }
  if (typeof options.machine === 'string' && options.machine.trim().length > 0) {
    args.push('-m', options.machine.trim())
  }
  if (typeof options.displayName === 'string' && options.displayName.trim().length > 0) {
    args.push('-d', options.displayName.trim().slice(0, 48))
  }
  if (Number.isFinite(options.idleTimeoutMinutes) && options.idleTimeoutMinutes > 0) {
    args.push('--idle-timeout', `${Math.round(options.idleTimeoutMinutes)}m`)
  }
  args.push('--default-permissions')

  try {
    // No `--json` on this subcommand: it prints the new Codespace name alone.
    const result = await run('gh', args, { timeoutMs: 300000 })
    return {
      name: String(result?.stdout ?? '').trim(),
      stdout: String(result?.stdout ?? ''),
      stderr: redact(String(result?.stderr ?? '')),
      exitCode: Number.isFinite(result?.exitCode) ? result.exitCode : 0,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { name: '', stdout: '', stderr: redact(`gh codespace create failed: ${reason}`), exitCode: -1 }
  }
}
