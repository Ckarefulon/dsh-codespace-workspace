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
 * Whether a normalized URL hostname names the local loopback authority.
 *
 * Matches `isLoopbackHostname` in `@deepseek-ai/dsh-client-connection`: the
 * literal `localhost`, the bracketed IPv6 loopback, or ANY IPv4 address in
 * 127/8 — not just `127.0.0.1`. A narrower check here would 403 a deployment
 * reached over another 127/8 address.
 *
 * @param {string} hostname - a WHATWG URL hostname (IPv6 keeps its brackets).
 * @returns {boolean} true for a loopback hostname.
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a request may reach this RPC route.
 *
 * This is a faithful port of `isTrustedApiRequest` from
 * `@deepseek-ai/dsh-client-connection/lib/index.js`, which is the harness's own
 * browser-trust fence for `/api` traffic. Do NOT make this stricter than that
 * fence: the desktop shell carrier reaches the host through the connection's
 * internal fetch, which attaches neither `Origin` nor Fetch-Metadata, and an
 * earlier revision of this function required one of the two. That rejected
 * every call from the desktop app with "Requests must be same-origin" while the
 * Web GUI worked, because the browser does send `Origin`.
 *
 * The load-bearing check is the HOST, not the Origin. The reasoning, from the
 * harness's own source: over plain HTTP a browser attaches neither `Origin` nor
 * Fetch-Metadata to every request shape, so an unmarked request may still be a
 * rebound browser read — and `Host` is the one header that DNS rebinding cannot
 * forge. `Origin` (when present) and `Sec-Fetch-Site` are supplementary.
 *
 * The loopback peer-address check is kept as well; it is a defense the harness
 * fence leaves to the webserver's bind policy.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the request is trusted.
 */
function isTrustedApiRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    // Compared through WHATWG normalization on both sides, so case and a
    // redundant default port never decide trust.
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
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

    /**
     * Register one route, tolerating a missing carrier or a late teardown.
     *
     * @returns a disposer that also removes itself from `disposers`, so an
     * upgraded-away carrier is not disposed twice, or `null` on failure.
     */
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
          return null
        }
        const entry = () => {
          try {
            dispose?.()
          } catch {
            /* idempotent teardown */
          }
        }
        disposers.push(entry)
        return entry
      } catch (error) {
        ctx.logger?.warn?.(`codespace: cannot register ${label}: ${redact(error instanceof Error ? error.message : String(error))}`)
        return null
      }
    }

    /** Drop a route registered above, e.g. when a stronger carrier arrives. */
    const unregister = (entry) => {
      if (entry === null || entry === undefined) return
      const at = disposers.indexOf(entry)
      if (at !== -1) disposers.splice(at, 1)
      entry()
    }

    /**
     * The RPC body, as a Connection Fetch route.
     *
     * Registering on `connection.fetch` is the PREFERRED carrier, because DSH's
     * own `/api` prefix route serves this registry and admits the request
     * first: `createSharedFetchHandler` is invoked from the `/api` route's
     * handler, which calls `connection.admit(req)` — the harness Host/Origin
     * fence AND the browser-auth cookie check — before `bridge()` ever
     * dispatches to a registered Fetch route. Registering here therefore
     * inherits the harness's security policy instead of re-implementing it, and
     * serves the browser and the Desktop shell alike.
     *
     * Do NOT go back to registering only a `webServer` exact route: the web
     * server resolves an exact route BEFORE the `/api` prefix route
     * (`dsh-host-webserver` `match()` tries the exact table first), so an exact
     * route on this same path SHADOWS the `/api` route and silently drops both
     * the fence and the authentication the harness would have applied.
     */
    const fetchRoute = {
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
        // Always 200: the client reads `ok` from the body, so an action
        // failure is data, not a transport error.
        return Response.json(await respond(input), { headers: { 'cache-control': 'no-store' } })
      },
    }

    // `connection` is NOT in this module's `inject`, so a plain property read
    // (`ready.connection`) is gated by cordis and throws "cannot get property
    // ... without inject" once the plugin's own inject list is enforced.
    // `ctx.get(name, false)` is the public ungated accessor -- documented in
    // cordis as "Read a service from the store without the inject requirement"
    // -- and returns undefined when nothing provides it. It is the same
    // `readService(name, false)` path the client runner uses for optional
    // services.
    //
    // Load order is not guaranteed, so this cannot be a one-shot decision: if
    // `connection` is not up yet we must not silently settle for the weaker
    // fallback for the rest of the process. `ready.inject(['connection'], ...)`
    // is the public trigger for that -- verified against cordis: it fires when
    // the service is provided later, and stays silent (without throwing) when it
    // never appears. The nested injection below is deliberately one level deep,
    // so it can also run immediately if `connection` is already up.
    let fetchEntry = null
    let fallbackEntry = null

    const upgrade = () => {
      if (torn || fetchEntry !== null) return
      const connection = ready.get('connection', false)
      if (!connection?.fetch?.register) return
      const entry = register('the rpc route', () => ready.effect(
        () => connection.fetch.register(fetchRoute),
        'dsh-codespace-workspace: rpc fetch route',
      ))
      if (entry === null) return
      fetchEntry = entry
      // Only drop the fallback once the preferred carrier is really in place:
      // dropping it first would leave a window with no route at all.
      unregister(fallbackEntry)
      fallbackEntry = null
    }

    // Install the preferred carrier now if it is available, and again if it
    // shows up later.
    upgrade()
    ready.inject(['connection'], () => upgrade())

    if (fetchEntry !== null) return

    // Fallback for a composition with no connection service. An exact route is
    // matched before DSH's `/api` prefix route, so this one shadows the harness
    // fence and auth and must therefore apply the fence itself. `upgrade()` will
    // replace it if `connection` appears later.
    fallbackEntry = register('the rpc route', () => ready.effect(() => ready.webServer.register({
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
        if (!isTrustedApiRequest(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'E_FORBIDDEN', message: 'Requests must come from a loopback, same-origin page.' } })
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
        sendJson(res, 200, await respond(input))
      },
    }), 'dsh-codespace-workspace: rpc route (fallback)'))
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
