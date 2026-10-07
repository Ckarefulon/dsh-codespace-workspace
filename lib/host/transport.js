/**
 * Remote data plane for dsh-codespace-workspace.
 *
 * Every byte that reaches a remote shell passes through {@link buildCommand},
 * which composes a POSIX command line from literal fragments and
 * {@link shq}-quoted values. A model-supplied path is never interpolated into
 * a command string: it is always quoted, and file bodies travel base64-encoded
 * so no content is ever interpreted by the shell.
 *
 * Two transports back the same interface:
 *   1. `gh codespace ssh -c <name> -- sh -lc '<cmd>'` when `gh` is usable.
 *   2. a direct `ssh <alias> sh -lc '<cmd>'` against a user-configured
 *      ssh-config alias, which is what actually runs on a machine without `gh`.
 *
 * @module dsh-codespace-workspace/host/transport
 */

import { spawn } from 'node:child_process'
import { redact } from '../shared.js'
import { ghExec, isNotRunning, shq } from './gh.js'

/** Default ceiling for one remote command. */
const DEFAULT_TIMEOUT_MS = 60000

/** Captured output is bounded; a runaway command must not exhaust memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Default read ceiling, in bytes, for {@link remoteReadText}. */
const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024

/**
 * A remote-operation failure carrying a stable `code`.
 *
 * Codes are `E_REMOTE_*` so the caller can tell a remote failure from a local
 * one without inspecting the message.
 */
export class RemoteError extends Error {
  /**
   * @param {string} message - human-readable, already redacted.
   * @param {string} code - stable machine code.
   */
  constructor(message, code) {
    super(redact(message))
    this.name = 'RemoteError'
    this.code = code
  }
}

/** The `ssh` binary, overridable for tests and unusual installs. */
const SSH_BIN = process.env.DSH_CODESPACE_SSH || 'ssh'

/**
 * Normalize an arbitrary path against a remote POSIX cwd.
 *
 * Mirrors `path.resolve` for POSIX semantics without importing the local
 * platform's path module, whose behaviour differs on Windows.
 *
 * A leading `~` cannot be expanded here: this function is synchronous and the
 * remote home is only knowable by asking the remote host. A `~`-prefixed input
 * is therefore returned with the tilde intact and the remainder normalized, so
 * the caller can hand it to {@link remoteExpandTilde} — never to a command
 * that quotes it, because a quoted tilde is not expanded by the shell.
 *
 * @param {string} cwd - the remote working directory; must be absolute.
 * @param {string} input - the model-supplied path.
 * @returns {string} an absolute POSIX path, or a `~`-prefixed one when the input was.
 */
export function remoteResolve(cwd, input) {
  const base = typeof cwd === 'string' && cwd.startsWith('/') ? cwd : '/'
  const raw = typeof input === 'string' ? input : ''
  if (raw.startsWith('/')) return normalizePosix(raw)
  if (raw === '~') return '~'
  if (raw.startsWith('~/')) return `~/${normalizePosix(`/${raw.slice(2)}`).slice(1)}`
  return normalizePosix(`${base}/${raw}`)
}

/** Whether a resolved path still needs {@link remoteExpandTilde}. */
export function needsTildeExpansion(path) {
  return typeof path === 'string' && (path === '~' || path.startsWith('~/'))
}

/**
 * Collapse `.` and `..` segments in an absolute POSIX path.
 *
 * @param {string} path - an absolute POSIX path.
 * @returns {string} the normalized path; `..` never escapes the root.
 */
function normalizePosix(path) {
  const segments = path.split('/')
  const out = []
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return `/${out.join('/')}`
}

/**
 * Build one remote command line from literal fragments and quoted values.
 *
 * @param {Array<string | {value: unknown}>} parts - literals, or `{value}` for a quoted value.
 * @returns {string} the composed command line.
 */
function buildCommand(parts) {
  return parts
    .map((part) => (part !== null && typeof part === 'object' ? shq(part.value) : String(part)))
    .join(' ')
}

/**
 * Describe why a target cannot be used, or null when it can.
 *
 * @param {{kind?: string, codespace?: string, alias?: string}} target - the transport target.
 * @returns {string|null} a plain-language reason, or null.
 */
function targetProblem(target) {
  if (target === null || typeof target !== 'object') return 'no transport target was configured'
  if (target.kind === 'gh') {
    if (typeof target.codespace !== 'string' || target.codespace.trim().length === 0) {
      return 'the Codespace name is missing'
    }
    return null
  }
  if (target.kind === 'ssh') {
    if (typeof target.alias !== 'string' || target.alias.trim().length === 0) {
      return 'no SSH host is configured — set the Codespace SSH alias in the settings, or install the GitHub CLI'
    }
    // A bare filesystem path cannot address a host, so an `ssh -i <key>` with no
    // destination would fail obscurely. Name the actual requirement instead.
    // VERIFY: the client's locale hint says "a private key path also works",
    // but docs/CONTRACT.md §7 specifies this fallback as an ssh-config *alias*,
    // and a key alone supplies no host to connect to. Tolerant branch: a
    // path-shaped value is reported as a misconfiguration with the fix spelled
    // out, rather than being passed to ssh as a hostname.
    if (/^[~.]|[/\\]/.test(target.alias.trim())) {
      return `the SSH setting looks like a key path (${target.alias.trim()}), but a private key alone cannot name a host — put a Host entry for the Codespace in ~/.ssh/config and use that alias here, or install the GitHub CLI`
    }
    return null
  }
  return `unknown transport kind ${JSON.stringify(String(target.kind))}`
}

/**
 * Run one program locally and capture its output.
 *
 * @param {string} command - executable.
 * @param {string[]} args - argument vector.
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] - execution options.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, timedOut: boolean, aborted: boolean}>} the captured result.
 */
function runLocal(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    let timedOut = false
    let aborted = false

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
      aborted = true
      kill()
    }

    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
    }

    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => finish(resolve, {
      stdout,
      stderr,
      exitCode: code ?? 0,
      timedOut,
      aborted,
    }))
  })
}

/**
 * Run a command inside a Codespace.
 *
 * @param {{kind: 'gh'|'ssh', codespace?: string, alias?: string, cwd?: string}} target - the transport target.
 * @param {string} command - the complete POSIX shell command line.
 * @param {{timeoutMs?: number, signal?: AbortSignal, run?: Function}} [options] - execution options.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, timedOut: boolean, aborted: boolean}>} a shell-run-shaped result.
 * @throws {RemoteError} `E_REMOTE_TARGET` when the target is unusable, `E_REMOTE_SPAWN` when the transport cannot start.
 */
export async function remoteExec(target, command, options = {}) {
  const problem = targetProblem(target)
  if (problem !== null) throw new RemoteError(problem, 'E_REMOTE_TARGET')

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const line = String(command)

  if (target.kind === 'gh') {
    const run = options.run
    if (typeof run !== 'function') {
      throw new RemoteError('the gh transport requires an injected executor', 'E_REMOTE_TARGET')
    }
    const result = await ghExec(run, target.codespace, line, { timeoutMs, signal: options.signal })
    if (result.exitCode === -1 && isNotRunning(result)) {
      throw new RemoteError(
        `Codespace ${target.codespace} is not running — start it, then retry. ${result.stderr}`.trim(),
        'E_REMOTE_NOT_RUNNING',
      )
    }
    if (result.exitCode === -1) {
      throw new RemoteError(result.stderr || 'gh codespace ssh could not start', 'E_REMOTE_SPAWN')
    }
    return { ...result, timedOut: false, aborted: false }
  }

  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    target.alias,
    'sh', '-lc', shq(line),
  ]
  try {
    return await runLocal(SSH_BIN, args, { timeoutMs, signal: options.signal })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new RemoteError(
      `cannot start ssh for alias ${JSON.stringify(String(target.alias))}: ${reason}. Install the GitHub CLI, or configure a working SSH alias.`,
      'E_REMOTE_SPAWN',
    )
  }
}

/**
 * Read a remote file as UTF-8 text.
 *
 * The body travels base64-encoded so no content is interpreted by the remote
 * shell. The read is capped: the caller is told when the file was truncated
 * rather than being handed an unbounded buffer.
 *
 * @param {object} target - the transport target.
 * @param {string} path - the remote path.
 * @param {{timeoutMs?: number, signal?: AbortSignal, maxBytes?: number, run?: Function}} [options] - read options.
 * @returns {Promise<{text: string, size: number, truncated: boolean}>} the decoded text and its size.
 * @throws {RemoteError} `E_REMOTE_NOT_FOUND` when the path is absent, `E_REMOTE_READ` otherwise.
 */
export async function remoteReadText(target, path, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_READ_BYTES
  // `-w0` keeps base64 on one line; `head -c` caps the raw bytes before
  // encoding, so a huge file cannot blow up the transfer.
  const command = buildCommand([
    'if [ -d', { value: path }, ']; then echo DSH_IS_DIR >&2; exit 3; fi;',
    'if [ ! -e', { value: path }, ']; then echo DSH_MISSING >&2; exit 4; fi;',
    'wc -c <', { value: path }, '| tr -d " ";',
    `head -c ${maxBytes}`,
    { value: path },
    '| base64 -w0',
  ])
  const result = await remoteExec(target, command, options)
  if (result.exitCode === 3) throw new RemoteError(`cannot read "${path}": is a directory`, 'E_REMOTE_IS_DIR')
  if (result.exitCode === 4) throw new RemoteError(`cannot read "${path}": not found`, 'E_REMOTE_NOT_FOUND')
  if (result.exitCode !== 0) {
    throw new RemoteError(`cannot read "${path}": ${result.stderr.trim() || `exit ${result.exitCode}`}`, 'E_REMOTE_READ')
  }

  const newline = result.stdout.indexOf('\n')
  if (newline < 0) throw new RemoteError(`cannot read "${path}": malformed transport response`, 'E_REMOTE_READ')
  const size = Number.parseInt(result.stdout.slice(0, newline).trim(), 10)
  const encoded = result.stdout.slice(newline + 1).replace(/\s+/g, '')
  let text
  try {
    text = Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    throw new RemoteError(`cannot read "${path}": malformed base64 payload`, 'E_REMOTE_READ')
  }
  const total = Number.isFinite(size) ? size : Buffer.byteLength(text, 'utf8')
  return { text, size: total, truncated: total > maxBytes }
}

/**
 * Atomically write UTF-8 text to a remote path.
 *
 * The body is base64-encoded and decoded remotely, then moved into place, so a
 * partially written file is never observable and no content byte is ever
 * interpreted by the shell.
 *
 * @param {object} target - the transport target.
 * @param {string} path - the remote path.
 * @param {string} content - the text to write.
 * @param {{timeoutMs?: number, signal?: AbortSignal, run?: Function}} [options] - write options.
 * @returns {Promise<{path: string, bytes: number}>} the written path and byte count.
 * @throws {RemoteError} `E_REMOTE_WRITE` on failure.
 */
export async function remoteWriteText(target, path, content, options = {}) {
  const text = typeof content === 'string' ? content : String(content ?? '')
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  const command = buildCommand([
    'dir=$(dirname', { value: path }, ') && mkdir -p "$dir" &&',
    `printf %s ${shq(encoded)} | base64 -d >`,
    { value: `${path}.dsh-tmp` },
    '&& mv', { value: `${path}.dsh-tmp` }, { value: path },
  ])
  const result = await remoteExec(target, command, options)
  if (result.exitCode !== 0) {
    throw new RemoteError(
      `cannot write "${path}": ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      'E_REMOTE_WRITE',
    )
  }
  return { path, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * List a remote directory as content-free entries.
 *
 * Uses `find -maxdepth 1` with NUL-separated records, so a filename with a
 * newline cannot be mistaken for two entries.
 *
 * @param {object} target - the transport target.
 * @param {string} path - the remote directory.
 * @param {{timeoutMs?: number, signal?: AbortSignal, run?: Function}} [options] - listing options.
 * @returns {Promise<Array<{name: string, type: 'file'|'dir'|'other', size: number}>>} the entries.
 * @throws {RemoteError} `E_REMOTE_NOT_FOUND` when the directory is absent.
 */
export async function remoteListDir(target, path, options = {}) {
  const command = buildCommand([
    'if [ ! -d', { value: path }, ']; then echo DSH_MISSING >&2; exit 4; fi;',
    'find', { value: path }, '-mindepth 1 -maxdepth 1 -printf "%y\\t%s\\t%f\\0" 2>/dev/null',
    '|| ls -A', { value: path },
  ])
  const result = await remoteExec(target, command, options)
  if (result.exitCode === 4) throw new RemoteError(`cannot list "${path}": not found`, 'E_REMOTE_NOT_FOUND')
  if (result.exitCode !== 0) {
    throw new RemoteError(`cannot list "${path}": ${result.stderr.trim() || `exit ${result.exitCode}`}`, 'E_REMOTE_READ')
  }

  const entries = []
  for (const record of result.stdout.split('\0')) {
    if (record.length === 0) continue
    const parts = record.split('\t')
    if (parts.length < 3) {
      // Fallback shape from the `ls -A` branch: a bare name, type unknown.
      entries.push({ name: record, type: 'other', size: 0 })
      continue
    }
    const kind = parts[0]
    entries.push({
      name: parts.slice(2).join('\t'),
      type: kind === 'd' ? 'dir' : kind === 'f' ? 'file' : 'other',
      size: Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 0,
    })
  }
  return entries
}

/**
 * Stat one remote path.
 *
 * @param {object} target - the transport target.
 * @param {string} path - the remote path.
 * @param {{timeoutMs?: number, signal?: AbortSignal, run?: Function}} [options] - stat options.
 * @returns {Promise<{type: 'file'|'dir'|'other', size: number, mtimeMs: number}|null>} the stat, or null when absent.
 */
export async function remoteStat(target, path, options = {}) {
  const command = buildCommand([
    'if [ -e', { value: path }, ']; then',
    'stat -c "%F\\t%s\\t%Y"', { value: path }, '2>/dev/null || stat -f "%HT\\t%z\\t%m"', { value: path },
    '; else echo DSH_MISSING; fi',
  ])
  const result = await remoteExec(target, command, options)
  const text = result.stdout.trim()
  if (result.exitCode !== 0 || text.length === 0 || text === 'DSH_MISSING') return null

  const parts = text.split('\t')
  if (parts.length < 3) return null
  const kind = parts[0].toLowerCase()
  const type = kind.includes('directory') || kind === 'dir' ? 'dir'
    : kind.includes('regular') || kind === 'file' ? 'file'
      : 'other'
  const seconds = Number(parts[2])
  return {
    type,
    size: Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 0,
    mtimeMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
  }
}

/**
 * Resolve the remote home directory.
 *
 * Exists so a `~`-prefixed path can be turned into a real absolute path before
 * any command that must quote it.
 *
 * @param {object} target - the transport target.
 * @param {{timeoutMs?: number, signal?: AbortSignal, run?: Function}} [options] - options.
 * @returns {Promise<string>} the absolute home path, or `/` when it cannot be read.
 */
export async function remoteHome(target, options = {}) {
  try {
    const result = await remoteExec(target, 'printf %s "$HOME"', options)
    const home = result.stdout.trim()
    return result.exitCode === 0 && home.startsWith('/') ? normalizePosix(home) : '/'
  } catch {
    return '/'
  }
}

/**
 * Expand a leading `~` against the real remote home.
 *
 * @param {object} target - the transport target.
 * @param {string} path - a possibly `~`-prefixed path.
 * @param {{timeoutMs?: number, signal?: AbortSignal, run?: Function}} [options] - options.
 * @returns {Promise<string>} an absolute POSIX path.
 */
export async function remoteExpandTilde(target, path, options = {}) {
  const raw = typeof path === 'string' ? path : ''
  if (!raw.startsWith('~')) return remoteResolve('/', raw)
  const home = await remoteHome(target, options)
  return normalizePosix(`${home}/${raw.slice(1)}`)
}
