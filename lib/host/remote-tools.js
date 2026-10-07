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
import { shq } from './gh.js'
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
function bashTool(target, cwd, run) {
  return {
    name: 'bash',
    description: [
      'Execute a bash command inside the remote GitHub Codespace and return its stdout/stderr.',
      'This runs on the Codespace, not on the local machine: paths are POSIX and the working',
      'directory is the Codespace checkout. Pass `workdir` instead of using `cd`.',
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderShellResult(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const command = String(args.command ?? '')
      if (command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
      const workdir = args.workdir === undefined ? cwd : await absolutePath(target, cwd, args.workdir, { run })
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
      // `-g` takes the pattern as a glob; `--files` lists rather than searches.
      // Both the pattern and the root are single-quoted by buildCommand.
      const command = `cd ${shellQuote(root)} && (rg --files -g ${shellQuote(pattern)} 2>/dev/null || find . -type f -name ${shellQuote(pattern.replace(/^\*\*\//, ''))} 2>/dev/null) | head -n 200`
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
      const include = typeof args.include === 'string' && args.include.length > 0
        ? ` -g ${shellQuote(args.include)}`
        : ''
      const command = `cd ${shellQuote(cwd)} && rg --line-number --no-heading --color never${include} -- ${shellQuote(pattern)} ${shellQuote(root)} 2>/dev/null | head -n 250`
      const result = await remoteExec(target, command, { timeoutMs: SEARCH_TIMEOUT_MS, run, signal: exec?.signal })
      const matches = []
      for (const raw of result.stdout.split('\n')) {
        if (raw.length === 0) continue
        // `rg` emits `path:line:lineNumber:text`; the path may itself contain colons,
        // so the two trailing numeric fields are located from the right.
        const second = raw.lastIndexOf(':')
        if (second < 0) continue
        const first = raw.lastIndexOf(':', second - 1)
        if (first < 0) continue
        const lineNumber = Number(raw.slice(first + 1, second))
        if (!Number.isFinite(lineNumber)) continue
        matches.push({
          path: raw.slice(0, first),
          lineNumber,
          line: raw.slice(second + 1),
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
  const tools = agentCtx?.tools
  if (tools === undefined) return () => {}

  const record = manager?.recordOf?.(workspaceId)
  const cwd = typeof target?.cwd === 'string' && target.cwd.length > 0
    ? target.cwd
    : (record?.path ?? '/')

  let dispose = () => {}
  try {
    dispose = agentCtx.effect(() => {
      const disposers = []

      // The remote surface. A scoped registration shadows a same-named global
      // for this agent only, and is unaffected by the restrictions below.
      for (const definition of [
        readTool(target, cwd, run),
        writeTool(target, cwd, run),
        editTool(target, cwd, run),
        globTool(target, cwd, run),
        grepTool(target, cwd, run),
        bashTool(target, cwd, run),
      ]) {
        try {
          disposers.push(tools.register(definition))
        } catch (error) {
          manager?.log?.('warn', `cannot register remote tool ${definition.name}: ${redact(error instanceof Error ? error.message : String(error))}`)
        }
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
    return () => {}
  }

  let done = false
  return () => {
    if (done) return
    done = true
    try {
      dispose()
    } catch {
      /* idempotent teardown */
    }
  }
}
