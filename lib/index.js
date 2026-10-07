/**
 * dsh-codespace-workspace — host half.
 *
 * Makes a GitHub Codespace usable as a DSH workspace. The Codespace is
 * registered in DSH's own workspace registry as a real (empty) local
 * placeholder directory, so the harness's workspace and session machinery
 * works untouched; the file and shell tools the agent actually uses are
 * shadowed *per agent* with remote implementations once a session's cwd is
 * recognized as a placeholder.
 *
 * Nothing global is replaced: `ctx.fs` and `ctx.shell` are never swapped, so
 * local sessions and every other plugin are unaffected.
 *
 * @module dsh-codespace-workspace
 */

import z from '@deepseek-ai/schemastery'

import { PLUGIN_ID, SETTINGS_DEFAULTS, SETTINGS_NS, redact } from './shared.js'
import { CodespaceManager } from './host/codespaces.js'
import { installRoutes } from './host/routes.js'
import { installSessionWiring } from './host/session.js'

export const name = PLUGIN_ID

/**
 * Services this plugin waits for.
 *
 * Only the two that the per-agent surface genuinely cannot work without:
 * `tools` to register the shadow tools and `systemPrompt` to add the rule.
 * Everything else is optional and is reached through `ctx.get(...)` or
 * `ctx.inject([...])`, so a profile without a web server or without the
 * workspace registry still activates this plugin and still reports a clear
 * error from the action that needed the missing service.
 */
export const inject = ['tools', 'systemPrompt']

/** Guard for a schemastery build without `volatile()`. */
const vol = (schema) => (typeof schema?.volatile === 'function' ? schema.volatile() : schema)

/**
 * The plugin's configuration.
 *
 * The whole object is volatile, so every field is editable while DSH runs:
 * `applies: 'live'` is the settings service's default for a volatile form, and
 * the values are read lazily on each use rather than cached at activation.
 *
 * `githubToken` carries `role('secret')`: the settings service removes it from
 * every value it returns to a client and reports a `{ path, set }` marker
 * instead, so a write-only input can render without the secret ever crossing
 * the wire.
 */
export const Config = vol(z.object({
  githubUsername: z.string().default(SETTINGS_DEFAULTS.githubUsername),
  githubToken: z.string().role('secret').default(''),
  defaultBranch: z.string().default(SETTINGS_DEFAULTS.defaultBranch),
  autoPauseMinutes: z.number().default(SETTINGS_DEFAULTS.autoPauseMinutes),
  sshKeyPath: z.string().default(SETTINGS_DEFAULTS.sshKeyPath),
  alwaysShowCloudButton: z.boolean().default(SETTINGS_DEFAULTS.alwaysShowCloudButton),
  autoInitEmptyRepo: z.boolean().default(SETTINGS_DEFAULTS.autoInitEmptyRepo),
  readmeContent: z.string().default(SETTINGS_DEFAULTS.readmeContent),
}))

/**
 * Read the live configuration out of whatever shape schemastery produced.
 *
 * A volatile root is a frozen reference whose `get()` returns an immutable
 * snapshot; a plain root is the object itself. Both are handled, because the
 * guard exists precisely for a build that did not wrap the schema.
 *
 * @param {unknown} config - the plugin's `config` argument.
 * @returns {object} a plain settings object.
 */
function readConfig(config) {
  const raw = config !== null && typeof config === 'object' && typeof config.get === 'function'
    ? config.get()
    : config
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const settings = {}
  for (const [key, fallback] of Object.entries(SETTINGS_DEFAULTS)) {
    settings[key] = source[key] === undefined ? fallback : source[key]
  }
  // Not in `SETTINGS_DEFAULTS` because it is write-only and never echoed back.
  settings.githubToken = typeof source.githubToken === 'string' ? source.githubToken : ''
  return settings
}

/**
 * Activate the plugin.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} config - the parsed {@link Config}.
 */
export function apply(ctx, config) {
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      const fn = logger?.[level] ?? logger?.info
      if (typeof fn === 'function') fn.call(logger, redact(`codespace: ${message}`))
    } catch {
      /* a logger is a nicety, never a dependency */
    }
  }

  const getSettings = () => readConfig(config)

  const manager = new CodespaceManager(ctx, {
    getSettings,
    logger: ctx.logger,
  })

  // ------------------------------------------------------------- persistence

  /**
   * Persist a settings patch through the settings service.
   *
   * The namespace is this plugin's loader row id, which is what the settings
   * service keys its descriptors by. Only volatile paths are writable, and
   * every field is volatile, so no path check can fail here.
   *
   * @param {object} patch - the coerced patch.
   * @returns {Promise<void>} resolves once the write is committed.
   */
  const setSettings = async (patch) => {
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.update !== 'function') {
      const error = new Error('the settings service is unavailable in this profile, so settings cannot be saved')
      error.code = 'E_NO_SETTINGS'
      throw error
    }
    if (Object.keys(patch).length === 0) return
    await settings.update(SETTINGS_NS, patch)
  }

  // -------------------------------------------------------------- registrations

  const routesEffect = ctx.effect(
    () => installRoutes(ctx, manager, { getSettings, setSettings, logger: ctx.logger }),
    'dsh-codespace-workspace: rpc routes',
  )

  const sessionEffect = ctx.effect(
    () => installSessionWiring(ctx, manager, { getSettings }),
    'dsh-codespace-workspace: session wiring',
  )

  // The manager's own disposal and its shutdown stop-all live in the session
  // wiring's shutdown effect, which is the one hook the harness awaits. This
  // effect only guarantees the timers are cleared if the plugin unloads while
  // the process keeps running.
  const disposeEffect = ctx.effect(
    () => () => manager.dispose(),
    'dsh-codespace-workspace: manager disposal',
  )

  let torn = false
  ctx.effect(() => () => {
    if (torn) return
    torn = true
    for (const dispose of [routesEffect, sessionEffect, disposeEffect]) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* idempotent teardown */
      }
    }
  }, 'dsh-codespace-workspace: teardown')

  log('info', `ready; placeholder workspaces live under ${manager.root}`)
}
