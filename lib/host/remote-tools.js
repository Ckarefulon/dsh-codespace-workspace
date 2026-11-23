/**
 * Remote tool surface for one Codespace agent.
 *
 * The mechanism is the supported per-agent seam: tools are registered through
 * `agent.ctx`, which scopes them to that agent, and a scoped registration
 * shadows a same-named global for that agent only. Nothing global is replaced,
 * so every other session and every other plugin is unaffected.
 *
 * The shadow tools deliberately mirror the local tools' `output.schema` and
 * their `[exit code: N]` marker contract, because the presentation layer reads
 * both: the UI renders the same cards, and `parseExitStatus` from
 * `@deepseek-ai/dsh-shell` recovers the exit pill from the rendered text.
 *
 * @module dsh-codespace-workspace/host/remote-tools
 */

import { redact } from '../shared.js'
import { doctorTool } from './doctor.js'
import { shq } from './gh.js'
import { cancelScript, isJobId, launchScript, newJobId, parseStatus, statusScript } from './jobs.js'
import { registryDefinition } from './schema.js'
import {
  remoteListDir,
  remoteReadText,
  remoteResolve,
  remoteStat,
  remoteWriteText,
  needsTildeExpansion,
  remoteExpandTilde,
  remoteExec,
} from './transport.js'

/** Default line cap for a remote `read`, matching the local tool's default. */
const READ_LIMIT = 2000

/** Default ceiling for one remote shell command. */
const EXEC_TIMEOUT_MS = 60000

/** Ceiling on a remote glob/grep scan. */
const SEARCH_TIMEOUT_MS = 30000

/** A model-supplied path is only usable once it is absolute on the remote host. */
async function absolutePath(target, cwd, input, options) {
  const resolved = remoteResolve(cwd, input)
  if (!needsTildeExpansion(resolved)) return resolved
  return remoteExpandTilde(target, resolved, options)
}

/** Format a read window as the same envelope the local `read` tool emits. */
function formatReadOutput(displayPath, outcome) {
  const endLine = outcome.lines.length > 0 ? outcome.lines[outcome.lines.length - 1].number : Math.max(0, outcome.offset - 1)
  let footer
  if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map((line) => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

/** Build a read window from raw text. */
function windowLines(text, offset, limit) {
  const all = text.split('\n')
  // A trailing newline produces one empty final element that is not a line.
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  const start = Math.max(1, offset)
  const end = Math.min(all.length, start - 1 + limit)
  const lines = []
  for (let index = start - 1; index < end; index += 1) {
    lines.push({ number: index + 1, text: all[index] })
  }
  return { lines, totalLines: all.length }
}

/**
 * Render a remote shell result with the local tool's marker contract.
 *
 * The markers are appended in the same order the local tools use, so
 * `parseExitStatus` recovers the same exit code from the same shape.
 *
 * @param {{stdout: string, stderr: string, exitCode: number, timedOut: boolean, aborted: boolean}} result - the remote result.
 * @returns {string} the model-facing text.
 */
function renderShellResult(result) {
  let body = result.stdout
  if (result.stderr.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${result.stderr}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = []
  if (result.timedOut) markers.push(`[timed out after ${EXEC_TIMEOUT_MS}ms]`)
  if (result.aborted) markers.push('[aborted]')
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/** The remote `bash` tool. */
function bashTool(target, cwd, run, jobRoot) {
  return {
    name: 'bash',
    description: [
      'Execute a bash command inside the remote GitHub Codespace and return its stdout/stderr.',
      'This runs on the Codespace, not on the local machine: paths are POSIX and the working',
      'directory is the Codespace checkout. Pass `workdir` instead of using `cd`.',
      'For a LONG command (a build, a test suite, a package install) pass `background: true`',
      'instead of a large timeout: it returns a job id at once, the process keeps running in',
      'the Codespace even if this session ends, and job_status / job_cancel manage it.',
    ].join(' '),
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
      },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      workdir: { type: 'string', description: 'Working directory for this command; a relative path resolves against the Codespace workspace.' },
      background: {
        type: 'boolean',
        description: 'Run detached and return a job id instead of waiting. Use for builds and other long commands.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          jobId: { type: 'string' },
        },
      },
      render: (_args, value) => {
        // A background launch has nothing to show but the id; rendering an
        // empty shell card would read like a command that produced no output.
        if (typeof value.jobId === 'string' && value.jobId.length > 0) {
          return [{
            type: 'text',
            text: `Started background job ${value.jobId} on the Codespace.\n`
              + 'It keeps running even if this session ends; poll it with job_status and stop it with job_cancel.',
          }]
        }
        return [{ type: 'text', text: renderShellResult(value) }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const command = String(args.command ?? '')
      if (command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
      const workdir = args.workdir === undefined ? cwd : await absolutePath(target, cwd, args.workdir, { run })

      if (args.background === true) {
        const id = newJobId()
        const root = await jobRoot(exec)
        const started = await remoteExec(target, launchScript(root, id, command, workdir), {
          // Only the LAUNCH is bounded; the job itself deliberately is not.
          timeoutMs: 30000,
          signal: exec?.signal,
          run,
        })
        if (started.exitCode !== 0) {
          throw new Error(`could not start the background job: ${started.stderr.trim() || `exit ${started.exitCode}`}`)
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, jobId: id }
      }

      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : EXEC_TIMEOUT_MS
      // The workdir is single-quoted, so a failure to enter it is reported by
      // the command itself rather than silently running in the wrong place.
      const result = await remoteExec(target, `cd ${shellQuote(workdir)} 2>/dev/null; ${command}`, {
        timeoutMs,
        signal: exec?.signal,
        run,
      })
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        aborted: result.aborted,
      }
    },
  }
}

/** The remote `job_status` tool: poll a job started by `bash background`. */
function jobStatusTool(target, cwd, run, jobRoot) {
  return {
    name: 'job_status',
    description: [
      'Report the state of a background job started with `bash background: true` on the Codespace:',
      'whether it is still running, its exit code once finished, and the tail of its stdout/stderr.',
      'Safe to call repeatedly — it reads files on disk, so it survives reconnects and restarts.',
    ].join(' '),
    parameters: {
      jobId: { type: 'string', required: true, description: 'The job id returned by `bash background: true`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['running', 'finished', 'missing'] },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          stdoutBytes: { type: 'integer', required: true },
          stderrBytes: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderJobStatus(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = String(args.jobId ?? '')
      if (!isJobId(id)) throw new Error('jobId must be the id returned by `bash background: true`')
      const result = await remoteExec(target, statusScript(await jobRoot(exec), id), {
        timeoutMs: EXEC_TIMEOUT_MS,
        signal: exec?.signal,
        run,
      })
      const state = parseStatus(result.stdout)
      if (state.missing) {
        return {
          jobId: id,
          state: 'missing',
          exitCode: null,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdout: '',
          stderr: '',
        }
      }
      return {
        jobId: id,
        // The exit file is authoritative: the wrapper writes it as its very last
        // action, so a job with an exit code has finished even if its pid has
        // not been reaped yet.
        state: state.done ? 'finished' : (state.running ? 'running' : 'finished'),
        exitCode: state.exitCode,
        stdoutBytes: state.stdoutBytes,
        stderrBytes: state.stderrBytes,
        stdout: state.stdout,
        stderr: state.stderr,
      }
    },
  }
}

/** The remote `job_cancel` tool: stop a background job. */
function jobCancelTool(target, cwd, run, jobRoot) {
  return {
    name: 'job_cancel',
    description: [
      'Stop a background job started with `bash background: true` on the Codespace.',
      'Kills the whole process group, because a build leaves compilers behind that would',
      'keep consuming the machine after the wrapper dies.',
    ].join(' '),
    parameters: {
      jobId: { type: 'string', required: true, description: 'The job id returned by `bash background: true`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          cancelled: { type: 'boolean', required: true },
          missing: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.missing
          ? 'That job does not exist (no such job id in this Codespace).'
          : (value.cancelled ? 'The background job was stopped.' : 'The background job was already finished; nothing to stop.'),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const id = String(args.jobId ?? '')
      if (!isJobId(id)) throw new Error('jobId must be the id returned by `bash background: true`')
      const result = await remoteExec(target, cancelScript(await jobRoot(exec), id), {
        timeoutMs: EXEC_TIMEOUT_MS,
        signal: exec?.signal,
        run,
      })
      return {
        jobId: id,
        missing: /MISSING=1/.test(result.stdout),
        cancelled: /KILLED=1/.test(result.stdout),
      }
    },
  }
}

/** Render a job's state with the local shell tools' marker contract. */
function renderJobStatus(value) {
  if (value.state === 'missing') {
    return `No background job named ${value.jobId} exists in this Codespace.`
  }
  const head = value.state === 'running'
    ? `Job ${value.jobId} is still running.`
    : `Job ${value.jobId} finished with exit code ${value.exitCode ?? 'unknown'}.`
  const parts = [head]
  if (value.stdoutBytes > value.stdout.length) {
    // Honest about the truncation: the file holds everything, this reply is the
    // tail, and a model that needs more can `bash tail` it.
    parts.push(`(stdout is ${value.stdoutBytes} bytes; showing the last ${value.stdout.length})`)
  }
  if (value.stdout.length > 0) parts.push('', value.stdout)
  if (value.stderr.length > 0) parts.push('[stderr]', value.stderr)
  const markers = []
  if (value.state === 'running') markers.push('[still running]')
  else if (value.exitCode !== null && value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`)
  if (markers.length > 0) parts.push('', markers.join('\n'))
  return parts.join('\n')
}

/** The remote `read` tool. */
function readTool(target, cwd, run) {
  return {
    name: 'read',
    description: 'Read a UTF-8 text file from the remote Codespace and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved inside the Codespace.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatReadOutput(value.path, value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = String(args.file_path ?? '')
      if (input.trim().length === 0) throw new Error('file_path must be a non-empty string')
      const offset = Number.isFinite(args.offset) ? Math.max(1, Math.round(args.offset)) : 1
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.round(args.limit) : READ_LIMIT
      const path = await absolutePath(target, cwd, input, { run })
      const info = await remoteStat(target, path, { run, signal: exec?.signal })
      if (info === null) throw new Error(`cannot read "${path}": not found`)
      if (info.type !== 'file') throw new Error(`cannot read "${path}": not a regular file`)
      const read = await remoteReadText(target, path, { run, signal: exec?.signal })
      const window = windowLines(read.text, offset, limit)
      return { path, offset, lines: window.lines, totalLines: window.totalLines }
    },
  }
}

/** The remote `write` tool. */
function writeTool(target, cwd, run) {
  return {
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file inside the remote Codespace.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to write, resolved inside the Codespace.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          after: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<type>file</type>\n<content>\n${value.operation === 'create' ? 'Created' : 'Updated'} file\n</content>`,
      }],
    },
    async execute(args, exec) {
      const input = String(args.file_path ?? '')
      if (input.trim().length === 0) throw new Error('file_path must be a non-empty string')
      const content = typeof args.content === 'string' ? args.content : ''
      const path = await absolutePath(target, cwd, input, { run })
      let before = null
      const info = await remoteStat(target, path, { run, signal: exec?.signal })
      if (info !== null) {
        if (info.type !== 'file') throw new Error(`cannot write "${path}": not a regular file`)
        before = (await remoteReadText(target, path, { run, signal: exec?.signal })).text
      }
      await remoteWriteText(target, path, content, { run, signal: exec?.signal })
      return { path, operation: before === null ? 'create' : 'update', before, after: content }
    },
  }
}

/** The remote `edit` tool. */
function editTool(target, cwd, run) {
  return {
    name: 'edit',
    description: 'Edit an existing UTF-8 text file in the remote Codespace by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved inside the Codespace.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: args.replace_all === true
          ? `The file ${value.path} has been updated. All occurrences were successfully replaced.`
          : `The file ${value.path} has been updated successfully.`,
      }],
    },
    async execute(args, exec) {
      const input = String(args.file_path ?? '')
      if (input.trim().length === 0) throw new Error('file_path must be a non-empty string')
      const oldString = String(args.old_string ?? '')
      const newString = String(args.new_string ?? '')
      if (oldString.length === 0) throw new Error('old_string must be a non-empty string')
      if (oldString === newString) throw new Error('old_string and new_string must differ')

      const path = await absolutePath(target, cwd, input, { run })
      const read = await remoteReadText(target, path, { run, signal: exec?.signal })
      const before = read.text
      const parts = before.split(oldString)
      const occurrences = parts.length - 1
      if (occurrences === 0) throw new Error(`cannot edit "${path}": old_string was not found`)
      if (occurrences > 1 && args.replace_all !== true) {
        throw new Error(`cannot edit "${path}": old_string appears ${occurrences} times — pass replace_all, or include more context to make it unique`)
      }
      const after = args.replace_all === true ? parts.join(newString) : before.replace(oldString, newString)
      await remoteWriteText(target, path, after, { run, signal: exec?.signal })
      return { path, before, after }
    },
  }
}

/** The remote `glob` tool. */
function globTool(target, cwd, run) {
  return {
    name: 'glob',
    description: 'Find files in the remote Codespace whose paths match a glob pattern. Returns up to 200 paths.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern to match file paths against (e.g. "**/*.ts").' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the Codespace workspace root.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.paths.length === 0 ? `(no matches in ${value.root})` : value.paths.join('\n'),
      }],
    },
    async execute(args, exec) {
      const pattern = String(args.pattern ?? '')
      if (pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
      const root = args.path === undefined ? cwd : await absolutePath(target, cwd, args.path, { run })
      // `rg` is NOT guaranteed on a Codespace base image (`vscode` user on
      // mcr.microsoft.com/devcontainers/java has no `rg`), and the old command
      // hid that behind `2>/dev/null || find …` — where `find -name <glob>` also
      // failed, so the tool answered "(no matches)" for every query. A silent
      // empty answer is the one failure mode a search tool must not have.
      //
      // `find -name` needs a BASENAME glob, not a path glob: translating
      // `**/*.ts` to `*.ts` keeps the intent, and the trailing `head` bounds it
      // either way. The `|| true` is deliberate — `find` exits non-zero on an
      // unreadable subdirectory, which must not fail the whole listing.
      // `--hidden` is REQUIRED, not cosmetic. `rg` skips hidden files and
      // directories by default while `grep -r` does not, so without this flag
      // the two branches of the SAME tool answer differently: on this
      // repository `rg --files -g '*.json'` returned 5 paths and
      // `rg --hidden --files -g '*.json'` returned 6, the extra being
      // `.devcontainer/devcontainer.json` — the one file that decides whether
      // the Codespace can be reached at all. A model told "*.json" must not
      // silently lose it.
      //
      // `.gitignore` IS still honoured (no `--no-ignore`): skipping
      // `node_modules` is the behaviour that makes `glob` useful rather than a
      // 200-line wall of vendored manifests. `grep -r` has no such notion, so
      // the two branches differ on ignored trees — that asymmetry is
      // deliberate and documented in the README, because "the search tool
      // respects .gitignore" is a defensible contract while "hidden config
      // directories are invisible" is not.
      const basenameGlob = shellQuote(pattern.replace(/^\*\*\//, '').replace(/^\.\//, ''))
      const command = `cd ${shellQuote(root)} && `
        + `(rg --hidden --files -g ${shellQuote(pattern)} 2>/dev/null || find . -type f -name ${basenameGlob} 2>/dev/null || true)`
        + ' | head -n 200'
      const result = await remoteExec(target, command, { timeoutMs: SEARCH_TIMEOUT_MS, run, signal: exec?.signal })
      if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
        throw new Error(`glob failed in "${root}": ${result.stderr.trim() || `exit ${result.exitCode}`}`)
      }
      const paths = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      return { root, paths }
    },
  }
}

/** The remote `grep` tool. */
function grepTool(target, cwd, run) {
  return {
    name: 'grep',
    description: 'Search file contents in the remote Codespace with a regular expression. Returns matching lines with line numbers.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the Codespace workspace root.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts").' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.matches.length === 0) return [{ type: 'text', text: '(no matches)' }]
        const byFile = new Map()
        for (const match of value.matches) {
          const list = byFile.get(match.path) ?? []
          list.push(match)
          byFile.set(match.path, list)
        }
        const blocks = [...byFile.entries()].map(([path, matches]) => {
          const head = `${path}:`
          const body = matches.map((match) => `  ${match.lineNumber}: ${match.line}`).join('\n')
          return `${head}\n${body}`
        })
        return [{ type: 'text', text: blocks.join('\n\n') }]
      },
    },
    async execute(args, exec) {
      const pattern = String(args.pattern ?? '')
      if (pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
      const root = args.path === undefined ? cwd : await absolutePath(target, cwd, args.path, { run })
      const include = typeof args.include === 'string' && args.include.length > 0 ? args.include : ''

      // Fall back to grep -rE when `rg` is absent, which it is on a stock
      // Codespace image. The old single command was
      // `rg … 2>/dev/null | head`, so a missing `rg` produced empty stdout and
      // exit 0 — the tool reported "(no matches)" for every search instead of
      // failing. Reporting a false negative is worse than reporting an error.
      //
      // Both searchers emit a NUL after the filename (`rg --null`, `grep -Z`),
      // which is the only unambiguous delimiter: a matching LINE routinely
      // contains colons (`ghcr.io/devcontainers/features/sshd:1`), so splitting
      // on the last two colons silently dropped exactly the matches whose text
      // looked most like a path. NUL cannot appear in a path or a text line.
      // `--hidden` matches the `glob` tool's rationale: `rg` skips hidden
      // directories by default, so without it a search silently loses
      // `.devcontainer/`, `.github/` and friends. `.gitignore` is still
      // honoured, which keeps `node_modules` out of the results.
      const rgArgs = `--hidden --null --line-number --no-heading --color never${include === '' ? '' : ` -g ${shellQuote(include)}`} -- ${shellQuote(pattern)} .`
      const grepArgs = `-rEnZ${include === '' ? '' : ` --include=${shellQuote(include)}`} -- ${shellQuote(pattern)} .`
      const command = `cd ${shellQuote(root)} && `
        + `if command -v rg >/dev/null 2>&1; then rg ${rgArgs}; `
        + `else grep ${grepArgs}; fi`
      const result = await remoteExec(target, command, { timeoutMs: SEARCH_TIMEOUT_MS, run, signal: exec?.signal })

      // Both searchers exit 1 for "no match"; anything above that is a real
      // failure and must be reported rather than rendered as an empty result.
      if (result.exitCode !== 0 && result.exitCode !== 1 && result.stdout.trim().length === 0) {
        throw new Error(`grep failed in "${root}": ${result.stderr.trim() || `exit ${result.exitCode}`}`)
      }

      // Records look like `<NUL-terminated path><line>:<text>\n`. The filename
      // needs no unescaping: `grep -r` prints the path as walked, and `rg`
      // prints it verbatim, so whatever was requested comes back verbatim.
      const matches = []
      for (const record of result.stdout.split('\n')) {
        if (record.length === 0) continue
        const nul = record.indexOf('\0')
        if (nul < 0) continue
        const rawPath = record.slice(0, nul)
        const rest = record.slice(nul + 1)
        const colon = rest.indexOf(':')
        if (colon <= 0) continue
        const lineNumber = Number(rest.slice(0, colon))
        if (!Number.isFinite(lineNumber)) continue
        matches.push({
          path: rawPath,
          lineNumber,
          line: rest.slice(colon + 1),
        })
      }
      return { matches }
    },
  }
}

/** Single-quote a value for a remote POSIX shell. Re-exported from `gh.js`'s `shq`. */
const shellQuote = shq

/**
 * Register the remote tool surface on one agent's scope.
 *
 * Everything is registered inside a single `agent.ctx.effect()`, so disposing
 * that effect removes the whole surface at once. The caller additionally keys
 * this disposer in its own plugin effect, because unloading the plugin does not
 * by itself dispose `agent.ctx` registrations.
 *
 * @param {object} agent - the live agent from `agent/created`.
 * @param {{manager: object, workspaceId: string, target: object, localToolNames?: string[], run?: Function}} options - wiring.
 * @returns {() => void} the disposer removing every registration.
 */
export function installRemoteTools(agent, options) {
  const { manager, workspaceId, target } = options
  const run = options.run
  const localToolNames = Array.isArray(options.localToolNames) ? options.localToolNames : []
  const agentCtx = agent?.ctx
  if (agentCtx === undefined) return () => {}

  const record = manager?.recordOf?.(workspaceId)
  const cwd = typeof target?.cwd === 'string' && target.cwd.length > 0
    ? target.cwd
    : (record?.path ?? '/')

  /*
   * The root a background job's state directory lives under.
   *
   * `cwd` above is the resolved checkout when the manager knows it, but its
   * fallback is the LOCAL placeholder path (or `/`) — never a place to write.
   * When the Codespace has not reported `connection.sessionPath` yet, ask it
   * once with `pwd` and remember the answer on `target.remoteCwd`, which is the
   * same memo the path tools already use.
   *
   * Skipping this is not cosmetic: measured on a real Codespace, a job launched
   * under the fallback root while `job_status` read the real root reported
   * `state: missing` for a job that was running perfectly well.
   */
  const jobRoot = async (exec) => {
    const declared = typeof target?.remoteCwd === 'string' ? target.remoteCwd : ''
    if (declared.startsWith('/')) return declared
    if (typeof target?.cwd === 'string' && target.cwd.startsWith('/') && !target.cwd.startsWith('C:')) {
      return target.cwd
    }
    try {
      const probe = await remoteExec(target, 'pwd', { timeoutMs: 15000, run, signal: exec?.signal })
      const root = probe.stdout.trim()
      if (probe.exitCode === 0 && root.startsWith('/')) {
        target.remoteCwd = root
        return root
      }
    } catch {
      /* a probe that fails falls through to the caller's fallback */
    }
    return cwd
  }

  /*
   * Wait for the agent's `tools` service through `inject` instead of reading it
   * off `agent.ctx` right now.
   *
   * `agent.ctx.tools` at `agent/created` time is `undefined`, and it fails
   * *quietly*: `ReflectService.handler.get` ends with
   * `if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)`, and the agent
   * scope has no running fiber, so the lookup degrades to the "no inject
   * required" read rather than throwing. The old code turned that into
   * `if (tools === undefined) return () => {}` — a SILENT no-op. The observable
   * result was the worst kind: the agent kept its local `read`/`glob`/`pwsh`,
   * never got the remote surface, and nothing was logged, so a Codespace session
   * happily scanned the empty placeholder directory on Windows while the system
   * prompt said it was in the cloud.
   *
   * `agent.ctx.inject([...], cb)` is the documented way to wait (DSH's own
   * `dsh-file-reference-local` does exactly this), and it returns a fiber whose
   * `dispose()` tears the registration down again.
   */
  let fiber = null
  try {
    fiber = agentCtx.inject(['tools'], (scope) => {
      // Read it off the injected scope, never off `agentCtx`: cordis resolves
      // services through the *fiber's* store, and only the scope created by
      // `inject` carries `tools`. (`agentCtx.tools` at this moment is not even an
      // error — `ReflectService.handler` short-circuits to
      // `ctx.reflect.get(prop, false)` when the fiber has no runtime, which is
      // exactly how the old version got `undefined` instead of a loud failure.)
      const tools = scope?.tools
      if (tools === undefined) {
        manager?.log?.('warn', `cannot install remote tools for ${workspaceId}: the agent scope has no tools service`)
        return
      }
      installInto(agentCtx, tools, {
        manager,
        workspaceId,
        target,
        cwd,
        localToolNames,
        run,
        jobRoot,
        getToken: options.getToken,
        getLogin: options.getLogin,
      })
    })
  } catch (error) {
    manager?.log?.('warn', `cannot install remote tools: ${redact(error instanceof Error ? error.message : String(error))}`)
    return () => {}
  }

  return () => {
    try {
      const disposal = fiber?.dispose?.()
      // `dispose()` is async; an unhandled rejection here would surface as a
      // crash during teardown, which is never worth it.
      if (disposal !== undefined && typeof disposal.catch === 'function') disposal.catch(() => {})
    } catch {
      /* idempotent teardown */
    }
  }
}

/**
 * Register the remote surface into an agent scope whose `tools` is ready.
 *
 * @param {object} agentCtx - the agent's context (owns the effect).
 * @param {object} tools - the resolved tools service.
 * @param {object} options - resolved wiring.
 * @returns {void}
 */
function installInto(agentCtx, tools, options) {
  const { manager, workspaceId, target, cwd, localToolNames, run, jobRoot } = options
  try {
    // The effect is owned by the agent context, so disposing that scope removes
    // the whole surface; no disposer needs to escape here.
    agentCtx.effect(() => {
      const disposers = []
      // What actually made it into the registry, so `codespace_doctor` can say
      // it instead of guessing. A missing entry here is the single most
      // misleading failure this surface has: the model keeps its LOCAL tools and
      // every path error still looks like "file not found".
      const installed = []
      const failed = []

      // The remote surface. A scoped registration shadows a same-named global
      // for this agent only, and is unaffected by the restrictions below.
      //
      // `codespace_doctor` comes first and is built with a live fact-reader: the
      // tool that diagnoses a broken surface has to survive one, and it must be
      // able to report "I am the only thing that installed".
      const surface = [
        doctorTool(target, {
          run,
          cwd,
          getToken: options.getToken,
          getLogin: options.getLogin,
          getFacts: () => ({
            installed: installed.slice(),
            failed: failed.slice(),
            workspaceId,
            remoteRoot: cwd,
          }),
        }),
        readTool(target, cwd, run),
        writeTool(target, cwd, run),
        editTool(target, cwd, run),
        globTool(target, cwd, run),
        grepTool(target, cwd, run),
        bashTool(target, cwd, run, jobRoot),
        jobStatusTool(target, cwd, run, jobRoot),
        jobCancelTool(target, cwd, run, jobRoot),
      ]
      for (const definition of surface) {
        try {
          disposers.push(tools.register(registryDefinition(definition)))
          installed.push(definition.name)
        } catch (error) {
          failed.push(definition.name)
          manager?.log?.('warn', `cannot register remote tool ${definition.name}: ${redact(error instanceof Error ? error.message : String(error))}`)
        }
      }

      if (failed.length > 0) {
        manager?.log?.(
          failed.length === surface.length ? 'error' : 'warn',
          `remote tool surface for ${workspaceId} is incomplete: ${installed.length} installed, `
          + `${failed.length} failed (${failed.join(', ')})`,
        )
      }

      // Hide the local counterparts this agent must not reach. Only names that
      // actually exist globally are denied: `restrict()` throws on an unknown
      // name, and the local tool set differs between the Windows and POSIX
      // compositions.
      const deny = []
      for (const name of localToolNames) {
        try {
          if (tools.get(name, undefined) !== undefined) deny.push(name)
        } catch {
          /* an unreadable global view just skips the name */
        }
      }
      if (deny.length > 0) {
        try {
          disposers.push(tools.restrict({ deny }))
        } catch (error) {
          manager?.log?.('warn', `cannot restrict local tools ${deny.join(', ')}: ${redact(error instanceof Error ? error.message : String(error))}`)
        }
      }

      return () => {
        for (const disposer of disposers) {
          try {
            disposer()
          } catch {
            /* idempotent teardown */
          }
        }
      }
    }, `dsh-codespace-workspace: remote tools for ${workspaceId}`)
  } catch (error) {
    manager?.log?.('warn', `cannot install remote tools: ${redact(error instanceof Error ? error.message : String(error))}`)
  }
}
