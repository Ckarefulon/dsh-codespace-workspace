/**
 * Shared contract between the Host and Client halves of dsh-codespace-workspace.
 *
 * This module is imported by the Host bundle only. The Client bundle is a
 * self-contained lazy-CJS factory and must repeat these literals; keep the two
 * in sync — the values here are the wire contract.
 *
 * @module dsh-codespace-workspace/shared
 */

/** Package name; also the client module-loader id and the loader row id. */
export const PLUGIN_ID = 'dsh-codespace-workspace'

/** Exact host route the browser posts RPC calls to. */
export const RPC_ROUTE = '/api/dsh-codespace-workspace/rpc'

/**
 * Directory under the DSH home that holds placeholder workspace folders.
 * A Codespace workspace is registered in DSH's own workspace registry as a real
 * local directory; `dsh-workspace` requires an existing, fully-qualified path.
 * Relative to the harness home; the host resolves the absolute path.
 */
export const PLACEHOLDER_DIRNAME = 'codespaces'

/** System-prompt section registered once, at session creation. */
export const PROMPT_SECTION = 'codespace:workspace-rule'

/**
 * Prompt section order. After the deployment persona (0) and the plan/team
 * policies (500/600), before the tool guidance (900+), so the rule is read as
 * workspace context rather than as a tool instruction.
 */
export const PROMPT_ORDER = 1500

/** The single rule injected for a Codespace session. */
export const PROMPT_TEXT = [
  'This session runs in a cloud Codespace workspace: file and command tools',
  'operate inside a remote GitHub Codespace, not on the local machine.',
  'When you finish a change, `git push` it back to the repository — the plugin',
  'does not push for you and does not wrap Git in any way.',
].join(' ')

/** Every RPC action name. Frozen: the client repeats these strings. */
export const ACTIONS = Object.freeze({
  STATUS: 'status',
  GET_SETTINGS: 'get-settings',
  SET_SETTINGS: 'set-settings',
  LIST_REPOS: 'list-repos',
  LIST_CODESPACES: 'list-codespaces',
  MACHINES: 'machines',
  PREBUILD: 'prebuild',
  CREATE: 'create',
  START: 'start',
  STOP: 'stop',
  REMOVE: 'remove',
  PAUSE_CANCEL: 'pause-cancel',
  PAUSE_NOW: 'pause-now',
  WORKSPACES: 'workspaces',
  CREATE_WORKSPACE: 'create-workspace',
  REMOVE_WORKSPACE: 'remove-workspace',
})

/**
 * Codespace lifecycle state, normalized for the UI.
 *
 * The raw vocabulary is the `state` enum of the Codespaces REST API:
 * `Unknown`, `Created`, `Queued`, `Provisioning`, `Available`, `Awaiting`,
 * `Unavailable`, `Deleted`, `Moved`, `Shutdown`, `Archived`, `Starting`,
 * `ShuttingDown`, `Failed`, `Exporting`, `Updating`, `Rebuilding`.
 *
 * @typedef {'running'|'stopped'|'pending'|'error'} CodespacePhase
 */

/** States that mean the Codespace is usable. */
const RUNNING_STATES = new Set(['available'])

/** States that mean it is not running and can be started. */
const STOPPED_STATES = new Set(['shutdown', 'archived'])

/**
 * States that are transitional: show a spinner and disable the control.
 * `awaiting` is included because it is a transient hand-off state, not a
 * settled one — the API documents it as neither available nor stopped.
 */
const PENDING_STATES = new Set([
  'created',
  'queued',
  'provisioning',
  'starting',
  'awaiting',
  'shuttingdown',
  'exporting',
  'updating',
  'rebuilding',
])

/** States that are terminal failures. */
const ERROR_STATES = new Set(['failed', 'unavailable', 'deleted', 'moved', 'unknown'])

/**
 * Map a raw GitHub Codespaces state string onto a UI phase.
 *
 * Unknown and missing values are treated as `pending` rather than `error`: a
 * state this build has never seen is far more likely to be a new transitional
 * state than a broken Codespace, and `pending` disables the control instead of
 * offering a start that would be rejected.
 *
 * @param {unknown} state - raw `state` field from the GitHub API.
 * @returns {CodespacePhase} the normalized phase.
 */
export function codespacePhase(state) {
  if (typeof state !== 'string') return 'pending'
  // The enum is PascalCase (`ShuttingDown`); compare case-insensitively and
  // tolerate a snake_case or spaced spelling from any other producer.
  const key = state.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (RUNNING_STATES.has(key)) return 'running'
  if (STOPPED_STATES.has(key)) return 'stopped'
  if (PENDING_STATES.has(key)) return 'pending'
  if (ERROR_STATES.has(key)) return 'error'
  return 'pending'
}

/** Whether a phase may be started. */
export function canStart(phase) {
  return phase === 'stopped' || phase === 'error'
}

/** Whether a phase may be stopped. */
export function canStop(phase) {
  return phase === 'running'
}

/** Settings namespace = the loader row id. */
export const SETTINGS_NS = PLUGIN_ID

/** Default settings values; also mirrored by the Host `Config` schema. */
export const SETTINGS_DEFAULTS = Object.freeze({
  githubUsername: '',
  defaultBranch: 'main',
  autoPauseMinutes: 30,
  sshKeyPath: '',
  alwaysShowCloudButton: false,
  autoInitEmptyRepo: true,
  readmeContent: '',
})

/**
 * Reduce an unknown thrown value to a wire-safe `{ code, message }` pair.
 * Never leaks a stack, a token, or a request body.
 *
 * @param {unknown} error - the caught value.
 * @returns {{ code: string, message: string }} the wire error.
 */
export function wireError(error) {
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : 'E_UNKNOWN'
    const message = error instanceof Error ? error.message : String(error.message ?? error)
    return { code, message: redact(message) }
  }
  return { code: 'E_UNKNOWN', message: redact(String(error)) }
}

/** Patterns that must never reach the browser. */
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

/**
 * Strip anything credential-shaped out of a string.
 *
 * @param {string} text - candidate text.
 * @returns {string} the same text with credential-shaped runs replaced.
 */
export function redact(text) {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}
