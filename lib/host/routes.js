/**
 * The host RPC route for dsh-codespace-workspace.
 *
 * One path, `POST /api/dsh-codespace-workspace/rpc`, registered on **both**
 * carriers the harness offers: `webServer.register` for the browser and
 * `connection.fetch.register` for the Desktop shell. The client posts the same
 * body to the same path either way.
 *
 * Every action returns HTTP 200 with `{ ok: true, ...data }` or
 * `{ ok: false, error: { code, message } }`. Nothing throws across the wire and
 * nothing takes longer than a bounded request: a failing GitHub call is a
 * value, not an exception, and the UI never waits on a hung socket.
 *
 * @module dsh-codespace-workspace/host/routes
 */

import { ACTIONS, RPC_ROUTE, SETTINGS_DEFAULTS, redact, wireError } from '../shared.js'

/** Request bodies are tiny; anything larger is not ours. */
const MAX_BODY_BYTES = 64 * 1024

/** Settings fields the client may write, and how to coerce each one. */
const SETTINGS_FIELDS = {
  githubUsername: (value) => (typeof value === 'string' ? value.trim() : ''),
  githubToken: (value) => (typeof value === 'string' ? value.trim() : ''),
  defaultBranch: (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : SETTINGS_DEFAULTS.defaultBranch),
  autoPauseMinutes: (value) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return SETTINGS_DEFAULTS.autoPauseMinutes
    return Math.max(1, Math.min(1440, Math.round(n)))
  },
  sshKeyPath: (value) => (typeof value === 'string' ? value.trim() : ''),
  alwaysShowCloudButton: (value) => value === true,
  autoInitEmptyRepo: (value) => value !== false,
  readmeContent: (value) => (typeof value === 'string' ? value : ''),
}

/** Fields that must never reach the browser. */
const SECRET_FIELDS = ['githubToken', 'sshKeyPath']

/** Whether an address is the loopback interface. */
function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Whether a request is a same-origin browser mutation.
 *
 * Mirrors the check `dsh-keep-awake` uses: a matching `Origin` with a loopback
 * host, or a loopback host with `Sec-Fetch-Site: same-origin`.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the request is same-origin.
 */
function isSameOriginMutation(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host && loopbackHost
    } catch {
      return false
    }
  }
  return loopbackHost && req.headers['sec-fetch-site'] === 'same-origin'
}

/** Write a JSON response. */
function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

/** Read and parse a bounded JSON request body. */
async function readJsonBody(req) {
  req.setEncoding('utf8')
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('request body exceeds 64 KiB')
  }
  if (text.length === 0) return {}
  const value = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object')
  }
  return value
}

/**
 * Reduce a raw settings object to the client-safe view.
 *
 * The token and the SSH key never cross the wire: each is replaced by a
 * boolean `set` marker, which is what a write-only input needs to render.
 *
 * @param {object} raw - the live settings.
 * @returns {{settings: object, secrets: object}} the safe settings and the markers.
 */
function publicSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const settings = {}
  const secrets = {}
  for (const [key, fallback] of Object.entries(SETTINGS_DEFAULTS)) {
    settings[key] = source[key] === undefined ? fallback : source[key]
  }
  for (const key of SECRET_FIELDS) {
    const value = source[key]
    secrets[key] = { set: typeof value === 'string' && value.length > 0 }
    delete settings[key]
  }
  return { settings, secrets }
}

/**
 * Validate and coerce a settings patch.
 *
 * Unknown keys are dropped rather than forwarded: the settings service rejects
 * a write outside the volatile paths, and a client typo should not turn into a
 * failed RPC.
 *
 * @param {unknown} patch - the client-supplied patch.
 * @returns {object} the coerced patch.
 */
function cleanPatch(patch) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const out = {}
  for (const [key, coerce] of Object.entries(SETTINGS_FIELDS)) {
    if (!Object.hasOwn(source, key)) continue
    out[key] = coerce(source[key])
  }
  return out
}

/**
 * Build the RPC handler.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} manager - the {@link import('./codespaces.js').CodespaceManager}.
 * @param {{getSettings?: () => object, setSettings?: (patch: object) => Promise<object>, logger?: object}} [options] - wiring.
 * @returns {(input: object) => Promise<object>} the dispatcher.
 */
export function createRpcHandler(ctx, manager, options = {}) {
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({})
  const setSettings = typeof options.setSettings === 'function' ? options.setSettings : null

  const log = (level, message) => {
    try {
      const logger = options.logger ?? ctx?.logger
      const fn = logger?.[level] ?? logger?.info
      if (typeof fn === 'function') fn.call(logger, redact(`codespace rpc: ${message}`))
    } catch {
      /* a logger is a nicety, never a dependency */
    }
  }

  /** Resolve the current settings plus the revision the client must echo back. */
  const settingsView = async () => {
    let revision
    try {
      // The revision guards a concurrent edit: it is the settings service's
      // own optimistic-concurrency token, read from its redacted descriptor.
      const descriptors = await ctx?.settings?.describe?.({ redactSecrets: true })
      const ours = Array.isArray(descriptors)
        ? descriptors.find((row) => row?.ns === 'dsh-codespace-workspace')
        : undefined
      revision = ours?.revision
    } catch {
      // An unavailable settings service is not an error here: the live config
      // is still the source of truth for reads, and a write will report its own
      // failure.
      revision = undefined
    }
    const { settings, secrets } = publicSettings(getSettings())
    return { settings, secrets, revision }
  }

  const handlers = {
    async [ACTIONS.STATUS]() {
      // `secrets` is additive to CONTRACT §6's `{gh, tokenSource, configured}`:
      // the client reads `status.secrets` for the write-only SSH-key indicator
      // and does not retain the `secrets` from `get-settings`. Same markers,
      // same guarantee — booleans only, never a value.
      const { secrets } = publicSettings(getSettings())
      return { ...(await manager.status()), secrets }
    },

    async [ACTIONS.GET_SETTINGS]() {
      return await settingsView()
    },

    async [ACTIONS.SET_SETTINGS](payload) {
      if (setSettings === null) {
        const error = new Error('the settings service is unavailable in this profile, so settings cannot be saved')
        error.code = 'E_NO_SETTINGS'
        throw error
      }
      const patch = cleanPatch(payload?.patch)
      await setSettings(patch)
      return await settingsView()
    },

    async [ACTIONS.LIST_REPOS]() {
      return { repos: await manager.listRepos() }
    },

    async [ACTIONS.LIST_CODESPACES](payload) {
      return { codespaces: await manager.listCodespaces(payload?.repo) }
    },

    async [ACTIONS.MACHINES](payload) {
      return { machines: await manager.machines(requireString(payload, 'repo')) }
    },

    async [ACTIONS.PREBUILD](payload) {
      return { hasPrebuild: await manager.prebuild(requireString(payload, 'repo')) }
    },

    async [ACTIONS.CREATE](payload) {
      const codespace = await manager.create({
        repo: requireString(payload, 'repo'),
        branch: typeof payload?.branch === 'string' ? payload.branch : undefined,
        machine: typeof payload?.machine === 'string' ? payload.machine : undefined,
        displayName: typeof payload?.displayName === 'string' ? payload.displayName : undefined,
      })
      return { codespace }
    },

    async [ACTIONS.START](payload) {
      return { codespace: await manager.start(requireString(payload, 'name')) }
    },

    async [ACTIONS.STOP](payload) {
      return { codespace: await manager.stop(requireString(payload, 'name')) }
    },

    async [ACTIONS.REMOVE](payload) {
      await manager.remove(requireString(payload, 'name'))
      return {}
    },

    async [ACTIONS.PAUSE_CANCEL](payload) {
      const workspaceId = manager.recordByName(requireString(payload, 'name'))?.workspaceId
      if (workspaceId !== undefined) manager.cancelAutoPause(workspaceId)
      return { autoPause: null }
    },

    async [ACTIONS.PAUSE_NOW](payload) {
      const workspaceId = manager.recordByName(requireString(payload, 'name'))?.workspaceId
      if (workspaceId !== undefined) await manager.pauseNow(workspaceId)
      return {}
    },

    async [ACTIONS.WORKSPACES]() {
      return { workspaces: await manager.listWorkspaces() }
    },

    async [ACTIONS.CREATE_WORKSPACE](payload) {
      const codespace = payload?.codespace
      if (codespace === undefined || codespace === null) {
        const error = new Error('create-workspace requires a codespace')
        error.code = 'E_INVALID'
        throw error
      }
      return { workspace: await manager.createWorkspace({ codespace, title: payload?.title }) }
    },

    async [ACTIONS.REMOVE_WORKSPACE](payload) {
      await manager.removeWorkspace({
        workspaceId: requireString(payload, 'workspaceId'),
        deleteCodespace: payload?.deleteCodespace === true,
      })
      return {}
    },
  }

  return async function dispatch(input) {
    const action = typeof input?.action === 'string' ? input.action : ''
    const handler = handlers[action]
    if (handler === undefined) {
      const error = new Error(`unknown action ${JSON.stringify(action)}`)
      error.code = 'E_UNKNOWN_ACTION'
      throw error
    }
    const data = await handler(input)
    return { ok: true, ...data }
  }
}

/** Read a required string payload field. */
function requireString(payload, key) {
  const value = payload?.[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    const error = new Error(`"${key}" is required`)
    error.code = 'E_INVALID'
    throw error
  }
  return value.trim()
}

/**
 * Register the RPC route on both carriers.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} manager - the manager.
 * @param {{getSettings?: () => object, setSettings?: (patch: object) => Promise<object>}} [options] - wiring.
 * @returns {() => void} a disposer removing every route. Idempotent.
 */
export function installRoutes(ctx, manager, options = {}) {
  const dispatch = createRpcHandler(ctx, manager, options)
  const disposers = []
  // Set by the returned disposer. The injection callback below can run *after*
  // teardown (the injected service may appear late), so it must be able to see
  // that the plugin is already gone and register nothing.
  let torn = false

  /** Turn a dispatcher call into a wire response, never throwing. */
  const respond = async (input) => {
    try {
      return await dispatch(input)
    } catch (error) {
      const failure = wireError(error)
      try {
        const logger = options.logger ?? ctx?.logger
        logger?.warn?.(`codespace rpc ${String(input?.action)} failed: ${failure.code} ${failure.message}`)
      } catch {
        /* logging is optional */
      }
      return { ok: false, error: failure }
    }
  }

  ctx.inject(['webServer'], (ready) => {
    if (torn) return

    /** Register one route, tolerating a missing carrier or a late teardown. */
    const register = (label, install) => {
      try {
        const dispose = install()
        // Teardown may have run between the `torn` check and here.
        if (torn) {
          try {
            dispose?.()
          } catch {
            /* idempotent teardown */
          }
          return
        }
        disposers.push(dispose)
      } catch (error) {
        ctx.logger?.warn?.(`codespace: cannot register ${label}: ${redact(error instanceof Error ? error.message : String(error))}`)
      }
    }

    // Browser carrier.
    register(RPC_ROUTE, () => ready.effect(() => ready.webServer.register({
      kind: 'exact',
      path: RPC_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          sendJson(res, 405, { ok: false, error: { code: 'E_METHOD', message: 'Method not allowed.' } })
          return
        }
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
          sendJson(res, 403, { ok: false, error: { code: 'E_FORBIDDEN', message: 'This endpoint is available only over a loopback connection.' } })
          return
        }
        if (!isSameOriginMutation(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'E_FORBIDDEN', message: 'Requests must be same-origin.' } })
          return
        }
        const contentType = req.headers['content-type']
        if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { ok: false, error: { code: 'E_CONTENT_TYPE', message: 'Requests must be application/json.' } })
          return
        }
        let input
        try {
          input = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'E_BAD_REQUEST', message: error instanceof Error ? redact(error.message) : 'invalid request body' },
          })
          return
        }
        // Always 200: the client reads `ok` from the body, so an action
        // failure is data, not a transport error.
        sendJson(res, 200, await respond(input))
      },
    }), 'dsh-codespace-workspace: rpc route'))

    // Desktop shell carrier: the same path and body over the connection's
    // internal fetch, which is how the Electron shell reaches the host.
    // `connection` is optional in some compositions; the browser carrier above
    // is enough for the Web GUI.
    register('the desktop rpc route', () => ready.effect(() => ready.connection.fetch.register({
      path: RPC_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let input
        try {
          input = await request.json()
        } catch {
          return Response.json(
            { ok: false, error: { code: 'E_BAD_REQUEST', message: 'invalid JSON request body' } },
            { status: 200, headers: { 'cache-control': 'no-store' } },
          )
        }
        return Response.json(await respond(input), { headers: { 'cache-control': 'no-store' } })
      },
    }), 'dsh-codespace-workspace: desktop rpc route'))
  })

  return () => {
    if (torn) return
    torn = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* idempotent teardown */
      }
    }
    disposers.length = 0
  }
}
