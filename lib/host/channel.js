/**
 * A persistent command channel to one Codespace.
 *
 * WHY THIS EXISTS — the numbers, measured on a real Codespace
 * (`Ckarefulon/app.ckarefulon.main`, 2026-11-24, Windows host, gh 2.102):
 *
 *   `gh codespace ssh -c <name> -- sh -lc '<cmd>'`   ~5.5–8.1 s per command
 *   one long-lived channel, after warmup                ~0.115 s per command
 *
 * That is a 48× difference, and it is not a micro-optimisation: every remote
 * `read`, `stat`, `grep` and `write` paid the full connect cost, so a mundane
 * read+edit+grep round trip cost ~16 s of pure waiting. The cost was never the
 * command; it was standing up a dev tunnel, an sshd session and a login shell
 * *again* for each one.
 *
 * WHAT DOES NOT WORK — do not "fix" this with OpenSSH connection reuse:
 * `gh codespace ssh` hands out a `ProxyCommand` (`gh cs ssh --stdio`), and an
 * `ssh -o ControlMaster=yes -N` master over that proxy dies immediately with
 * `Read from remote host …: Unknown error`, leaving no socket. Multiplexing is
 * therefore unavailable at the ssh layer, and the only workable place to reuse
 * the connection is one level up: keep the remote side itself alive and speak a
 * tiny framed protocol to it.
 *
 * THE PROTOCOL — one request line in, exactly three response lines out:
 *
 *   request   `e <command, base64, no newlines>\n`
 *   response  `H ok 1 <exitCode> 0 0\n`
 *             `O <stdout, base64>\n`
 *             `E <stderr, base64>\n`
 *
 * Base64 everywhere means a command containing newlines, quotes, `$(…)` or
 * arbitrary bytes cannot desynchronise the framing, and the remote side never
 * has to reason about the content. Every remote command runs as
 * `bash -c <cmd> </dev/null`, which matters for two reasons: a remote `cat` in
 * `cat; echo after` must not swallow the protocol stream (a real bug this
 * framing had to survive), and a command that reads stdin must fail fast
 * rather than hang until the timeout.
 *
 * @module dsh-codespace-workspace/host/channel
 */

import { spawn } from 'node:child_process'
import { redact } from '../shared.js'

/** Binary used for the `ssh` transport; overridable for tests. */
const SSH_BIN = process.env.DSH_CODESPACE_SSH || 'ssh'

/** How long one command may take before the channel is declared dead. */
const DEFAULT_TIMEOUT_MS = 60000

/** How long the very first command may take (tunnel + sshd + login shell). */
const CONNECT_DEADLINE_MS = 45000

/** Ceiling on one buffered frame; a runaway command must not exhaust memory. */
const MAX_BUFFER_BYTES = 48 * 1024 * 1024

/**
 * The remote half of the protocol.
 *
 * Runs as `bash -c <AGENT>` on the Codespace and loops until stdin closes.
 * Deliberately boring: no job control, no state beyond the current command.
 * Anything stateful (background jobs) lives in files on disk, so a channel
 * restart cannot lose it — see `host/jobs.js`.
 */
const AGENT = [
  'set -u',
  // GNU coreutils has `-w0`; the BSD/base64 fallback strips newlines itself.
  'b64of() { base64 -w0 < "$1" 2>/dev/null || base64 < "$1" 2>/dev/null | tr -d "\\n"; }',
  'while IFS=" " read -r op payload; do',
  // `read` always assigns both variables (empty strings for an empty line), so
  // `$op` is defined under `set -u` without any default-expansion syntax — which
  // is what keeps this string free of ${...} and therefore safe to embed in a
  // JS template literal.
  '  if [ "$op" != "e" ]; then continue; fi',
  '  if [ -z "$payload" ]; then continue; fi',
  '  cmd=$(printf %s "$payload" | base64 -d 2>/dev/null)',
  '  o=$(mktemp); e=$(mktemp)',
  '  bash -c "$cmd" </dev/null >"$o" 2>"$e"',
  '  rc=$?',
  '  printf "H ok 1 %s 0 0\\n" "$rc"',
  '  printf "O %s\\n" "$(b64of "$o")"',
  '  printf "E %s\\n" "$(b64of "$e")"',
  '  rm -f "$o" "$e"',
  'done',
].join('\n')

/**
 * The agent, pre-encoded so it can travel through the login shell as a single
 * spacing-free token. See {@link RemoteChannel.recipe} for why that is required.
 */
const AGENT_B64 = Buffer.from(AGENT, 'utf8').toString('base64')

/** A channel-level failure (spawn, transport, protocol desync). Not a command failure. */
export class ChannelError extends Error {
  /**
   * @param {string} message - human-readable, already redacted.
   * @param {string} code - stable machine code.
   */
  constructor(message, code) {
    super(redact(message))
    this.name = 'ChannelError'
    this.code = code
  }
}

/**
 * The registry key for a target, without constructing a channel.
 *
 * @param {object} target - transport target.
 * @returns {string} the key.
 */
export function channelKey(target) {
  const kind = target?.kind
  const id = kind === 'ssh' ? target?.alias : target?.codespace
  return `${kind}:${id ?? ''}`
}

/**
 * One persistent channel to one target.
 *
 * Commands are strictly sequential by protocol, so callers are queued. That is
 * not a limitation in practice (0.115 s per command) and it keeps the framing
 * trivial; the one thing that MUST NOT go through this queue is a long build,
 * which is what `host/jobs.js` is for.
 */
export class RemoteChannel {
  /**
   * @param {{kind: 'gh'|'ssh', codespace?: string, alias?: string}} target - transport target.
   * @param {{spawnFn?: Function, log?: Function}} [options] - injectable seams.
   */
  constructor(target, options = {}) {
    this.target = target
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn
    this.child = null
    this.dead = false
    this.pending = null
    this.buffer = ''
    this.frameLines = []
    this.queue = Promise.resolve()
    this.commands = 0
    this.stderrTail = ''
  }

  /** @returns {string} a stable key for logging and registry lookup. */
  get key() {
    return channelKey(this.target)
  }

  /** @returns {boolean} whether the channel currently holds a live child. */
  get alive() {
    return this.child !== null && !this.dead
  }

  /**
   * The spawn recipe for the remote agent, or a reason it cannot be started.
   *
   * TWO HAZARDS, both measured, both silent:
   *
   * 1. `gh codespace ssh` and `ssh` do not forward an argv vector — they join
   *    the trailing arguments with spaces and hand the result to the remote
   *    login shell as ONE string. So `bash -c <script>` does not mean "run this
   *    script": the remote shell sees `bash -c set -u` and treats the rest of
   *    the script as separate commands, with `$0` set to `-u`. The symptom was
   *    an environment dump (`BASH_EXECUTION_STRING=set`) flooding the protocol
   *    stream before the first frame. Hence: ship the agent as base64.
   *
   * 2. `bash -c "$(base64 -d)"` or `… | bash` makes bash read the SCRIPT from
   *    stdin — and stdin is the protocol pipe. bash consumes the script, hits
   *    EOF, and the command loop exits before the first frame is ever written.
   *    The symptom was a channel that opened, exited 0, and answered nothing.
   *    Hence: the agent is decoded to a FILE and exec'd, leaving stdin free.
   *
   * @returns {{command: string, args: string[]}|{reason: string, command: string, args: string[]}} the recipe.
   */
  recipe() {
    const target = this.target
    // `mktemp` keeps the temp file out of $HOME (read-only in some images) and
    // `exec` replaces the shell, so SIGTERM to the child is felt by the agent
    // rather than by a parent that would leave it orphaned.
    const expand = `f=$(mktemp) && echo ${AGENT_B64} | base64 -d > "$f" && exec bash "$f"`
    if (target?.kind === 'gh') {
      if (typeof target.codespace !== 'string' || target.codespace.trim().length === 0) {
        return { reason: 'the Codespace name is missing', command: 'gh', args: [] }
      }
      return {
        command: 'gh',
        args: ['codespace', 'ssh', '-c', String(target.codespace), '--', expand],
      }
    }
    if (target?.kind === 'ssh') {
      const alias = target.alias
      if (typeof alias !== 'string' || alias.trim().length === 0) {
        return { reason: 'no SSH host is configured', command: SSH_BIN, args: [] }
      }
      return {
        command: SSH_BIN,
        args: ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', alias, expand],
      }
    }
    return {
      reason: `unknown transport kind ${JSON.stringify(String(target?.kind))}`,
      command: 'gh',
      args: [],
    }
  }

  /**
   * Run one command on the channel.
   *
   * @param {string} command - a POSIX shell command line.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] - bounds.
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>} the result.
   * @throws {ChannelError} when the channel itself fails (never for a non-zero exit).
   */
  exec(command, options = {}) {
    const run = () => this.#exchange(String(command), options)
    const chained = this.queue.then(run, run)
    // Keep the queue alive regardless of this command's outcome.
    this.queue = chained.then(() => undefined, () => undefined)
    return chained
  }

  /**
   * Open the channel and wait until the remote agent answers.
   *
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>} the warm-up result.
   */
  async ready() {
    return await this.exec('true', { timeoutMs: CONNECT_DEADLINE_MS })
  }

  /** Kill the channel. In-flight commands reject; the next {@link exec} respawns. */
  close() {
    this.#teardown(new ChannelError('the Codespace channel was closed', 'EC_CHANNEL_CLOSED'))
  }

  // ------------------------------------------------------------------ internals

  #spawn() {
    const recipe = this.recipe()
    if (recipe.reason !== undefined) {
      throw new ChannelError(`cannot open a channel: ${recipe.reason}`, 'EC_CHANNEL_TARGET')
    }
    let child
    try {
      child = this.spawnFn(recipe.command, recipe.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw new ChannelError(
        `cannot start ${recipe.command}: ${error instanceof Error ? error.message : String(error)}`,
        'EC_CHANNEL_SPAWN',
      )
    }

    this.child = child
    this.dead = false
    this.buffer = ''
    this.frameLines = []
    this.commands = 0
    this.stderrTail = ''

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on?.('data', (chunk) => this.#onData(chunk))
    if (child.stderr !== null && child.stderr !== undefined) {
      // The remote agent's own stderr is transport noise (gh auth prompts, ssh
      // warnings, `ignoring bad CNAME`). Kept for diagnosis, never mistaken for
      // command output.
      child.stderr.setEncoding?.('utf8')
      child.stderr.on('data', (chunk) => {
        this.stderrTail = (this.stderrTail + String(chunk)).slice(-2048)
      })
    }
    child.on?.('error', (error) => {
      this.#teardown(new ChannelError(
        `the Codespace channel failed: ${error instanceof Error ? error.message : String(error)}`,
        'EC_CHANNEL_SPAWN',
      ), child)
    })
    child.on?.('exit', (code, signal) => {
      const detail = this.stderrTail.length > 0 ? `: ${this.stderrTail.trim().slice(-400)}` : ''
      this.#teardown(new ChannelError(
        `the Codespace channel exited (${signal ?? code})${detail}`,
        'EC_CHANNEL_EXITED',
      ), child)
    })
  }

  #onData(chunk) {
    this.buffer += String(chunk)
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.#teardown(new ChannelError('the Codespace channel sent an implausibly large frame', 'EC_CHANNEL_PROTOCOL'))
      return
    }
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      this.frameLines.push(line)
      if (this.frameLines.length === 3) {
        const lines = this.frameLines
        this.frameLines = []
        this.#onFrame(lines)
      }
    }
  }

  #onFrame(lines) {
    const waiter = this.pending
    this.pending = null
    if (waiter === null) return
    // `resolve`/`reject` own the cleanup (timer, abort listener). Calling
    // `settle()` first would mark the command settled and turn the following
    // `resolve` into a no-op — a promise that never settles, with the correct
    // frame already parsed. That was a real bug, not a theoretical one.
    const [header, out, err] = lines
    if (!header.startsWith('H ')) {
      waiter.reject(new ChannelError(
        `unexpected frame header ${JSON.stringify(header.slice(0, 80))}`,
        'EC_CHANNEL_PROTOCOL',
      ))
      return
    }
    const status = header.split(' ')[1]
    if (status !== 'ok') {
      waiter.reject(new ChannelError(`the Codespace channel rejected the command (${status})`, 'EC_CHANNEL_PROTOCOL'))
      return
    }
    const rc = Number(header.split(' ')[3])
    waiter.resolve({
      stdout: decodeFrame(out),
      stderr: decodeFrame(err),
      exitCode: Number.isFinite(rc) ? rc : 0,
    })
  }

  #exchange(command, options) {
    return new Promise((resolve, reject) => {
      if (this.dead || this.child === null) {
        try {
          this.#spawn()
        } catch (error) {
          reject(error)
          return
        }
      }
      const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS
      const child = this.child
      const signal = options?.signal

      let settled = false
      let timer = null

      // One place that decides the outcome. The previous shape had
      // `settle()` mark the command settled and then `resolve()` call a guard
      // that saw `settled === true` and did nothing — a promise that never
      // settles, hanging every later command on the queue behind it.
      const done = (fn, value) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        if (signal !== undefined && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
        fn(value)
      }

      const onAbort = () => {
        // Aborting must also free the queue, so the channel is torn down rather
        // than left waiting for a frame that will still arrive later.
        this.#teardown(new ChannelError('the command was aborted', 'EC_CHANNEL_ABORTED'))
      }

      if (signal !== undefined && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          reject(new ChannelError('the command was aborted', 'EC_CHANNEL_ABORTED'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      timer = setTimeout(() => {
        if (settled) return
        // A timed-out command cannot be interrupted in-protocol (the remote bash
        // is still running it), so the honest recovery is to drop the connection
        // and let the next command open a fresh one. Background jobs survive:
        // they run detached and write to files on disk.
        this.#teardown(new ChannelError(
          `the command did not finish within ${timeoutMs} ms on the Codespace`,
          'EC_CHANNEL_TIMEOUT',
        ))
      }, timeoutMs)
      timer.unref?.()

      this.pending = {
        // `settle` exists for the teardown path, which has already taken the
        // pending slot and needs the timer/listener released without deciding
        // the outcome itself.
        settle: () => {
          settled = true
          if (timer !== null) clearTimeout(timer)
          if (signal !== undefined && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort)
          }
        },
        resolve: (value) => done(resolve, value),
        reject: (error) => done(reject, error),
      }

      try {
        child.stdin.write(`e ${Buffer.from(command, 'utf8').toString('base64')}\n`)
      } catch (error) {
        this.pending = null
        done(reject, new ChannelError(
          `cannot write to the Codespace channel: ${error instanceof Error ? error.message : String(error)}`,
          'EC_CHANNEL_WRITE',
        ))
        return
      }
      this.commands += 1
    })
  }

  /**
   * Tear down the channel.
   *
   * `origin` names the child whose failure triggered this, and is how a STALE
   * event is told apart from a live one: after {@link close} kills a child and
   * the next command spawns a replacement, the killed child's `exit` event
   * still arrives — and used to nuke the replacement, so the channel died once
   * per reopen. Measured as `EC_CHANNEL_EXITED … Connection reset` on the first
   * command after a deliberate close.
   *
   * @param {Error} error - the outcome for whoever is waiting.
   * @param {object} [origin] - the child that caused the failure, when known.
   */
  #teardown(error, origin) {
    if (origin !== undefined && origin !== this.child) return
    const child = this.child
    this.child = null
    this.dead = true
    this.buffer = ''
    this.frameLines = []
    const waiter = this.pending
    this.pending = null
    if (child !== null) {
      try {
        child.stdin?.end?.()
      } catch {
        /* already closed */
      }
      try {
        child.kill?.()
      } catch {
        /* already gone */
      }
    }
    if (waiter !== null) {
      // The teardown error is the outcome; `reject` also releases the timer and
      // the abort listener, so `settle()` must not be called first.
      waiter.reject(error)
    }
  }
}

/** Decode one `O …` / `E …` frame body into text. */
function decodeFrame(line) {
  if (typeof line !== 'string' || line.length < 3) return ''
  const body = line.slice(2).trim()
  if (body.length === 0) return ''
  try {
    return Buffer.from(body, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** Every live channel, so the plugin can close them on unload. */
const registry = new Map()

/**
 * Get (or open) the shared channel for a target.
 *
 * One channel per Codespace is shared by every session that targets it: the
 * expensive part is the connection, not the multiplexing.
 *
 * @param {object} target - transport target.
 * @param {{spawnFn?: Function, log?: Function}} [options] - injectable seams.
 * @returns {RemoteChannel} the channel; callers must not close it themselves.
 */
export function channelFor(target, options = {}) {
  const key = channelKey(target)
  let channel = registry.get(key)
  if (channel === undefined) {
    channel = new RemoteChannel(target, options)
    registry.set(key, channel)
  }
  return channel
}

/**
 * Forget the channel for a target.
 *
 * Called when a Codespace changes state: a stopped Codespace leaves a channel
 * whose child is already gone, and reusing it would turn every later call into
 * a confusing `EC_CHANNEL_EXITED`.
 *
 * @param {object} target - transport target.
 * @returns {void}
 */
export function dropChannel(target) {
  const key = channelKey(target)
  const channel = registry.get(key)
  if (channel === undefined) return
  registry.delete(key)
  channel.close()
}

/** Close every channel. Called from the plugin's teardown. */
export function closeAllChannels() {
  for (const [key, channel] of registry) {
    registry.delete(key)
    channel.close()
  }
}

/** @returns {number} how many channels are currently registered. */
export function channelCount() {
  return registry.size
}
