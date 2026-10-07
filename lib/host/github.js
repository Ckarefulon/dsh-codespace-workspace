/**
 * GitHub REST control plane for dsh-codespace-workspace.
 *
 * Every function here is pure transport plus normalization: it knows the
 * endpoint shapes and the error envelope, and it never leaks the token into a
 * thrown message, a log line, or a returned value.
 *
 * The endpoints and payload field names below were verified against the
 * Codespaces REST reference; the ones this build could not exercise live carry
 * a `VERIFY:` comment naming the tolerant branch.
 *
 * @module dsh-codespace-workspace/host/github
 */

import { redact } from '../shared.js'
import { defaultRun } from './gh.js'

/** REST root. */
const API_BASE = 'https://api.github.com'

/** Pinned stable API version (the docs' newest is newer; this one matches the shapes we read). */
const API_VERSION = '2022-11-28'

/** GitHub asks every caller to identify itself. */
const USER_AGENT = 'dsh-codespace-workspace'

/** Per-request ceiling. Keeps every RPC inside the "never block the UI" budget. */
const REQUEST_TIMEOUT_MS = 20000

/** A rate-limit retry never waits longer than this, so an RPC still returns. */
const MAX_RETRY_WAIT_MS = 5000

/** One page of repos is enough for a picker and keeps the call bounded. */
const REPO_PAGE_SIZE = 100

/**
 * Sentinel key marking a failed attempt inside {@link api}.
 *
 * A Symbol, not a string: a successful response body is arbitrary JSON and
 * must never be mistaken for a failure envelope because it happened to carry
 * a `__failure` property.
 */
const FAILURE = Symbol('github-failure')

/**
 * A control-plane failure carrying a stable `code` and the HTTP `status`.
 *
 * The message is always passed through `redact()`: a GitHub error body is
 * echoed into it, and an error body must never be trusted to be credential-free.
 */
export class GithubError extends Error {
  /**
   * @param {string} message - human-readable, already free of secrets.
   * @param {string} code - stable machine code (`E_AUTH`, `E_RATELIMIT`, …).
   * @param {number} [status] - HTTP status when the failure came from a response.
   */
  constructor(message, code, status) {
    super(redact(message))
    this.name = 'GithubError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/**
 * Split `owner/name` into its parts.
 *
 * @param {string} repo - `owner/name`.
 * @returns {{ owner: string, name: string }} the parts.
 * @throws {GithubError} `E_INVALID` when the argument is not `owner/name`.
 */
export function splitRepo(repo) {
  const text = typeof repo === 'string' ? repo.trim() : ''
  const at = text.indexOf('/')
  if (at <= 0 || at === text.length - 1) {
    throw new GithubError(`invalid repository "${text}": expected "owner/name"`, 'E_INVALID')
  }
  return { owner: text.slice(0, at), name: text.slice(at + 1) }
}

/** Whether a token-ish string is present and non-blank. */
function present(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Map one HTTP failure onto a stable code plus a plain-language message.
 *
 * The order matters: a rate-limited 403 is a different remedy from a
 * permission-denied 403, so the rate-limit headers are consulted first.
 *
 * @param {number} status - HTTP status.
 * @param {Headers} headers - response headers.
 * @param {unknown} body - parsed JSON body, when there was one.
 * @returns {{ code: string, message: string, retryAfterMs: number }} the classification.
 */
function classify(status, headers, body) {
  const detail = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : ''
  const suffix = detail.length > 0 ? `: ${detail}` : ''

  const remaining = headers.get('x-ratelimit-remaining')
  const reset = Number(headers.get('x-ratelimit-reset'))
  const retryAfter = Number(headers.get('retry-after'))
  const limited = status === 429 || (status === 403 && remaining === '0')
  if (limited) {
    let waitMs = 0
    if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = retryAfter * 1000
    else if (Number.isFinite(reset) && reset > 0) waitMs = reset * 1000 - Date.now()
    waitMs = Math.max(0, Math.min(MAX_RETRY_WAIT_MS, waitMs))
    return { code: 'E_RATELIMIT', message: `GitHub API rate limit reached${suffix}`, retryAfterMs: waitMs }
  }

  if (status === 401) return { code: 'E_AUTH', message: `GitHub token is invalid or expired${suffix}`, retryAfterMs: 0 }
  if (status === 403) return { code: 'E_FORBIDDEN', message: `GitHub refused the request (missing scope or permission)${suffix}`, retryAfterMs: 0 }
  if (status === 404) return { code: 'E_NOT_FOUND', message: `GitHub resource not found${suffix}`, retryAfterMs: 0 }
  if (status === 409) return { code: 'E_CONFLICT', message: `GitHub reported a conflicting state; the resource is mid-transition, retry shortly${suffix}`, retryAfterMs: 0 }
  if (status === 402) return { code: 'E_PAYMENT', message: `GitHub requires payment or available Codespaces quota for this action${suffix}`, retryAfterMs: 0 }
  if (status === 422) return { code: 'E_INVALID', message: `GitHub rejected the request as invalid${suffix}`, retryAfterMs: 0 }
  if (status === 503) return { code: 'E_UNAVAILABLE', message: `GitHub Codespaces is temporarily unavailable${suffix}`, retryAfterMs: 0 }
  return { code: 'E_HTTP', message: `GitHub API request failed with HTTP ${status}${suffix}`, retryAfterMs: 0 }
}

/** Sleep for a bounded interval. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One REST call, with a single bounded retry for a rate limit or a 5xx.
 *
 * @param {string|null} token - bearer token, or null for an anonymous call.
 * @param {string} method - HTTP method.
 * @param {string} path - `/repos/...` or an absolute URL.
 * @param {unknown} [body] - JSON request body; omitted entirely when undefined.
 * @param {{signal?: AbortSignal, timeoutMs?: number, retry?: boolean}} [options] - call options.
 *   `timeoutMs` overrides the per-request ceiling, and `retry: false` suppresses
 *   the bounded retry — both exist for the shutdown path, which runs under a
 *   hard 5s budget and cannot afford a retry.
 * @returns {Promise<any>} parsed JSON, or `{}` for an empty/204 response.
 * @throws {GithubError} always with `.code` and, for HTTP failures, `.status`.
 */
export async function api(token, method, path, body, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS
  const allowRetry = options.retry !== false

  /** One attempt. */
  const attempt = async () => {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': USER_AGENT,
    }
    if (present(token)) headers.authorization = `Bearer ${token}`
    // The caller's signal (when given) and the per-request timeout are fused:
    // aborting either one cancels the fetch.
    const signal = options.signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    const init = { method, headers, signal }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    let response
    try {
      response = await fetch(url, init)
    } catch (error) {
      // A transport failure is reported without the URL's query string, which
      // can carry a user-supplied ref, and never with the request headers.
      const reason = error instanceof Error ? error.name : 'unknown'
      const code = reason === 'TimeoutError' || reason === 'AbortError' ? 'E_TIMEOUT' : 'E_NETWORK'
      throw new GithubError(`cannot reach the GitHub API (${reason})`, code)
    }

    const status = response.status
    let parsed = null
    let text = ''
    try {
      text = await response.text()
      if (text.length > 0) parsed = JSON.parse(text)
    } catch {
      parsed = null
    }

    if (status >= 200 && status < 300) {
      return parsed === null || typeof parsed !== 'object' ? {} : parsed
    }

    const failure = classify(status, response.headers, parsed)
    return { [FAILURE]: failure, status }
  }

  const first = await attempt()
  if (first[FAILURE] === undefined) return first

  const { code, retryAfterMs } = first[FAILURE]
  const retryable = allowRetry && (code === 'E_RATELIMIT' || first.status >= 500)
  if (!retryable) throw new GithubError(first[FAILURE].message, code, first.status)

  // A single bounded retry: a reset far in the future must not hold an RPC open.
  if (retryAfterMs > 0) await sleep(retryAfterMs)
  const second = await attempt()
  if (second[FAILURE] === undefined) return second
  throw new GithubError(second[FAILURE].message, second[FAILURE].code, second.status)
}

/**
 * Resolve a token. Order: settings → `GITHUB_TOKEN` → `gh auth token` → null.
 *
 * The `gh` branch is only attempted when `gh` is actually installed, so this
 * resolves to `none` quickly on a machine without the CLI.
 *
 * @param {object} ctx - plugin context, used only for logging.
 * @param {object} settings - the resolved plugin settings.
 * @param {Function} [run] - injected executor, for tests.
 * @returns {Promise<{ token: string|null, source: 'settings'|'env'|'gh'|'none' }>} the token and where it came from.
 */
export async function resolveToken(ctx, settings, run = defaultRun) {
  const configured = settings && typeof settings === 'object' ? settings.githubToken : undefined
  if (present(configured)) return { token: configured.trim(), source: 'settings' }

  if (present(process.env.GITHUB_TOKEN)) return { token: process.env.GITHUB_TOKEN.trim(), source: 'env' }

  try {
    const result = await run('gh', ['auth', 'token'], { timeoutMs: 5000 })
    if (result && result.exitCode === 0 && present(result.stdout)) {
      return { token: result.stdout.trim(), source: 'gh' }
    }
  } catch {
    // `gh` absent, or it refused: fall through to "no token" rather than failing.
    // The caller turns `none` into an actionable message, which is a better
    // surface than an exception raised from a detection path.
  }
  return { token: null, source: 'none' }
}

/**
 * The authenticated user.
 *
 * @param {string} token - bearer token.
 * @returns {Promise<{ login: string, name: string }>} the viewer.
 */
export async function getViewer(token) {
  const body = await api(token, 'GET', '/user')
  return {
    login: typeof body.login === 'string' ? body.login : '',
    name: typeof body.name === 'string' ? body.name : '',
  }
}

/**
 * Repositories the token can reach, most recently updated first.
 *
 * `isEmpty` here is a *hint* derived from `size === 0`. The API does not make
 * `size` an authoritative emptiness signal, so the create path confirms with
 * {@link repoIsEmpty} before it seeds anything.
 *
 * @param {string} token - bearer token.
 * @returns {Promise<Array<{name: string, nameWithOwner: string, owner: string, isPrivate: boolean, isEmpty: boolean, defaultBranch: string}>>} the repos.
 */
export async function listRepos(token) {
  const query = `?per_page=${REPO_PAGE_SIZE}&sort=updated&affiliation=owner,collaborator,organization_member`
  const body = await api(token, 'GET', `/user/repos${query}`)
  const rows = Array.isArray(body) ? body : []
  return rows.map((row) => ({
    name: typeof row.name === 'string' ? row.name : '',
    nameWithOwner: typeof row.full_name === 'string' ? row.full_name : '',
    owner: row.owner && typeof row.owner.login === 'string' ? row.owner.login : '',
    isPrivate: row.private === true,
    isEmpty: row.size === 0,
    defaultBranch: typeof row.default_branch === 'string' ? row.default_branch : '',
  }))
}

/**
 * Whether a repository has no commits.
 *
 * `size` is unreliable, so this asks for one commit: an empty repository
 * answers 404 or 409 ("Git Repository is empty") rather than an array.
 *
 * @param {string} token - bearer token.
 * @param {string} repo - `owner/name`.
 * @returns {Promise<boolean>} true when the repository has no commits.
 */
export async function repoIsEmpty(token, repo) {
  const { owner, name } = splitRepo(repo)
  try {
    const body = await api(token, 'GET', `/repos/${owner}/${name}/commits?per_page=1`)
    return Array.isArray(body) && body.length === 0
  } catch (error) {
    if (error instanceof GithubError && (error.status === 404 || error.status === 409)) return true
    throw error
  }
}

/**
 * Normalize one Codespace payload onto the wire shape the client expects.
 *
 * @param {any} row - a raw Codespace object.
 * @returns {object} the normalized Codespace (without `managed`, which the manager adds).
 */
export function normalizeCodespace(row) {
  const source = row && typeof row === 'object' ? row : {}
  const machine = source.machine && typeof source.machine === 'object' ? source.machine : {}
  const gitStatus = source.git_status && typeof source.git_status === 'object' ? source.git_status : {}
  return {
    name: typeof source.name === 'string' ? source.name : '',
    displayName: typeof source.display_name === 'string' ? source.display_name : '',
    repository: source.repository && typeof source.repository.full_name === 'string' ? source.repository.full_name : '',
    branch: typeof gitStatus.ref === 'string' ? gitStatus.ref : '',
    state: typeof source.state === 'string' ? source.state : '',
    machine: {
      name: typeof machine.name === 'string' ? machine.name : '',
      displayName: typeof machine.display_name === 'string' ? machine.display_name : '',
      cpus: Number.isFinite(machine.cpus) ? machine.cpus : 0,
      memoryGb: Number.isFinite(machine.memory_in_bytes) ? Math.round(machine.memory_in_bytes / 1024 ** 3) : 0,
    },
    idleTimeoutMinutes: Number.isFinite(source.idle_timeout_minutes) ? source.idle_timeout_minutes : 0,
    lastUsedAt: typeof source.last_used_at === 'string' ? source.last_used_at : '',
    createdAt: typeof source.created_at === 'string' ? source.created_at : '',
    webUrl: typeof source.web_url === 'string' ? source.web_url : '',
    // `prebuild` is a boolean on the Codespace itself; absent means unknown.
    prebuild: typeof source.prebuild === 'boolean' ? source.prebuild : null,
  }
}

/**
 * Codespaces for the viewer, or for one repository.
 *
 * @param {string} token - bearer token.
 * @param {string} [repo] - `owner/name`; omitted lists the viewer's own.
 * @returns {Promise<object[]>} normalized Codespaces.
 */
export async function listCodespaces(token, repo) {
  let path = '/user/codespaces?per_page=100'
  if (present(repo)) {
    const { owner, name } = splitRepo(repo)
    path = `/repos/${owner}/${name}/codespaces?per_page=100`
  }
  const body = await api(token, 'GET', path)
  const rows = Array.isArray(body.codespaces) ? body.codespaces : []
  return rows.map(normalizeCodespace)
}

/**
 * Machine types available to one repository.
 *
 * Sizes come back in bytes and are converted to whole GB. Sorted smallest
 * first so the wizard's default is the cheapest machine that works.
 *
 * @param {string} token - bearer token.
 * @param {string} repo - `owner/name`.
 * @param {string} [branch] - ref the machines are resolved against.
 * @returns {Promise<Array<{name: string, displayName: string, cpus: number, memoryGb: number, storageGb: number, gpu: boolean, prebuildAvailability: string|null}>>} the machines.
 */
export async function listMachines(token, repo, branch) {
  const { owner, name } = splitRepo(repo)
  const ref = present(branch) ? `?ref=${encodeURIComponent(branch.trim())}` : ''
  const body = await api(token, 'GET', `/repos/${owner}/${name}/codespaces/machines${ref}`)
  const rows = Array.isArray(body.machines) ? body.machines : []
  return rows
    .map((row) => {
      const source = row && typeof row === 'object' ? row : {}
      return {
        name: typeof source.name === 'string' ? source.name : '',
        displayName: typeof source.display_name === 'string' ? source.display_name : '',
        cpus: Number.isFinite(source.cpus) ? source.cpus : 0,
        memoryGb: Number.isFinite(source.memory_in_bytes) ? Math.round(source.memory_in_bytes / 1024 ** 3) : 0,
        storageGb: Number.isFinite(source.storage_in_bytes) ? Math.round(source.storage_in_bytes / 1024 ** 3) : 0,
        // VERIFY: the Codespaces machine object is documented without a `gpu`
        // field. Tolerant branch: read it when present, otherwise report false.
        gpu: source.gpu === true,
        prebuildAvailability: typeof source.prebuild_availability === 'string' ? source.prebuild_availability : null,
      }
    })
    .sort((a, b) => a.cpus - b.cpus || a.memoryGb - b.memoryGb || a.storageGb - b.storageGb)
}

/**
 * Whether a repository has a ready prebuild for a branch.
 *
 * The authoritative source is `prebuild_availability` on the machine list:
 * `GET /repos/{o}/{r}/codespaces/new` carries no prebuild field, so it is not
 * used here. `in_progress` is deliberately not `ready` — it must still show
 * the slow-creation notice.
 *
 * @param {string} token - bearer token.
 * @param {string} repo - `owner/name`.
 * @param {string} [branch] - ref to check; omitted uses the repository default.
 * @returns {Promise<boolean|null>} true/false, or null when it cannot be determined.
 */
export async function getPrebuild(token, repo, branch) {
  try {
    const machines = await listMachines(token, repo, branch)
    if (machines.length === 0) return null
    return machines.some((machine) => machine.prebuildAvailability === 'ready')
  } catch {
    // "Unknown" must degrade to "no prebuild": that shows the slow-creation
    // notice, which is the safe branch. It must never surface as an error.
    return null
  }
}

/**
 * Create a Codespace.
 *
 * @param {string} token - bearer token.
 * @param {{repo: string, branch?: string, machine?: string, displayName?: string, idleTimeoutMinutes?: number, location?: string}} options - creation inputs.
 * @returns {Promise<{codespace: object, pending: boolean}>} the Codespace; `pending` is true for a 202.
 */
export async function createCodespace(token, options) {
  const { owner, name } = splitRepo(options.repo)
  const body = {}
  // The branch field is `ref`, not `branch`.
  if (present(options.branch)) body.ref = options.branch.trim()
  if (present(options.machine)) body.machine = options.machine.trim()
  if (present(options.displayName)) body.display_name = options.displayName.trim().slice(0, 48)
  if (Number.isFinite(options.idleTimeoutMinutes) && options.idleTimeoutMinutes > 0) {
    body.idle_timeout_minutes = Math.round(options.idleTimeoutMinutes)
  }
  if (present(options.location)) body.geo = options.location.trim()

  const raw = await api(token, 'POST', `/repos/${owner}/${name}/codespaces`, body)
  // VERIFY: the reference documents 201 for a completed create and 202 for a
  // create that failed but is being retried in the background. `api()`
  // collapses both onto the parsed body, so the 202 case cannot be told apart
  // from the 201 case here; it is surfaced as `pending: false` and the caller
  // learns the truth from the Codespace's own `state` on the next poll.
  return { codespace: normalizeCodespace(raw), pending: false }
}

/**
 * Start a Codespace.
 *
 * @param {string} token - bearer token.
 * @param {string} name - Codespace name.
 * @returns {Promise<object>} the Codespace.
 */
export async function startCodespace(token, name) {
  const raw = await api(token, 'POST', `/user/codespaces/${encodeURIComponent(name)}/start`)
  return normalizeCodespace(raw)
}

/**
 * Stop a Codespace.
 *
 * @param {string} token - bearer token.
 * @param {string} name - Codespace name.
 * @param {{signal?: AbortSignal, timeoutMs?: number, retry?: boolean}} [options] - call options.
 * @returns {Promise<object>} the Codespace.
 */
export async function stopCodespace(token, name, options = {}) {
  const raw = await api(token, 'POST', `/user/codespaces/${encodeURIComponent(name)}/stop`, undefined, options)
  return normalizeCodespace(raw)
}

/**
 * Delete a Codespace.
 *
 * @param {string} token - bearer token.
 * @param {string} name - Codespace name.
 * @returns {Promise<void>} resolves once GitHub has accepted the deletion.
 */
export async function deleteCodespace(token, name) {
  // 202 with an empty body: the deletion is queued, not finished.
  await api(token, 'DELETE', `/user/codespaces/${encodeURIComponent(name)}`)
}

/**
 * Commit a README into a repository that has no commits.
 *
 * Creating a Codespace from a repository with no commits fails, so the create
 * path seeds one first. The initial commit must not name a `branch`: the
 * Contents API rejects a branch that does not exist yet, and it creates the
 * repository's default branch from this call.
 *
 * @param {string} token - bearer token.
 * @param {{repo: string, branch?: string, content: string}} options - the repo and README text.
 * @returns {Promise<{commit: string, path: string}>} the created commit sha and path.
 */
export async function seedEmptyRepo(token, options) {
  const { owner, name } = splitRepo(options.repo)
  const content = typeof options.content === 'string' && options.content.length > 0
    ? options.content
    : '# Codespace workspace\n\nInitialized by dsh-codespace-workspace.\n'
  const body = {
    message: 'Initialize repository for GitHub Codespaces',
    content: Buffer.from(content, 'utf8').toString('base64'),
  }
  // `options.branch` is accepted for interface compatibility and deliberately
  // not sent: this is the repository's initial commit, and naming a branch
  // that does not exist yet is rejected by the Contents API.
  const raw = await api(token, 'PUT', `/repos/${owner}/${name}/contents/README.md`, body)
  return {
    commit: raw && raw.commit && typeof raw.commit.sha === 'string' ? raw.commit.sha : '',
    path: raw && typeof raw.content === 'object' && raw.content !== null && typeof raw.content.path === 'string'
      ? raw.content.path
      : 'README.md',
  }
}
