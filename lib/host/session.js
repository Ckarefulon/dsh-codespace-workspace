/**
 * Session lifecycle wiring for dsh-codespace-workspace.
 *
 * Wires four things, all as effects with idempotent cleanups:
 *
 * 1. `agent/created` → per-agent remote tool surface for Codespace sessions.
 * 2. The system-prompt rule, registered on the *agent's* scope so only a
 *    Codespace agent receives it.
 * 3. `session/event` → `turn/end` arms the auto-pause countdown and
 *    `user/message` cancels it.
 * 4. The shutdown stop-all, in the one place the harness guarantees to await.
 *
 * @module dsh-codespace-workspace/host/session
 */

import { PROMPT_ORDER, PROMPT_SECTION, PROMPT_TEXT, redact } from '../shared.js'
import { ghAvailable, ghInfo } from './gh.js'
import { installRemoteTools } from './remote-tools.js'

/**
 * Local tools hidden from a Codespace agent.
 *
 * They resolve services from their own host-plane context, so they would act
 * on the *local* machine; the remote surface shadows the ones that exist and
 * these are removed so a model cannot reach the local implementation by
 * accident. `pwsh` is denied outright because a Codespace is Linux.
 *
 * VERIFY: this list is the union of the tool names the shipped presets mount
 * (`dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-bash`, `dsh-tool-pwsh`).
 * Tolerant branch: each name is checked against the live global view before it
 * is denied, because `tools.restrict()` throws on a name that is registered
 * nowhere — so a composition that mounts a different subset is handled without
 * a special case.
 */
const LOCAL_TOOL_NAMES = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'read_image']

/**
 * Build the transport target for one managed workspace.
 *
 * Prefers `gh codespace ssh` when the CLI is usable, and otherwise falls back
 * to the ssh-config alias from the settings — which is the path that actually
 * runs on a machine without `gh`.
 *
 * @param {{gh: object}} status - a {@link ghInfo}-derived status.
 * @param {object} settings - resolved plugin settings.
 * @param {object} record - the managed workspace record.
 * @returns {{kind: 'gh'|'ssh', codespace?: string, alias?: string, cwd: string}} the target.
 */
export function buildTarget(status, settings, record) {
  const cwd = record?.path ?? '/'
  if (ghAvailable(status.gh)) return { kind: 'gh', codespace: record.name, cwd }
  // VERIFY: the settings field is named `sshKeyPath` in the frozen settings
  // schema while the data plane needs an ssh-config *alias*. It is read as the
  // alias, which is what the contract's "ssh-config alias the user configured
  // (settings field)" describes. Tolerant branch: an unusable value produces
  // the transport's own clear message ("no SSH host alias is configured …")
  // rather than a crash, and `gh` is preferred whenever it is available.
  const alias = typeof settings?.sshKeyPath === 'string' ? settings.sshKeyPath.trim() : ''
  return { kind: 'ssh', alias, cwd }
}

/**
 * Wire every session-level behaviour.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} manager - the {@link import('./codespaces.js').CodespaceManager}.
 * @param {{getSettings?: () => object, run?: Function}} [options] - wiring options.
 * @returns {() => void} a disposer that removes every registration. Idempotent.
 */
export function installSessionWiring(ctx, manager, options = {}) {
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({})
  const run = options.run

  /** @type {Map<string, () => void>} per-agent disposers, keyed by agent id. */
  const agentDisposers = new Map()
  let disposed = false

  const log = (level, message) => {
    try {
      const logger = ctx.logger
      const fn = logger?.[level] ?? logger?.info
      if (typeof fn === 'function') fn.call(logger, redact(`codespace: ${message}`))
    } catch {
      /* a logger is a nicety, never a dependency */
    }
  }

  // ------------------------------------------------------- prompt + per-agent

  const promptEffect = ctx.effect(() => () => {
    for (const disposer of agentDisposers.values()) {
      try {
        disposer()
      } catch {
        /* idempotent teardown */
      }
    }
    agentDisposers.clear()
  }, 'dsh-codespace-workspace: per-agent cleanups')

  /**
   * Set up one agent, when its session cwd is one of our placeholders.
   *
   * @param {object} agent - the live agent.
   */
  const onAgentCreated = async (payload) => {
    if (disposed) return
    const agent = payload?.agent ?? payload
    try {
      const cwd = agent?.session?.header?.cwd
      const workspaceId = manager.isCodespacePath(cwd)
      if (workspaceId === undefined) return

      const record = manager.recordOf(workspaceId)
      if (record === undefined) {
        // A placeholder directory with no managed record. The session is still
        // remote-shaped, but without a Codespace name there is nothing to
        // connect to, so the surface is left alone rather than half-installed.
        log('warn', `session cwd ${cwd} is a placeholder but no Codespace is recorded for it`)
        return
      }

      const settings = getSettings()
      let status
      try {
        status = { gh: await ghInfo(run) }
      } catch {
        status = { gh: { installed: false, version: '', authenticated: false, login: '' } }
      }
      const target = buildTarget(status, settings, record)

      // One agent.ctx.effect owns the whole surface; the returned disposer is
      // also keyed here, because unloading this plugin does not dispose
      // agent.ctx registrations by itself.
      const disposeTools = installRemoteTools(agent, {
        manager,
        workspaceId,
        target,
        localToolNames: LOCAL_TOOL_NAMES,
        run,
      })

      // The prompt rule is registered on the agent's scope, so a local session
      // never sees it. It is a second effect for the same reason the tools are:
      // both must disappear together.
      let disposePrompt = () => {}
      try {
        disposePrompt = agent.ctx.effect(
          () => agent.ctx.systemPrompt.section({
            name: PROMPT_SECTION,
            order: PROMPT_ORDER,
            text: PROMPT_TEXT,
          }),
          'dsh-codespace-workspace: codespace prompt rule',
        )
      } catch (error) {
        log('warn', `cannot register the Codespace prompt rule: ${error instanceof Error ? error.message : String(error)}`)
      }

      let done = false
      const dispose = () => {
        if (done) return
        done = true
        try {
          disposePrompt()
        } catch {
          /* idempotent teardown */
        }
        disposeTools()
      }
      agentDisposers.set(String(agent.id), dispose)
      log('info', `agent ${agent.id} is a Codespace session for ${record.name} (transport ${target.kind})`)
    } catch (error) {
      // A serial `agent/created` listener that throws rejects the announcement
      // and breaks agent creation. Nothing here is worth that.
      log('warn', `agent/created wiring failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const createdEffect = ctx.on('agent/created', onAgentCreated)

  const disposedEffect = ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload
    const id = agent?.id
    if (id === undefined) return
    const dispose = agentDisposers.get(String(id))
    if (dispose === undefined) return
    agentDisposers.delete(String(id))
    dispose()
  })

  // ------------------------------------------------------------- auto-pause

  /**
   * Map a session to the workspace it belongs to, when it is a Codespace one.
   *
   * @param {object} session - the session that emitted the event.
   * @returns {string|undefined} the workspace id.
   */
  const workspaceOf = (session) => {
    const cwd = session?.header?.cwd
    return manager.isCodespacePath(cwd)
  }

  const eventEffect = ctx.on('session/event', (session, event) => {
    if (disposed) return
    try {
      const type = event?.type
      if (type !== 'turn/end' && type !== 'user/message') return
      const workspaceId = workspaceOf(session)
      if (workspaceId === undefined) return

      if (type === 'turn/end') {
        manager.setBusy(workspaceId, false)
        manager.armAutoPause(workspaceId)
        return
      }
      // Any user message means the user is present: cancel the countdown and
      // mark the workspace busy so the sidebar shows it as active.
      manager.cancelAutoPause(workspaceId)
      manager.setBusy(workspaceId, true)
    } catch (error) {
      log('warn', `session/event handling failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ---------------------------------------------------------------- shutdown

  // The harness's only guaranteed teardown hook is this effect's own cleanup:
  // `runProfile`'s dispose awaits `fiber.dispose()`, which awaits every effect
  // disposer on the root fiber, including an async one. There is no
  // `app-boot/shutdown` event and no Electron `before-quit` on the Host side.
  //
  // The budget is the harness's: 5s before `process.exit()`, and only 2s on
  // the crash path. `stopAll` is latched, issues every stop concurrently, and
  // never rejects — a rejected disposer surfaces as an AggregateError out of
  // `runProfile`.
  const shutdownEffect = ctx.effect(() => () => {
    disposed = true
    manager.dispose()
    return manager.stopAll('shutdown').catch((error) => {
      log('warn', `shutdown stop failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, 'dsh-codespace-workspace: stop managed Codespaces on shutdown')

  let torn = false
  return () => {
    if (torn) return
    torn = true
    disposed = true
    for (const dispose of [createdEffect, disposedEffect, eventEffect, promptEffect, shutdownEffect]) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* idempotent teardown */
      }
    }
    for (const dispose of agentDisposers.values()) {
      try {
        dispose()
      } catch {
        /* idempotent teardown */
      }
    }
    agentDisposers.clear()
  }
}
