/**
 * The Codespace workspace manager for dsh-codespace-workspace.
 *
 * Owns everything that has to agree with itself across the plugin's lifetime:
 * the placeholder directories DSH registers as workspaces, the mapping from a
 * DSH workspace id to a Codespace, the auto-pause timers, and the shutdown
 * stop-all.
 *
 * Design notes that are load-bearing:
 *
 * * A Codespace workspace is a *real local directory* that exists and is
 *   empty. `dsh-workspace` `realpath`-canonicalizes the path it is given and
 *   requires it to be an existing directory, so the placeholder cannot be
 *   virtual.
 * * Nothing global is replaced. Routing is by session cwd: a session whose cwd
 *   sits under the placeholder root is a Codespace session, and
 *   {@link CodespaceManager.isCodespacePath} is the single answer to that
 *   question.
 * * Auto-pause is one timer per managed workspace, so two Codespaces never
 *   share a countdown.
 *
 * @module dsh-codespace-workspace/host/codespaces
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { PLACEHOLDER_DIRNAME, SETTINGS_DEFAULTS, codespacePhase, redact, wireError } from '../shared.js'
import {
  createCodespace,
  deleteCodespace,
  getPrebuild,
  getViewer,
  GithubError,
  listCodespaces,
  listMachines,
  listRepos,
  repoIsEmpty,
  resolveToken,
  seedEmptyRepo,
  splitRepo,
  startCodespace,
  stopCodespace,
} from './github.js'
import { defaultRun, ghInfo } from './gh.js'

/** Auto-pause timers never fire sooner than this, however the settings are set. */
const MIN_PAUSE_MS = 60 * 1000

/** Ceiling on one Codespace stop request during teardown. */
const STOP_ONE_BUDGET_MS = 3500

/** Name of the persisted workspace↔Codespace map inside the placeholder root. */
const MAP_FILENAME = '.managed.json'

/** Default README committed into a repository that has no commits. */
const DEFAULT_README = [
  '# Codespace workspace',
  '',
  'This repository was initialized by dsh-codespace-workspace so that a GitHub',
  'Codespace could be created from it: creating a Codespace from a repository',
  'with no commits fails.',
  '',
].join('\n')

/**
 * Resolve the profile home that holds the placeholder directory.
 *
 * `dsh-workspace` requires an absolute, existing path, so this must never
 * return something relative. Several shapes are tried because the profile
 * context service is not part of the frozen contract.
 *
 * VERIFY: `profileContext` exposes `home` (used by `dsh-settings`), `dir` and
 * `profileDirectory` (used by `@sutong12/dsh-mcp-lazy`) depending on the
 * build. Tolerant branch: every candidate is probed, then `DSH_HOME`, then
 * `~/.dsh`, so a missing service degrades to the default harness home instead
 * of throwing at load.
 *
 * @param {object} ctx - plugin context.
 * @returns {string} an absolute directory to hold placeholder workspaces.
 */
export function resolveProfileHome(ctx) {
  const candidates = []
  try {
    const profile = ctx.get?.('profileContext')
    if (profile && typeof profile === 'object') {
      for (const key of ['home', 'dir', 'profileDirectory']) {
        const value = profile[key]
        if (typeof value === 'string' && value.trim().length > 0) candidates.push(value)
      }
    }
  } catch {
    /* service absent or racing teardown */
  }

  const envHome = process.env.DSH_HOME
  if (typeof envHome === 'string' && envHome.trim().length > 0) {
    const base = envHome.trim()
    const profile = process.env.DSH_PROFILE
    candidates.push(typeof profile === 'string' && profile.trim().length > 0
      ? join(base, 'profiles', profile.trim())
      : base)
  }
  candidates.push(join(homedir(), '.dsh'))

  for (const candidate of candidates) {
    try {
      return resolve(candidate)
    } catch {
      /* unusable candidate */
    }
  }
  return resolve(homedir())
}

/** Make one directory-name-safe token out of a Codespace name. */
function safeDirName(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
  return cleaned.length > 0 ? cleaned.slice(0, 120) : `codespace-${randomUUID().slice(0, 8)}`
}

/**
 * The DSH workspace title for a Codespace: the REPOSITORY's short name.
 *
 * A Codespace's own name is machine-generated (`psychic-goggles-7v9974jwpwr5fpqxq`)
 * and tells the user nothing about which project the row is, so the row is
 * titled after the repository instead — `owner/name` is trimmed to `name`. The
 * full `owner/name` and the Codespace name both remain visible in the hover
 * card, which is where the identifying detail belongs.
 *
 * Falls back to the Codespace name when the repository is unknown (a Codespace
 * still being provisioned reports an empty repository).
 *
 * @param {object} codespace - a normalized Codespace.
 * @returns {string} the title, or `''` when neither source is available.
 */
export function titleForCodespace(codespace) {
  const source = codespace && typeof codespace === 'object' ? codespace : {}
  // Trailing slashes are stripped first: `owner/name/` would otherwise split to an
  // empty segment and fall through to the Codespace name.
  const repo = typeof source.repository === 'string'
    ? source.repository.trim().replace(/\/+$/, '')
    : ''
  if (repo !== '') {
    const slash = repo.lastIndexOf('/')
    const short = (slash === -1 ? repo : repo.slice(slash + 1)).trim()
    if (short !== '') return short
  }
  const displayName = typeof source.displayName === 'string' ? source.displayName.trim() : ''
  if (displayName !== '') return displayName
  return typeof source.name === 'string' ? source.name.trim() : ''
}

/** Normalize a path for prefix comparison: absolute, no trailing separator. */
function canonical(path) {
  const resolved = resolve(path)
  return resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved
}

/** Whether `child` is `parent` or sits underneath it. */
function isUnder(parent, child) {
  const a = canonical(parent)
  const b = canonical(child)
  return b === a || b.startsWith(a + sep)
}

/**
 * Owns the managed Codespace workspaces.
 */
export class CodespaceManager {
  /**
   * @param {object} ctx - plugin context.
   * @param {{getSettings?: () => object, logger?: object, run?: Function, profileHome?: string}} [options] - manager options.
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.options = options
    this.run = typeof options.run === 'function' ? options.run : defaultRun
    this.root = join(options.profileHome ?? resolveProfileHome(ctx), PLACEHOLDER_DIRNAME)
    /** @type {Map<string, {workspaceId: string, name: string, title: string, path: string, addedAt: number}>} */
    this.records = new Map()
    /** @type {Map<string, {timer: any, deadline: number, minutes: number}>} */
    this.timers = new Map()
    /** @type {Set<string>} */
    this.busy = new Set()
    /** @type {Set<string>} */
    this.inFlight = new Set()
    /** @type {Promise<object>|undefined} Set by the first {@link CodespaceManager.stopAll} call. */
    this.stopAllPromise = undefined
    this.disposed = false
    this.loaded = false
  }

  /** The configured settings, or the frozen defaults when none are available. */
  settings() {
    const value = typeof this.options.getSettings === 'function' ? this.options.getSettings() : undefined
    return value && typeof value === 'object' ? value : { ...SETTINGS_DEFAULTS }
  }

  /** Log a line through the plugin logger without ever echoing a credential. */
  log(level, message) {
    const logger = this.options.logger ?? this.ctx?.logger
    try {
      const fn = logger?.[level] ?? logger?.info
      if (typeof fn === 'function') fn.call(logger, redact(`codespace: ${message}`))
    } catch {
      /* a logger is a nicety, never a dependency */
    }
  }

  // ------------------------------------------------------------- persistence

  /** Load the workspace↔Codespace map once. */
  ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    try {
      mkdirSync(this.root, { recursive: true })
    } catch (error) {
      this.log('warn', `cannot create ${this.root}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const file = join(this.root, MAP_FILENAME)
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const rows = Array.isArray(parsed?.workspaces) ? parsed.workspaces : []
      for (const row of rows) {
        if (!row || typeof row.workspaceId !== 'string' || typeof row.name !== 'string') continue
        this.records.set(row.workspaceId, {
          workspaceId: row.workspaceId,
          name: row.name,
          title: typeof row.title === 'string' ? row.title : row.name,
          path: typeof row.path === 'string' ? row.path : join(this.root, safeDirName(row.name)),
          addedAt: Number.isFinite(row.addedAt) ? row.addedAt : 0,
        })
      }
    } catch (error) {
      // A corrupt map must not stop the plugin: it degrades to "no managed
      // workspaces", and the placeholder directories remain on disk to be
      // re-adopted by a later create.
      this.log('warn', `ignoring unreadable ${MAP_FILENAME}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Persist the workspace↔Codespace map atomically. */
  save() {
    try {
      mkdirSync(this.root, { recursive: true })
      const file = join(this.root, MAP_FILENAME)
      const temporary = `${file}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, workspaces: [...this.records.values()] }, null, 2))
      // renameSync replaces the target atomically on both platforms this ships to.
      renameSync(temporary, file)
    } catch (error) {
      this.log('warn', `cannot persist ${MAP_FILENAME}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ------------------------------------------------------------------ lookup

  /**
   * The workspace id owning a session cwd, when that cwd is a placeholder.
   *
   * @param {string} cwd - the session working directory.
   * @returns {string|undefined} the workspace id, or undefined when this is a local session.
   */
  isCodespacePath(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    if (!isUnder(this.root, cwd)) return undefined
    this.ensureLoaded()
    const target = canonical(cwd)
    for (const record of this.records.values()) {
      if (canonical(record.path) === target) return record.workspaceId
    }
    // A placeholder directory exists for a workspace the map lost (a corrupt
    // map, or a directory created by hand). Treating it as a Codespace session
    // is the safe branch: the remote tools are still correct for it, and a
    // local session never has a cwd under this root.
    return undefined
  }

  /** The managed record for a workspace id. */
  recordOf(workspaceId) {
    this.ensureLoaded()
    return this.records.get(workspaceId)
  }

  /** The managed record for a Codespace name. */
  recordByName(name) {
    this.ensureLoaded()
    for (const record of this.records.values()) {
      if (record.name === name) return record
    }
    return undefined
  }

  /** Whether any managed record names this Codespace. */
  isManaged(name) {
    return this.recordByName(name) !== undefined
  }

  /** Mark a workspace busy (its agent is working) or idle. */
  setBusy(workspaceId, busy) {
    if (busy) this.busy.add(workspaceId)
    else this.busy.delete(workspaceId)
  }

  // ------------------------------------------------------------- token/status

  /**
   * Resolve the token or throw an actionable error.
   *
   * @returns {Promise<{token: string, source: string}>} the token and its source.
   * @throws {GithubError} `E_NO_TOKEN` when no source produced one.
   */
  async requireToken() {
    const settings = this.settings()
    const resolved = await resolveToken(this.ctx, settings, this.run)
    if (resolved.token === null) {
      throw new GithubError(
        'no GitHub token: set one in the Codespace settings, export GITHUB_TOKEN, or sign in with the GitHub CLI (gh)',
        'E_NO_TOKEN',
      )
    }
    return { token: resolved.token, source: resolved.source }
  }

  /**
   * Plugin status for the settings page.
   *
   * @returns {Promise<{gh: object, tokenSource: string, configured: boolean, login: string}>} the status.
   */
  async status() {
    const settings = this.settings()
    const gh = await ghInfo(this.run)
    const resolved = await resolveToken(this.ctx, settings, this.run)

    let login = ''
    if (resolved.token !== null) {
      try {
        const viewer = await getViewer(resolved.token)
        login = viewer.login
      } catch (error) {
        // A bad token is a status fact, not a status failure: the page renders
        // "not signed in" and the actionable message comes from the action the
        // user actually takes.
        this.log('warn', `token rejected while reading the viewer: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      gh: {
        installed: gh.installed === true,
        version: gh.version ?? '',
        authenticated: gh.authenticated === true,
        login: gh.login ?? '',
      },
      tokenSource: resolved.source,
      configured: resolved.token !== null,
      login,
    }
  }

  // ------------------------------------------------------------ control plane

  /** Repositories the token can reach. */
  async listRepos() {
    const { token } = await this.requireToken()
    return listRepos(token)
  }

  /**
   * Codespaces, annotated with whether this plugin manages them.
   *
   * @param {string} [repo] - restrict to one repository.
   * @returns {Promise<object[]>} normalized Codespaces.
   */
  async listCodespaces(repo) {
    const { token } = await this.requireToken()
    const rows = await listCodespaces(token, repo)
    return rows.map((row) => ({ ...row, managed: this.isManaged(row.name) }))
  }

  /** Machine types for a repository. */
  async machines(repo) {
    const { token } = await this.requireToken()
    const settings = this.settings()
    const branch = settings.defaultBranch
    return listMachines(token, repo, branch)
  }

  /**
   * Whether a repository has a ready prebuild.
   *
   * @param {string} repo - `owner/name`.
   * @returns {Promise<boolean|null>} true/false, or null when it cannot be determined.
   */
  async prebuild(repo) {
    const { token } = await this.requireToken()
    const settings = this.settings()
    return getPrebuild(token, repo, settings.defaultBranch)
  }

  /**
   * Create a Codespace, seeding an empty repository first when configured to.
   *
   * Creating a Codespace from a repository with no commits fails, so when the
   * repository is empty and `autoInitEmptyRepo` is on, a README is committed
   * through the Contents API first. No `branch` is sent on that initial
   * commit: the Contents API rejects a branch that does not exist yet.
   *
   * @param {{repo: string, branch?: string, machine?: string, displayName?: string}} options - creation inputs.
   * @returns {Promise<object>} the created Codespace.
   */
  async create(options) {
    const { token } = await this.requireToken()
    const settings = this.settings()
    const repo = String(options.repo ?? '')
    splitRepo(repo)

    let seeded = false
    try {
      if (await repoIsEmpty(token, repo)) {
        if (settings.autoInitEmptyRepo === false) {
          throw new GithubError(
            `${repo} has no commits; creating a Codespace from it will fail. Enable "initialize empty repositories" or push an initial commit first.`,
            'E_EMPTY_REPO',
          )
        }
        const content = typeof settings.readmeContent === 'string' && settings.readmeContent.length > 0
          ? settings.readmeContent
          : DEFAULT_README
        await seedEmptyRepo(token, { repo, content })
        seeded = true
      }
    } catch (error) {
      // A 404/409 from the commits probe already means "empty" inside
      // repoIsEmpty. Anything that escapes is a real failure to determine
      // emptiness; letting it through is safer than creating a Codespace that
      // is guaranteed to fail.
      if (error instanceof GithubError && error.code === 'E_EMPTY_REPO') throw error
      this.log('warn', `emptiness probe failed for ${repo}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    const idle = Number.isFinite(settings.autoPauseMinutes)
      ? Math.max(5, Math.round(settings.autoPauseMinutes))
      : SETTINGS_DEFAULTS.autoPauseMinutes

    const result = await createCodespace(token, {
      repo,
      branch: options.branch ?? settings.defaultBranch,
      machine: options.machine,
      displayName: options.displayName,
      idleTimeoutMinutes: idle,
    })
    if (seeded) this.log('info', `initialized empty repository ${repo} with a README before creating the Codespace`)
    return { ...result.codespace, managed: this.isManaged(result.codespace.name) }
  }

  /** Start a Codespace. */
  async start(name) {
    const { token } = await this.requireToken()
    const row = await startCodespace(token, name)
    return { ...row, managed: this.isManaged(row.name) }
  }

  /** Stop a Codespace and cancel any pending auto-pause for it. */
  async stop(name) {
    const record = this.recordByName(name)
    if (record !== undefined) this.cancelAutoPause(record.workspaceId)
    const { token } = await this.requireToken()
    const row = await stopCodespace(token, name)
    return { ...row, managed: this.isManaged(row.name) }
  }

  /** Delete a Codespace. */
  async remove(name) {
    const record = this.recordByName(name)
    if (record !== undefined) this.cancelAutoPause(record.workspaceId)
    const { token } = await this.requireToken()
    await deleteCodespace(token, name)
  }

  // --------------------------------------------------------------- workspaces

  /**
   * Every managed workspace, joined with its live Codespace state.
   *
   * @returns {Promise<object[]>} `Managed[]`.
   */
  async listWorkspaces() {
    this.ensureLoaded()
    const records = [...this.records.values()]
    if (records.length === 0) return []

    // One list call serves every row: a per-row request would make the 4s
    // sidebar poll quadratic in the number of workspaces.
    const byName = new Map()
    let listError = null
    try {
      for (const row of await this.listCodespaces()) byName.set(row.name, row)
    } catch (error) {
      listError = wireError(error)
    }

    // Retitle rows registered before the repository-based naming (or before the
    // Codespace's repository was known). The DSH registry keeps the title of an
    // existing record, so without this the user's existing rows would keep their
    // machine-generated Codespace name forever.
    await this.retitleFromLive(byName)

    return records.map((record) => {
      const live = byName.get(record.name)
      const state = live?.state ?? ''
      return {
        workspaceId: record.workspaceId,
        title: record.title,
        path: record.path,
        codespace: live ?? {
          name: record.name,
          displayName: record.name,
          repository: '',
          branch: '',
          state: '',
          machine: { name: '', displayName: '', cpus: 0, memoryGb: 0 },
          idleTimeoutMinutes: 0,
          lastUsedAt: '',
          createdAt: '',
          webUrl: '',
          prebuild: null,
          managed: true,
        },
        state,
        phase: codespacePhase(state),
        busy: this.busy.has(record.workspaceId),
        ...this.autoPauseInfo(record.workspaceId),
        ...(listError === null ? {} : { error: listError }),
      }
    })
  }

  /**
   * Bring each managed record's title in line with its Codespace's repository.
   *
   * Idempotent and cheap when nothing changed: it only writes when a title
   * actually differs. A record whose Codespace is gone, or whose repository is
   * still unknown, is left alone — guessing a title from nothing would be worse
   * than the old one.
   *
   * @param {Map<string, object>} byName - live Codespaces keyed by name.
   * @returns {Promise<void>}
   */
  async retitleFromLive(byName) {
    if (byName.size === 0) return
    const registry = this.ctx.get?.('workspaceRegistry')
    let changed = false
    for (const record of this.records.values()) {
      const live = byName.get(record.name)
      if (live === undefined) continue
      const wanted = titleForCodespace(live)
      if (wanted === '' || wanted === record.title) continue
      if (registry !== undefined && typeof registry.resolveByPath === 'function') {
        try {
          const workspace = await registry.resolveByPath(record.path)
          if (workspace !== undefined && typeof workspace.setTitle === 'function') {
            await workspace.setTitle(wanted)
          }
        } catch (error) {
          this.log('warn', `cannot retitle workspace ${record.workspaceId}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
      }
      record.title = wanted
      changed = true
    }
    if (changed) this.save()
  }

  /**
   * Create the placeholder directory and register it as a DSH workspace.
   *
   * @param {{codespace: object|string, title?: string}} options - the Codespace and an optional title.
   * @returns {Promise<object>} the `Managed` record.
   */
  async createWorkspace(options) {
    this.ensureLoaded()
    const codespace = options.codespace
    const name = typeof codespace === 'string' ? codespace : String(codespace?.name ?? '')
    if (name.length === 0) {
      throw new GithubError('create-workspace requires a Codespace with a name', 'E_INVALID')
    }

    const registry = this.ctx.get?.('workspaceRegistry')
    if (registry === undefined || typeof registry.create !== 'function') {
      throw new GithubError('the workspace registry service is unavailable in this profile', 'E_NO_REGISTRY')
    }

    const dir = join(this.root, safeDirName(name))
    mkdirSync(dir, { recursive: true })

    // The row is titled after the REPOSITORY, not the machine-generated Codespace
    // name; see `titleForCodespace`. An explicit `title` still wins, and when the
    // Codespace carries no repository yet the Codespace name is the fallback.
    const live = typeof codespace === 'object' && codespace !== null ? codespace : undefined
    const title = typeof options.title === 'string' && options.title.trim().length > 0
      ? options.title.trim()
      : titleForCodespace(live ?? { name })

    // `create` returns the existing workspace when one already owns this path
    // (without changing its title), so this is idempotent and safe to retry.
    // `resolveByPath` is probed first because it is the pure "already adopted?"
    // question: it neither creates nor mutates.
    let workspace
    if (typeof registry.resolveByPath === 'function') {
      workspace = await registry.resolveByPath(dir)
    }
    if (workspace === undefined) workspace = await registry.create(dir, title)
    const workspaceId = String(workspace.id)

    // `create` keeps the title of an existing record, so a workspace that was
    // registered under the old Codespace-name title is retitled here — that is
    // what makes the rename apply to rows the user already has.
    if (title !== '' && typeof workspace.setTitle === 'function') {
      const current = typeof workspace.title === 'string' ? workspace.title : ''
      if (current !== title) {
        try {
          await workspace.setTitle(title)
        } catch (error) {
          this.log('warn', `cannot retitle workspace ${workspaceId} to "${title}": ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    this.records.set(workspaceId, { workspaceId, name, title, path: dir, addedAt: Date.now() })
    this.save()
    this.log('info', `registered workspace ${workspaceId} for Codespace ${name} at ${dir}`)

    return {
      workspaceId,
      title,
      path: dir,
      codespace: live ?? {
        name,
        displayName: name,
        repository: '',
        branch: '',
        state: '',
        machine: { name: '', displayName: '', cpus: 0, memoryGb: 0 },
        idleTimeoutMinutes: 0,
        lastUsedAt: '',
        createdAt: '',
        webUrl: '',
        prebuild: null,
        managed: true,
      },
      state: live?.state ?? '',
      busy: false,
      ...this.autoPauseInfo(workspaceId),
    }
  }

  /**
   * Remove a managed workspace, optionally deleting its Codespace.
   *
   * The registry's `delete` is an idempotent no-op for an unknown id, so a
   * repeated removal does not throw.
   *
   * @param {{workspaceId: string, deleteCodespace?: boolean}} options - what to remove.
   * @returns {Promise<{}>} an empty result.
   */
  async removeWorkspace(options) {
    this.ensureLoaded()
    const workspaceId = String(options.workspaceId ?? '')
    const record = this.records.get(workspaceId)

    this.cancelAutoPause(workspaceId)
    this.busy.delete(workspaceId)

    const registry = this.ctx.get?.('workspaceRegistry')
    if (registry !== undefined && typeof registry.delete === 'function') {
      try {
        // `delete` returns false for an unknown id and never throws, so this
        // needs no existence pre-check; the call is kept inside try/catch only
        // so an unexpected storage failure cannot strand the local record.
        await registry.delete(workspaceId)
      } catch (error) {
        this.log('warn', `registry.delete(${workspaceId}) failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    this.records.delete(workspaceId)
    this.save()

    if (options.deleteCodespace === true && record !== undefined) {
      const { token } = await this.requireToken()
      await deleteCodespace(token, record.name)
    }

    if (record !== undefined) {
      try {
        rmSync(record.path, { recursive: true, force: true })
      } catch (error) {
        // The directory may be locked by a live session; leaving an empty
        // placeholder behind is harmless and re-adopted on the next create.
        this.log('warn', `cannot remove placeholder ${record.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {}
  }

  // --------------------------------------------------------------- auto-pause

  /** The countdown state for a workspace, in the shape `Managed` publishes. */
  autoPauseInfo(workspaceId) {
    const entry = this.timers.get(workspaceId)
    if (entry === undefined) return { autoPauseRemainingMs: 0, autoPauseDeadline: 0 }
    return {
      autoPauseRemainingMs: Math.max(0, entry.deadline - Date.now()),
      autoPauseDeadline: entry.deadline,
    }
  }

  /**
   * Start or restart this workspace's auto-pause countdown.
   *
   * Called on `turn/end`. A second call restarts the window rather than
   * stacking a second timer: there is exactly one timer per workspace.
   *
   * @param {string} workspaceId - the workspace whose agent just went idle.
   */
  armAutoPause(workspaceId) {
    if (this.disposed) return
    const record = this.records.get(workspaceId)
    if (record === undefined) return

    const settings = this.settings()
    const minutes = Number.isFinite(settings.autoPauseMinutes)
      ? settings.autoPauseMinutes
      : SETTINGS_DEFAULTS.autoPauseMinutes
    if (!(minutes > 0)) {
      this.cancelAutoPause(workspaceId)
      return
    }

    const delay = Math.max(MIN_PAUSE_MS, Math.round(minutes * 60 * 1000))
    this.cancelAutoPause(workspaceId)

    const timer = setTimeout(() => {
      this.timers.delete(workspaceId)
      void this.pauseNow(workspaceId).catch((error) => {
        this.log('warn', `auto-pause of ${record.name} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, delay)
    // A pending countdown must never hold the process open.
    if (typeof timer.unref === 'function') timer.unref()

    this.timers.set(workspaceId, { timer, deadline: Date.now() + delay, minutes })
  }

  /**
   * Cancel this workspace's countdown.
   *
   * @param {string} workspaceId - the workspace.
   * @returns {boolean} whether a countdown was running.
   */
  cancelAutoPause(workspaceId) {
    const entry = this.timers.get(workspaceId)
    if (entry === undefined) return false
    clearTimeout(entry.timer)
    this.timers.delete(workspaceId)
    return true
  }

  /**
   * Stop this workspace's Codespace now, cancelling its countdown.
   *
   * @param {string} workspaceId - the workspace.
   * @returns {Promise<{stopped: boolean, name: string}>} the outcome.
   */
  async pauseNow(workspaceId) {
    this.cancelAutoPause(workspaceId)
    const record = this.records.get(workspaceId)
    if (record === undefined) return { stopped: false, name: '' }

    try {
      const { token } = await this.requireToken()
      const row = await stopCodespace(token, record.name)
      this.log('info', `auto-paused ${record.name} (state ${row.state})`)
      return { stopped: true, name: record.name }
    } catch (error) {
      // A stop that fails is logged, never thrown: this runs from a timer and
      // from a double-click, and neither has anywhere to surface a rejection.
      this.log('warn', `cannot stop ${record.name}: ${error instanceof Error ? error.message : String(error)}`)
      return { stopped: false, name: record.name }
    }
  }

  // ----------------------------------------------------------------- shutdown

  /**
   * Stop every managed Codespace. Idempotent, concurrent, bounded, never rejects.
   *
   * Runs at most once per process: the promise is latched, so a second caller
   * (a repeat teardown, a signal path racing the effect disposer) awaits the
   * first result instead of issuing a second round of stop requests.
   *
   * The budget here is the harness's, not ours: `createProcessShutdown` arms a
   * hard 5s timer that calls `process.exit()` if dispose has not settled, and
   * the crash path allows only 2s. So every stop is issued *concurrently*
   * through `Promise.allSettled`, each is bounded by {@link STOP_ONE_BUDGET_MS},
   * and no failure escapes — a rejected disposer would surface as an
   * `AggregateError` out of `runProfile`.
   *
   * @param {string} [reason] - recorded in the log line and the pending marker.
   * @returns {Promise<{attempted: number, stopped: number, pending: string[]}>} the outcome.
   */
  async stopAll(reason = 'shutdown') {
    if (this.stopAllPromise !== undefined) return this.stopAllPromise
    this.stopAllPromise = this.#stopAll(reason).catch((error) => {
      // Belt and braces: #stopAll already swallows everything, but this method
      // is the last thing between a bug here and a failed process teardown.
      this.log('warn', `stopAll failed: ${error instanceof Error ? error.message : String(error)}`)
      return { attempted: 0, stopped: 0, pending: [] }
    })
    return this.stopAllPromise
  }

  /** The body of {@link CodespaceManager.stopAll}, run at most once. */
  async #stopAll(reason) {
    this.ensureLoaded()
    for (const workspaceId of [...this.timers.keys()]) this.cancelAutoPause(workspaceId)

    const names = [...new Set([...this.records.values()].map((record) => record.name))]
    if (names.length === 0) return { attempted: 0, stopped: 0, pending: [] }

    let token = null
    try {
      token = (await this.requireToken()).token
    } catch (error) {
      // No token means we cannot stop anything. Record every managed name as
      // pending so the next boot's leftover prompt covers them.
      this.log('warn', `not stopping ${names.length} Codespace(s) on ${reason}: ${error instanceof Error ? error.message : String(error)}`)
      this.writePendingStop(names, reason)
      return { attempted: names.length, stopped: 0, pending: names }
    }

    const settled = await Promise.allSettled(names.map(async (name) => {
      await stopCodespace(token, name, {
        // Under the 5s process budget, with headroom: a stop that has not
        // answered by then will not answer usefully.
        timeoutMs: STOP_ONE_BUDGET_MS,
        retry: false,
      })
      return name
    }))

    const pending = []
    let stopped = 0
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index]
      if (outcome.status === 'fulfilled') {
        stopped += 1
        continue
      }
      pending.push(names[index])
      this.log('warn', `cannot stop ${names[index]} on ${reason}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`)
    }

    // The safety net the contract requires: a stop that did not confirm is
    // recorded so the next boot can offer it alongside the live listing.
    if (pending.length > 0) this.writePendingStop(pending, reason)
    else this.clearPendingStop()

    this.log('info', `${reason}: stopped ${stopped}/${names.length} managed Codespace(s)${pending.length > 0 ? `; ${pending.length} recorded as pending` : ''}`)
    return { attempted: names.length, stopped, pending }
  }

  /** Path of the pending-stop marker. */
  get pendingStopFile() {
    return join(this.root, 'pending-stop.json')
  }

  /**
   * Record Codespace names whose stop did not confirm.
   *
   * Best effort by construction: this runs inside a hard shutdown budget, so a
   * failure to write the marker is logged and nothing else.
   *
   * @param {string[]} names - the Codespace names still believed running.
   * @param {string} reason - why the stop was attempted.
   */
  writePendingStop(names, reason) {
    try {
      mkdirSync(this.root, { recursive: true })
      const file = this.pendingStopFile
      const temporary = `${file}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, at: new Date().toISOString(), reason, names }, null, 2))
      renameSync(temporary, file)
    } catch (error) {
      this.log('warn', `cannot record pending stops: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Drop the pending-stop marker, if any. */
  clearPendingStop() {
    try {
      rmSync(this.pendingStopFile, { force: true })
    } catch {
      /* the marker is a hint, never a requirement */
    }
  }

  /**
   * Codespace names whose stop a previous process left unfinished.
   *
   * @returns {string[]} the recorded names, or an empty array.
   */
  readPendingStop() {
    try {
      if (!existsSync(this.pendingStopFile)) return []
      const parsed = JSON.parse(readFileSync(this.pendingStopFile, 'utf8'))
      const names = Array.isArray(parsed?.names) ? parsed.names : []
      return names.filter((name) => typeof name === 'string' && name.length > 0)
    } catch {
      // An unreadable marker is discarded rather than retried forever.
      this.clearPendingStop()
      return []
    }
  }

  /** Cancel every timer and mark the manager closed. Idempotent. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const workspaceId of [...this.timers.keys()]) this.cancelAutoPause(workspaceId)
    this.busy.clear()
  }
}
