# dsh-codespace-workspace — implementation contract

Single source of truth for both halves of the plugin. Every API named here was read
out of the installed DSH 0.2.0-rc.2 build; do not substitute remembered APIs.

Extracted reference copies live under `../../../tmp/` (`dsh-src`, `dsh-src3`).
DSH's own authoring skill is authoritative and ships in the app:
`tmp/dsh-src3/dsh-agent/-preset/skills/cordis-plugin-development/` — read
`SKILL.md`, `references/practices.md`, `references/host-plugin.md`,
`references/ui-plugin.md` before writing code.

---

## 1. Product

A GitHub Codespace **is** a DSH workspace. The agent's file and command tools
operate inside the remote Codespace. It is not a generic SSH host manager: it
does not touch DSH's SSH host list and must not collide with other cloud
workspace plugins.

## 2. Verified DSH facts (do not re-derive, do not contradict)

### Plugin shape

* Host entry (`lib/index.js`) is one of, never mixed:
  * `export function apply(ctx, config) {}` + optional `export const inject = [...]`
    and `export const Config`.
  * a service class as the default export.
* `export const name = 'dsh-codespace-workspace'`.
* `Config` is a `@deepseek-ai/schemastery` schema. Fields the user may change
  while DSH runs carry `.volatile()`. Guard for old schemastery:
  `const vol = (s) => (typeof s?.volatile === 'function' ? s.volatile() : s)`.
* Secrets use `.role('secret')` (redacted from client reads; write-only input).
* `package.json` needs `exports["./client"]` pointing at the **exact** produced
  file, and `dsh.bundle.patch` pointing at the patch YAML. A missing client
  artifact aborts Host startup.
* `cordis.patch.yml` inserts rows; `name` must be the **full package name**
  (`dsh-codespace-workspace`), `id` is the settings namespace.

### Settings — the standard mechanism

There is **no `installSection` API** in DSH. Do not invent one.

* Declare `Config`; mark live fields `.volatile()`.
* Persist from the host with the settings service, keyed by the **profile entry
  id** (our row id, `dsh-codespace-workspace`):
  * `ctx.settings.update(ns, patch, expectedRevision?)`
  * `ctx.settings.mutate(ns, ops, expectedRevision?)` — ops are
    `{ op: 'set'|'unset', path: string[], value? }`
  * `ctx.settings.describe({ redactSecrets: true })` → descriptors with
    `ns`, `schema`, `revision`, `value`, `base`, `user`, `secrets`.
* Observe changes with `ctx.on('settings/document-updated', …)` and/or
  `ctx.on('app-boot/config-reload', …)`. These are the **only** two: the
  settings package emits exactly `settings/document-updated` and
  `settings/redact`. There is no `settings/updated`.
* Only volatile paths are writable; a write outside them throws.

### System prompt

`ctx.systemPrompt.section({ name, order, text })` — text may be a string or
`(context) => string`. `order` must be finite. Register inside `ctx.effect`.
Use a fixed order (our rule belongs after the persona, before tool guidance →
`order: 1500`). Do **not** register an assembly waterfall listener.

### Workspace registry

Service name is **`workspaceRegistry`** (`WorkspaceRegistry extends Service`,
`super(ctx, "workspaceRegistry")`; `static inject = ["storageDomain",
"sessionPersistence"]`). Verified in `@deepseek-ai/dsh-workspace/lib/index.js`
≈L354–375 and `lib/types/index.js`.

* `await ctx.workspaceRegistry.create(path, title?)` → `Workspace`. `path` must
  be fully qualified and **already exist as a directory** (`mkdir` it first);
  it is `realpath`-canonicalized and is the uniqueness key. Returns the
  **existing** entity if one already owns that canonical path (and does *not*
  update the title). New records are **prepended** to the durable order.
* `ctx.workspaceRegistry.list()` → `Workspace[]` (synchronous, durable order);
  `.get(id)` → `Workspace | undefined`; `await .resolveByPath(path)` →
  `Workspace | undefined` (rejects if `realpath` fails, returns `undefined` for
  an existing-but-unowned directory — this is the correct way to ask "is this
  path already a workspace?" without creating one).
* `Workspace`: getters `path`, `title`, `createdAt`, `updatedAt`, `sessionIds`;
  methods `setTitle(title)`, `attachSession(id)`, `detachSession(id)`,
  `insertSessionBefore(id, beforeId)`, `status()` (`'ok' | 'missing-dir'`).
* **Deletion is `await ctx.workspaceRegistry.delete(id)` → `Promise<boolean>`**
  (verified, `lib/types/index.js` ≈L217–227). It removes only the registration;
  the directory and every session log are retained. **Unknown ids are an
  idempotent no-op returning `false`** — it does not throw, so the delete flow
  needs no existence pre-check. It is serialized through the registry's own
  mutation queue, so concurrent calls are safe.
* The service is **not** synchronously available at plugin load: `init` awaits
  `storageDomain` + `sessionPersistence` and completes the history bootstrap
  before the service activates. Declare it in `inject` and touch it only inside
  an injected context, never at module top level.

### Tools and per-agent scoping — the load-bearing mechanism

* Tools resolve services from **their own host-plane context**, not from the
  agent. So swapping `ctx.fs` globally would affect every session. Do not do it.
* `ctx.tools.register(definition)` called on **`agent.ctx`** registers a tool in
  that agent's scope, which shadows a same-named global for that agent only.
  This is the supported per-agent seam (`dsh-tools`: "for a per-agent variant,
  register through that agent's `agent.ctx`").
* `ctx.tools.restrict(name, …)` requires a scoped context and removes a tool for
  that agent. Use it to hide `pwsh` for a Codespace agent (Linux) and to keep
  the local `read`/`write`/`edit`/`bash`/`glob`/`grep` from being used.
* `agent/created` is a **serial** event; listeners get the agent. Register
  per-agent behaviour on `agent.ctx` inside one `agent.ctx.effect()` **and**
  keep that disposer keyed by agent in our own plugin effect, because unloading
  the plugin does not dispose `agent.ctx` registrations by itself.
* `agent.ctx.effect(fn, label)`; `agent.session.header.cwd` is the session's
  working directory — this is how we decide whether an agent is a Codespace
  agent.
* Tool definitions are read from `dsh-tool-fs` / `dsh-tool-bash`; our shadow
  tools must return the same `output` schema shape and render the same
  `[exit code: N]` marker contract (`parseExitStatus` lives in
  `@deepseek-ai/dsh-shell`). **Verify the exact `register()` definition shape by
  reading `dsh-tools`' README and `dsh-tool-fs/lib/index.js` before writing.**

### Host HTTP routes for the client

Two supported carriers; use both like `@copylee/dsh-remote-control` does:

```js
// Browser, over DSH's authenticated transport:
await (globalThis.__DSH_TRANSPORT__?.fetch ?? fetch)(ROUTE, {
  method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
})
```

```js
// Host side — register the exact path on the web server, and the same path on
// connection.fetch so the Desktop shell reaches it too:
ctx.inject(['webServer'], (ready) => {
  ready.effect(() => ready.webServer.register({ kind: 'exact', path: ROUTE, handler }), 'label')
  ready.effect(() => ready.connection.fetch.register({
    path: ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: async (req) => Response.json(...),
  }), 'label')
})
```

**Register on `connection.fetch`, NOT on a `webServer` exact route.** This was
learned the hard way; do not "simplify" it back.

DSH mounts its own `/api` route as a **prefix** route that first calls
`connection.admit(req)` — the Host/Origin fence *and* the browser-auth cookie
check — and only then hands the request to `createSharedFetchHandler`, which
dispatches to whatever exact Fetch routes plugins registered under `/api`.
Registering on `connection.fetch` therefore inherits the harness's security
policy instead of re-implementing it, and serves the browser and the Desktop
shell alike.

`webServer.match()` tries the **exact table before the prefix table**, so a
plugin-registered `{ kind: 'exact', path: '/api/...' }` route is matched first
and **shadows the `/api` route entirely** — silently dropping both the fence and
the authentication. That was a real defect in this plugin: measured against a
live host,

```
POST /api/dsh-codespace-workspace/rpc   (no cookie, matching Origin)  -> 200
POST /api/no-such-plugin-xyz            (no cookie, matching Origin)  -> 401 unauthorized
```

The second line is DSH's `/api` route refusing an unauthenticated caller; the
first line shows our exact route bypassing it. The route is now registered on
`connection.fetch` and the exact route survives only as a fallback for a
composition with no `connection` service (where it must apply the fence itself).

Two more details that matter:

* `connection` is **not** in this module's `inject` list, so `ready.connection`
  is gated by cordis and throws `cannot get property "connection" without
  inject`. Read it through `ready.get('connection', false)` — the documented
  ungated accessor, "Read a service from the store without the inject
  requirement" — which returns `undefined` when nothing provides it.
* `assertFetchRoute` requires the path to sit under `/api` and be non-empty:
  `endpointFromPath('/api', path)` must not be `undefined`, i.e. the path must
  be `/api/<segments>` with every segment matching `/^[A-Za-z0-9_$.-]+$/`.

### Outbound HTTPS: Node trusts only its bundled CA list

Measured on the development machine and worth knowing before debugging any
"cannot reach the API" report: this box has a **TLS-intercepting proxy** whose
root lives in the Windows trust store and nowhere else. `fetch` (undici)
validates against Node's *bundled* CA list, so **every** request to the GitHub
API fails, while `gh` (Go, which reads the OS store) succeeds on the very same
request — the confusing "authenticated via `gh auth token`, yet the API is
unreachable" state.

The real cause is **never in `error.name`**: a `fetch` transport failure is
`TypeError: fetch failed`, and the actionable code is in `error.cause.code`
(`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Reporting `error.name` alone produces a
useless message; report the cause code.

`lib/host/github.js` handles it **in process**, without touching global TLS
state:

```js
import { getCACertificates } from 'node:tls'   // Node 24+
// on a trust failure only, retry once through node:https with
// ca = getCACertificates('system')  (225 certs on this machine)
```

`tls.setDefaultCACertificates(...)` also works but is **rejected**: it would
silently widen TLS trust for the entire host process, affecting every other
plugin. `NODE_OPTIONS=--use-system-ca` is the environment-level equivalent and
fixes all Node code at once, but needs an env change plus a DSH restart, so it is
only documented as an alternative. The `test/live.mjs` suite exists to catch this
class of failure — it first measures whether the direct path works and then
asserts the control plane succeeds either way.

### Client module

* File is a lazy-CJS bundle loaded through the global loader:

```js
window.__ModuleLoader__.load({
  id: 'dsh-codespace-workspace',
  factory: (require) => {
    const module = { exports: {} }        // REQUIRED: the loader passes only `require`
    const React = require('react')
    const h = React.createElement
    // ...
    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
```

* **React is not a global** — `require('react')`.
* Do **not** `require('@deepseek-ai/dsh-client-ui-primitives')`. Copy the markup
  and CSS instead; a throwing component blanks the slot entry. Style with
  `--dsw-alias-*` tokens only.
* Register into a slot with
  `ctx.slots.inject(key, () => ctx.slots.register({ name, id, order, label, children, inject }, Component))`.
  Registering into an undeclared slot throws.

### Available slots (verified)

The **authoritative catalog** is generated by the client runner itself:
`@deepseek-ai/dsh-cordis-client-runner/lib/client.js` carries one service-catalog
entry per slot, each with a `ctx.slots.inject('<name>')` example. I extracted the
complete list — **90 slots**. Anyone adding a slot must be able to point at a
`ctx.slots.register({ name: '<that exact name>', … })` in a shipped package, or
the registration throws `slot "<name>" is not declared`.

| Slot | Kind | Use |
|---|---|---|
| `settings.section` | list | our **Codespace** settings page (`id`, `order`, `label: () => …`) |
| `shell.overlay` | list | the single multi-step **new cloud workspace** window and the delete dialog |
| `sidebar.workspaces` | single | owned by `ui-workspace`; **do not take it** |

Kind declarations verified: `settings.section` is `{kind:"list", scope:"root"}`
declared by `ui-settings-general` (`lib/client.js` ≈L1136); `shell.overlay` is
`{kind:"list", scope:"root"}` declared by `ui-layout` (≈L617). Registering a
`list` entry **without** an `id` collapses it to a single always-present cell —
always pass `id` and `order`.

**The new-cloud-workspace launcher is deliberately NOT a slot entry.** The
requirement is that it sits in the workspace section's own header icon row as a
peer of the host's controls, immediately left of 添加工作区 — and there is no
slot for that row (see below). `sidebar.footer.action` *is* a real declared slot
(by `ui-sidebar`, ≈L515, `{kind:"list", scope:"root"}`) and was used in an
earlier revision, but it puts the control in the sidebar footer, which is not
where the requirement places it. It is therefore a DOM augmentation instead.

### The workspace section header has NO slot (verified negative finding)

`dsh-client-ui-workspace/lib/client.js` (`WorkspaceBrowser`, ≈L150370):

```
<div class="<hash>_sectionHeader">            flex, height:36px, gap:4px, justify-content:flex-end
  {wide && <span class="<hash>_sectionLabel">…</span>}
  {wide && <div class="<hash>_searchSlot">…</div>}
  <div class="<hash>_headerActions">          gap:4px, max-width:60px, overflow:hidden
    {wide && <ViewOptionsMenu/>}              Tooltip > button.<hash>_iconButton
    {directoryFlowAvailable && <Tooltip>      button.<hash>_iconButton, aria-label="添加工作区"
      <button …/>
    </Tooltip>}
  </div>
</div>
```

* The icon row is `headerActions`; its **last element child is the host's "+"**
  (a real `<button>`) whenever `directoryFlowAvailable` is true. It is absent
  when the directory-flow slot is unoccupied, so the insert position must be
  "before the last child" with a fallback, never a fixed index.
* **`headerActions`' buttons are 28x28, not 16x16.** They are
  `WorkspaceBrowser`'s `.<hash>_iconButton`: `width/height:28px`,
  `border-radius:var(--dsw-radius-sm)`, `color:var(--dsw-alias-label-secondary)`,
  transparent background, and a hover that shows a **background**
  (`var(--dsw-alias-interactive-bg-hover)`) rather than changing the colour.
  `max-width:60px` therefore fits exactly **two** (28+4+28), so our control needs
  the container widened — but the widening rule **must not** out-specify the
  host's own collapse, hence `:not([class*="_headerActionsHidden"])`.
  Do **not** confuse this with `Rows`' `.<hash>_iconButton`, a different module's
  class that *is* 16x16 (the workspace-row buttons). Conflating the two is how
  this plugin shipped a 16x16 header control; the browser fixture had copied the
  same wrong value, so its "same size as its peers" assertion stayed green.
* `headerActionsHidden` (`opacity:0;visibility:hidden;max-width:0;pointer-events:none`)
  is added while the search box is expanded, which is why the widening rule
  carries the `:not(...)` guard. Our control is a child of the container, so it
  disappears with its peers for free while that class is on.
* Rail mode enlarges the host's box to `36px` / `var(--dsw-radius-md)` /
  `var(--dsw-alias-label-primary)` **and its glyph to 18px** (`IconProjectAddOutlineRegular,
  { size: wide ? 16 : 18 }`), so our button and glyph both need matching rules.
* **Glyph spec** (only matters when drawing our own SVG; there is no cloud
  artwork in the primitives bundle): `<svg width height viewBox="0 0 16 16"
  fill="none" xmlns aria-hidden="true" stroke-width={1}>`, `stroke="currentColor"`
  on each stroked path, and **`stroke-width` on the `<svg>`, never on the path**.
  `Regular` = 1, `Medium` = `ICON_MEDIUM_STROKE` = 1.3; the header uses `Regular`.
  The plugin's cloud path lives in one shared constant so the React and DOM
  renderers cannot drift, and the browser suite asserts the weight.
* **The launcher glyph is a cloud PLUS the add mark**, echoing the host's own
  `IconProjectAddOutlineRegular` (folder + plus) on the button beside it. The plus
  strokes are copied verbatim from that artwork.
* **Keep the cloud at full size and BREAK its outline where the plus crosses** —
  do not shrink the cloud to dodge the plus, which is what an earlier revision
  did. The host's folder keeps its full size and has its top-right carved open for
  the plus; this is the same idea. The cloud path is used unmodified and drawn
  through an SVG `<mask>`: a white 16x16 plate, then each plus stroke painted
  black at `CLOUD_MASK_BAND` (2.6) width, so the outline is erased along the band
  the plus occupies.
  * A mask rather than hand-cut subpaths: the outline meets the plus in **two**
    places (the vertical stroke crosses the right lobe at `y = 6.706`, and the
    horizontal stroke's *band* also clips the big arc near `x = 9.76`), and
    hand-deriving both cut points would have to be kept in step with the artwork
    forever.
  * `stroke-linecap="butt"` on the cut strokes: a round cap would extend half a
    band past the plus's lower tip and can bite a detached sliver out of the lobe.
  * Each glyph needs its **own** mask id (`maskUnits="userSpaceOnUse"`). Ids are
    document-global, so two glyphs sharing one would make the second resolve
    `url(#id)` to the first.
* **A structural assertion cannot prove a mask erases anything**: a wrong mask
  colour, a missing `maskUnits`, or a colliding id all still render a perfectly
  good cloud. The browser suite therefore rasterises the glyph twice — once as
  built and once with only the `mask` attribute stripped — and diffs the two, so
  the erased ink is measured rather than assumed. Do not replace that with a
  hand-picked sample box or a per-column blank test: the outline is curved, so a
  gap does not blank its column, and a fixed box runs into either antialiasing
  fringe or the plus's own ink.
* **The launcher must stay LEFT of 添加工作区**, which is subtler than it looks:
  * `headerActions` may contain a **tooltip bubble**: the host's `Tooltip` is not
    portalled here (the workspace header passes no `portal` prop), so React renders
    an open bubble as a **sibling `<span role="tooltip">` in this same container**.
    Anything anchored on `lastElementChild` therefore moves the launcher in front
    of the bubble — i.e. to the RIGHT of the "+" — which is why the symptom looked
    intermittent (a tooltip had to be open).
  * React does not know our node exists, so a re-render can place one of its
    controls after it.
  * Both are handled by **remembering the anchor element** (`headerAnchor`) and
    keeping the launcher immediately before *that*, instead of re-deriving "the
    last control" on every pass. Re-deriving cannot self-repair, because in the
    broken state the launcher's own neighbour is exactly what such a rule finds.
    Select the anchor by tag name (`BUTTON`), never by child order.
* **Hover text uses a hand-built DSH-shaped bubble, not `title`.** The host's
  `Tooltip` is a React component that cannot be reused here, so its *rendered
  result* is reproduced: `position:fixed`, the real tooltip tokens, `role="tooltip"`,
  a 500ms hover delay (the host's `delayMs: 500`), appended to `document.body`. A
  native `title` would draw an OS bubble that looks nothing like the one on the
  neighbouring host controls — and, had it been appended into `headerActions`,
  would itself have caused the displacement above.
* `_sectionHeader` / `_headerActions` are **unique to this package** (checked
  across every extracted UI bundle), so suffix matching cannot collide.

### The workspace row has NO slot (verified negative finding — twice over)

`dsh-client-ui-workspace/lib/client.js`:

* `ProjectRowItem` (≈L1270–1377) is the workspace row. Its action cell
  (`rowActions`, ≈L1314–1359) is **hardcoded**: `Menu` anchored on
  `IconEllipsisOutlineRegular` (rename/delete) then a `Tooltip` +
  `IconNewChatOutlineRegular` (new session). No slot, no extendable prop.
* The folder icon is hardcoded at ≈L1299–1302:
  `IconFolderOpenRegular` / `IconFolderCloseRegular`.
* The hover card is `WorkspaceHoverContent` (≈L1232–1250) rendering
  `hoverTitle` (label), `hoverPath` (cwd), `hoverTime`; attached only when
  `row.createdAt !== undefined`.
* Rows carry `data-row-key="workspace:<key>"`; the class names are hashed CSS
  modules but the semantic suffixes are stable (`projectRow`, `rowActions`,
  `folder`, `iconButton`, `hoverPath`, `hoverContent`).

**Second confirmation.** The package's own module doc says it outright:
"Workspace row menus are **visual-only except Rename/Delete**. A **Session**
row's `...` menu and its hover buttons are the `sidebar.workspaces.session.menu.item`
and `sidebar.workspaces.session.row.action` lists … **this package's own actions
are entries like any plugin's**." So *session* rows are extendable; *workspace*
rows are not, and no slot for them appears anywhere in the 90-slot catalog
(`sidebar.workspaces.session.menu.item` exists, `…workspace.menu.item` does not).
Requirement 6's "Delete Codespace…" therefore cannot be a slot contribution and
**must** be a DOM-injected menu item — which is what the client half does.

**Therefore the row icon, the extra action button, and the hover "location"
line are done by DOM augmentation** — the same technique `dsh-pet` uses for the
hardcoded settings nav icon. Rules:

* Never remove or replace a React-owned node; that causes `NotFoundError` on
  unmount. Hide with CSS and inject our own element, or rewrite only text.
* One `MutationObserver` on the sidebar container, coalesced through a
  microtask/rAF queue. Never observe inside our own mutation without a guard.
* Tag everything with `data-dsh-codespace-*` attributes so we can find and undo
  it. Remove every node, attribute, style and observer on dispose.
* Read the row identity from `data-row-key`, then map it to a workspace id via
  our own host query — do not scrape titles as identity.

### Lifecycle events we may rely on

* `agent/created` (serial) — per-agent setup.
* `turn/end`, `assistant/message`, `tool/result` — durable; use these to start
  the auto-pause countdown. Do **not** poll `agent/status`.
* `app-boot/config-reload` — the composition changed.
* **Settings change events are NOT what an earlier draft of this file said.**
  Grepping `@deepseek-ai/dsh-settings` for its event names yields exactly two:
  **`settings/document-updated`** and `settings/redact`. There is **no**
  `settings/updated` event, and there is **no** `settings.register()` in
  0.2.0-rc.2 (settings come from the plugin's own `Config`, per §2).
  This is moot for the current design — the host reads the live config through
  its `getSettings()` accessor on every use rather than caching it or
  subscribing to an event — but do not reintroduce `settings/updated`.
* **App shutdown — VERIFIED, use this (no guessing).** Read out of
  `@deepseek-ai/dsh/lib/profile-boot-*.js` (`runProfile`) and
  `@deepseek-ai/dsh-app-boot` (`createProcessShutdown`, `installFailLoud`).
  There is **no** `app-boot/shutdown` event and no Electron `before-quit` on the
  Host side. The Host's whole teardown is:

  1. `dispose()` in `runProfile` awaits `app.current.fiber.dispose()`
     (`profile-boot-*.js` ≈L230–239). **Every `ctx.effect` cleanup and every
     `ctx.on` disposer of every plugin on the root fiber runs here.** This is
     the only reliable hook, and it is *ours*: a `ctx.effect(() => () => …)`
     whose cleanup is `async` **is awaited** by `fiber.dispose()`, because
     cordis collects effect disposers and awaits them.
  2. It is triggered by exactly three paths:
     * `process.on("SIGTERM")` / `process.on("SIGINT")` (≈L249–254) →
       `shutdown.interrupt(code)`.
     * `installFailLoud` on an unhandled rejection / uncaught exception
       (≈L255–257) → awaited `release()` under a **2 s** budget
       (`FAIL_LOUD_RELEASE_TIMEOUT_MS = 2000`).
     * The Desktop Host child on `process.on("message", {type:"shutdown"})` and
       `process.once("disconnect")` (`dsh-desktop-host/lib/index.js` ≈L258–262,
       L320–322) → `application.shutdown.shutdown(0)`.
  3. `createProcessShutdown` arms a hard `PROCESS_SHUTDOWN_TIMEOUT_MS = 5000`
     timer that calls `process.exit(code)` if `dispose()` has not settled.
     On the SIGINT path `forceAfterDispose` is true, so the process exits as
     soon as dispose resolves — there is no extra grace.

  **Consequences the host half must respect (these are requirements, not
  advice):**
  * Put the auto-stop in a single `ctx.effect(() => () => stopAllOnExit())`
    on the root context. That is the *only* place guaranteed to run.
  * The budget is real: **≤ 5 s total**, and only **≤ 2 s** on the crash path.
    `stopAllOnExit()` must therefore (a) be idempotent, (b) issue all stop
    requests **concurrently** (`Promise.allSettled`), (c) bound each request
    with `AbortSignal.timeout(~3500)`, and (d) **never reject** — a rejected
    disposer makes `runProfile` throw an `AggregateError` and the crash path
    `exit(1)`.
  * Do **not** try to register a second `process.on("SIGTERM")`: the launcher
    already owns those, and a listener that calls `process.exit()` itself would
    cut the teardown short.
  * Record the fact that a stop is *attempted but unfinished* (a small file
    under the plugin's storage, or a `console` line) so the next boot's
    "leftover running codespaces" prompt can also cover a codespace whose stop
    request did not complete. Requirement 4's startup prompt is the safety net
    for this path.

  **Implementation status — verified by `test/shutdown.mjs` (31 checks).** Every
  bullet above is now asserted against the real `CodespaceManager` with only
  `fetch` stubbed: both managed Codespaces are asked to stop; the two stops
  overlap (two 300 ms stops land inside 550 ms, so they are not serial); a 500,
  a transport failure, a hang and a missing token all leave the disposer
  **resolved**; the hang is cut off after the 3.5 s per-request budget and the
  whole call still lands inside 5 s; a second `stopAll` issues no further
  requests; unconfirmed names land in `pending-stop.json`.

  Two traps worth keeping in mind if this test is ever rewritten:

  * The "API hangs" case **must** use a real socket (a local `http` server that
    accepts and never replies), not a stubbed `fetch`. Node's
    `AbortSignal.timeout()` timer is **unref'd**: a stub returning a
    never-settling promise holds no ref'd handle, so the process drains and
    exits before the abort can fire. That produces a *false* result in either
    direction depending on what else is pending. Verified separately that
    against a real silent socket `api()` throws `E_TIMEOUT` at 1215 ms for a
    1200 ms budget.
  * The still-unverified layer is only whether the *live* GitHub API accepts the
    stop call — that depends on the token and the account, not on this logic.
    Likewise, "the harness awaits the root effect disposer" is established by
    reading `runProfile` / cordis `_unload`, not by watching a real exit; there
    is no reproducible Codespace target on this machine for an end-to-end
    observation.

## 3. Codespaces environment facts

* `gh` (GitHub CLI) is **NOT installed** on this machine. `git` and `ssh` are.
  The plugin must detect this, work without it where possible, and say so
  plainly in the UI and in tool errors — never crash.
* Data plane preference:
  1. `gh codespace ssh -c <name> -- sh -lc '<cmd>'` when `gh` exists. The command
     is quoted by `shq()` into ONE argv element after `sh -lc`, so it survives
     `gh`'s argv forwarding and the remote shell re-splits nothing.
  2. otherwise a direct `ssh` invocation against an **ssh-config host alias** the
     user configured (settings field `sshKeyPath`), failing with a clear message.

  **The `sshKeyPath` name is a requirement-1 label, not a transport fact.** A
  private key path alone cannot name a host, so the value is consumed as an
  ssh-config alias and a path-shaped value is rejected with the fix spelled out
  ("put a Host entry in ~/.ssh/config and use that alias here, or install the
  GitHub CLI"). The UI hint says this; do not let it drift back to claiming a
  bare key path works. `shq` is verified against real bash: 20 byte-for-byte
  round-trips (spaces, quotes, `$`, backticks, `$(…)`, `;`, `&&`, `|`, globs,
  newlines, tabs, backslashes, unicode, empty) plus 5 hostile payloads that all
  stay exactly one shell word with no injection side effect.
* Control plane: GitHub REST over `https://api.github.com` with
  `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`.
  Token resolution order: settings token → `GITHUB_TOKEN` env → `gh auth token`
  → none.
* Key endpoints (verified against the official REST docs):
  * `GET /user`, `GET /user/repos`
  * `GET /user/codespaces`, `GET /repos/{o}/{r}/codespaces` → `{ total_count, codespaces: [...] }`
  * `GET /repos/{o}/{r}/codespaces/machines?ref=<branch>` → `{ machines: [...] }`
  * `GET /repos/{o}/{r}/codespaces/devcontainers` → `{ devcontainers: [{path,name,display_name}] }`
  * `GET /repos/{o}/{r}/codespaces/new` → `{ billable_owner, defaults: { location, devcontainer_path } }`
  * `POST /repos/{o}/{r}/codespaces` (create; body `{ ref, machine, display_name, idle_timeout_minutes, geo }`;
    **201** ok, **202** partial-but-retrying — treat both as success)
  * `POST /user/codespaces/{n}/start` (may return **402** quota/payment, **409** state conflict)
  * `POST /user/codespaces/{n}/stop`, `DELETE /user/codespaces/{n}` (**202**, body `{}`)
  * `PATCH /user/codespaces/{n}` accepts only `machine`, `display_name`, `recent_folders` —
    **idle timeout is not patchable**, so pass `idle_timeout_minutes` at create time only
* **Empty repository**: creating a codespace from a repo with no commits fails. Fix by
  committing a README through the Contents API
  (`PUT /repos/{o}/{r}/contents/README.md` with base64 `content` and `message`;
  no `branch` for the initial commit) before creating the codespace.
* Codespace states are the REST `state` enum, exact spelling:
  `Unknown | Created | Queued | Provisioning | Available | Awaiting | Unavailable |
  Deleted | Moved | Shutdown | Archived | Starting | ShuttingDown | Failed |
  Exporting | Updating | Rebuilding`.
  There is **no** `ShutDown` and no `Stopped`. `Available` = running;
  `Shutdown`/`Archived` = stopped; the rest are transitional or error.
  `lib/shared.js` `codespacePhase()` is the single mapping — verified by test.
* **Prebuild detection is the `prebuild_availability` field on the machine object**,
  *not* on `/codespaces/new` (that endpoint carries no prebuild field):
  `GET /repos/{o}/{r}/codespaces/machines?ref=<branch>` →
  `machines[].prebuild_availability: 'none' | 'ready' | 'in_progress' | null`.
  `ready` ⇒ true; all `none`/`null` ⇒ false; `in_progress`, empty list, or any failure
  ⇒ `null` (unknown), which must take the same branch as "no prebuild" and show the
  slow-creation notice.
* Machines: `{ name, display_name, operating_system, cpus, memory_in_bytes,
  storage_in_bytes, prebuild_availability }`. Smallest = fewest `cpus`, then least
  `memory_in_bytes`, then least `storage_in_bytes`.
* `gh codespace ssh -c <name> -- sh -lc <one-argv-command>` is the data-plane
  primitive when `gh` exists. `gh codespace create` has no `--json` and prints the new
  codespace name; its flags are `-b/--branch`, `-d/--display-name`, `-m/--machine`,
  `-R/--repo`, `--idle-timeout <duration e.g. 30m>`, `--default-permissions`,
  `--devcontainer-path`, `-l/--location`, `--retention-period`, `-s/--status`, `-w/--web`.

## 4. Design decisions (settled — implement these)

1. **Placeholder workspace directories.** A Codespace workspace is registered in
   DSH's own registry as a real local directory:
   `<profileHome>/codespaces/<codespace-name>/`. It exists on disk (required by
   `realpath`) and is empty. The session `cwd` is that path, so DSH's own
   workspace/session machinery works untouched.
2. **Routing, not global replacement.** Every remote capability decides by
   looking at the session cwd / placeholder prefix. Nothing global is replaced,
   so other sessions and other plugins are unaffected (requirement 8).
3. **Per-agent shadow tools.** On `agent/created`, if the session cwd is under
   our placeholder root, register remote implementations of the file and shell
   tools on `agent.ctx`, and restrict the local counterparts. This is the
   supported per-agent seam.
4. **One multi-step window.** The create flow is a single `shell.overlay`
   component with internal steps (repo → codespace → prebuild notice → machine),
   never a stack of dialogs.
5. **Auto-pause is per workspace.** One timer per managed codespace, started on
   `turn/end`, cleared on any new user message (`user/message`), on cancel, and
   on dispose. Double-click pauses immediately.
6. **No Git wrapping.** The plugin never runs `git push` for the user; it only
   injects one prompt rule at session creation telling the agent to push.
7. **Shutdown stop.** Managed codespaces are stopped on DSH shutdown, from an
   idempotent teardown with a bounded timeout, and the outcome is logged.
8. **Never block the UI.** Every host RPC returns within a bounded time, reports
   failures as `{ ok: false, error: { message, code } }`, and never throws
   across the wire.

## 5. File layout and ownership

```
dsh-codespace-workspace/
  package.json            [done]
  cordis.patch.yml        [host]
  icon.svg                [host]
  lib/
    shared.js             [host]  RPC route + action names + state maps, no imports
    index.js              [host]  apply(), Config, inject, wiring
    host/
      github.js           [host]  REST client + token resolution
      gh.js               [host]  gh CLI detection/invocation
      codespaces.js       [host]  lifecycle, machines, prebuild, empty-repo fix
      transport.js        [host]  remote exec + base64 file read/write
      remote-tools.js     [host]  shadow tool definitions for a Codespace agent
      session.js          [host]  agent/created, prompt rule, auto-pause, shutdown
      routes.js           [host]  the RPC route
    client.js             [client] self-contained bundle
  locale/en.json          [client]
  locale/zh.json          [client]
  README.md  LICENSE  .gitignore  docs/   [me]
```

`lib/client.js` must be self-contained: no imports other than `react`.

## 6. RPC contract (frozen — both halves code against this)

Transport: `POST /api/dsh-codespace-workspace/rpc`, JSON body
`{ action: string, ...payload }`. Response is always HTTP 200 with
`{ ok: true, ...data }` or `{ ok: false, error: { code, message } }`.

| action | payload | success data |
|---|---|---|
| `status` | — | `{ gh: {installed, version, authenticated, login}, tokenSource, configured }` |
| `get-settings` | — | `{ settings, revision }` |
| `set-settings` | `{ patch }` | `{ settings, revision }` |
| `list-repos` | — | `{ repos: [{name, nameWithOwner, isPrivate, isEmpty, defaultBranch}] }` |
| `list-codespaces` | `{ repo? }` | `{ codespaces: [Codespace] }` |
| `machines` | `{ repo }` | `{ machines: [{name, displayName, cpus, memoryGb, storageGb, gpu}] }` |
| `prebuild` | `{ repo }` | `{ hasPrebuild: boolean \| null }` |
| `create` | `{ repo, branch?, machine?, displayName? }` | `{ codespace: Codespace }` |
| `start` | `{ name }` | `{ codespace: Codespace }` |
| `stop` | `{ name }` | `{ codespace: Codespace }` |
| `remove` | `{ name }` | `{}` |
| `pause-cancel` | `{ name }` | `{ autoPause: null }` |
| `pause-now` | `{ name }` | `{}` |
| `workspaces` | — | `{ workspaces: [Managed] }` |
| `create-workspace` | `{ codespace, title? }` | `{ workspace: Managed }` |
| `remove-workspace` | `{ workspaceId, deleteCodespace? }` | `{}` |

```
Codespace = { name, displayName, repository, branch, state, machine,
              idleTimeoutMinutes, lastUsedAt, createdAt, webUrl, managed }
Managed   = { workspaceId, title, path, codespace, state, busy,
              autoPauseRemainingMs, autoPauseDeadline }
```

Client-side polling: `workspaces` every 4 s **while the workspace section is on
screen**, plus `status` once on settings-page mount. Poll with `setTimeout`
chains (never overlapping), and stop on dispose.

The poll is not free — with at least one managed workspace every tick calls the
Codespaces list API — so it is gated on an explicit owner claim: the store's
`subscribe(listener, owns)` increments a counter when `owns === true`, triggers
an immediate `refresh()` on the first claim, and stops the chain when the last
owner leaves. The claim is held by the **row-augmentation module**, which is
what renders the launcher, the row buttons and the countdown, so the data is
owned by the thing that consumes it. It is deliberately not keyed on the record
list (the records are what the poll produces — that would be circular) and it is
released in that module's disposer, so unloading the plugin stops the poll. The
same module loads the settings once per session, because `alwaysShowCloudButton`
is read by the row patch and would otherwise stay unloaded until the settings
page was opened.

### Guards on the request (fallback carrier only)

On the preferred `connection.fetch` carrier DSH applies these itself, and this
plugin adds none. The list below describes the **fallback** `webServer` exact
route, which must apply the fence itself because it shadows `/api`.

Order: `405` wrong method → `403` non-loopback peer → `403` fence → `415` wrong
content-type → `400` unparseable body → **`200` with `{ok:false}`** for every
action outcome. An action failure is *data*, never a transport status.

The fence is a faithful port of `isTrustedApiRequest` from
`@deepseek-ai/dsh-client-connection`, and it must **not** be stricter:

* `Host` must parse and its hostname must be loopback — `localhost`, `[::1]`, or
  **any** `127/8` address (not just `127.0.0.1`).
* `Sec-Fetch-Site: cross-site` is refused.
* **An absent `Origin` is ACCEPTED** (`if (origin === void 0) return true`).
  When present, `new URL(origin).host` must equal the request's Host.

That last rule is load-bearing and was gotten wrong once: the desktop shell
carrier sends neither `Origin` nor Fetch-Metadata, so requiring an Origin
rejected the entire desktop app with `状态读取失败：Requests must be same-origin.`
while the Web GUI (which does send `Origin`) worked fine. The load-bearing check
is the **Host**, the one header DNS rebinding cannot forge.

## 7. Internal module interfaces (frozen — code against these)

`lib/shared.js` is written already; read it before coding.

### `lib/host/github.js`

```js
/** Resolve a token. Order: settings → GITHUB_TOKEN → `gh auth token` → null. */
export async function resolveToken(ctx, settings)   // → { token: string|null, source: 'settings'|'env'|'gh'|'none' }

/** One REST call. Throws an Error carrying `.code` and `.status`. */
export async function api(token, method, path, body, options)
  // options: { signal, timeoutMs, retry, run }  → parsed JSON (or {} for 204)

export async function getViewer(token)              // → { login, name }
export async function listRepos(token)              // → [{ name, nameWithOwner, owner, isPrivate, isEmpty, defaultBranch }]
export async function listCodespaces(token, repo?)  // → Codespace[]  (raw, normalized)
export async function listMachines(token, repo)     // → [{ name, displayName, cpus, memoryGb, storageGb, gpu }]
export async function getPrebuild(token, repo)      // → boolean|null   (null = could not determine)
export async function createCodespace(token, { repo, branch, machine, displayName, idleTimeoutMinutes })
export async function startCodespace(token, name)
export async function stopCodespace(token, name, options)
  // options: { signal, timeoutMs, retry } — shutdown passes { retry: false } so a
  // doomed call cannot consume the whole exit budget retrying.
export async function deleteCodespace(token, name)
/** Commit a README into a repo with no commits. */
export async function seedEmptyRepo(token, { repo, branch, content })
```

`api()` must: set `Authorization: Bearer`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`, `User-Agent`; honour the standard
`x-ratelimit-remaining`/`retry-after` for a single bounded retry; and never put
the token in a thrown message.

### `lib/host/gh.js`

```js
export async function ghInfo(run)        // → { installed, version, authenticated, login }
export async function ghExec(run, codespaceName, command, { timeoutMs, signal })
                                          // → { stdout, stderr, exitCode }
export function ghAvailable(info)         // → boolean
```

`run` is an injected executor `(command, args, opts) => Promise<{stdout,stderr,exitCode}>`
so the module is testable and so the caller owns timeouts. Detection must not
throw when `gh` is absent — return `{ installed: false, … }`.

### `lib/host/transport.js`

```js
/**
 * Run a command inside a Codespace. Prefers `gh codespace ssh`; falls back to
 * a user-configured ssh alias. Returns a ShellRunResult-shaped object.
 */
export async function remoteExec(target, command, opts)
  // → { stdout, stderr, exitCode, timedOut, aborted }

/** Read a remote file as UTF-8 text. Throws E_REMOTE_* on failure. */
export async function remoteReadText(target, path, opts)     // → { text, size, truncated }
/** Atomically write UTF-8 text to a remote path. */
export async function remoteWriteText(target, path, content, opts)
/** List a remote directory: content-free entries. */
export async function remoteListDir(target, path, opts)      // → [{ name, type: 'file'|'dir'|'other', size }]
/** Stat one remote path. */
export async function remoteStat(target, path, opts)         // → { type, size, mtimeMs } | null
/** Normalize an arbitrary path against the remote cwd (POSIX). */
export function remoteResolve(cwd, input)                    // → absolute POSIX path
```

`target` is `{ kind: 'gh'|'ssh', codespace?, alias?, cwd }`. All commands are
sent as a single POSIX shell word list through `sh -lc` with arguments
`JSON.stringify`-quoted then single-quoted — **never** by string interpolation
of a raw path. Binary safety: file writes go through base64
(`printf %s <b64> | base64 -d > <path>`), reads through `base64 -w0`.

### `lib/host/codespaces.js`

Owns: placeholder directory creation, the managed-workspace record, the
auto-pause timers, and the mapping between a DSH workspace id and a Codespace.

```js
export class CodespaceManager {
  constructor(ctx, options)
  async status()                      // → { gh, tokenSource, configured }
  async listWorkspaces()              // → Managed[]
  async createWorkspace({ codespace, title })
  async removeWorkspace({ workspaceId, deleteCodespace })
  async start(name) / async stop(name) / async remove(name)
  async listRepos() / async listCodespaces(repo) / async machines(repo) / async prebuild(repo)
  async create({ repo, branch, machine, displayName })
  /** Called on turn/end. Starts or restarts this workspace's countdown. */
  armAutoPause(workspaceId)
  /** Called on any user message. Cancels this workspace's countdown. */
  cancelAutoPause(workspaceId)
  async pauseNow(workspaceId)
  /** Idempotent; stops every managed Codespace. Bounded. */
  async stopAll(reason)
  isCodespacePath(cwd)                // → workspaceId | undefined
  dispose()
}
```

### `lib/host/remote-tools.js`

```js
/** Register the remote tool surface on one agent's scope. */
export function installRemoteTools(agent, { manager, workspaceId, target, localToolNames })
  // → dispose function
```

Must register `read`, `write`, `edit`, `glob`, `grep`, `bash` in the agent
scope and restrict the local counterparts. It receives the agent context and
must do all registration inside one `agent.ctx.effect()`.

### `lib/host/session.js`

```js
export function installSessionWiring(ctx, manager)   // → dispose
```

Wires `agent/created`, the prompt section, `turn/end` → `armAutoPause`, user
messages → `cancelAutoPause`, and shutdown → `stopAll`.

## 8. Rules for both halves

* Plain ESM JavaScript. No TypeScript, no build step. Both files must parse as
  ES modules under Node 22 (`node --check` is not enough for the client bundle,
  which is CJS-in-a-factory — check it by loading it in a stub harness).
* Never print, log, or send a token, key, or credential. Settings responses
  must redact the token and the SSH key (`secrets` markers only).
* No `any`-style defensive silence: if a fact could not be verified against the
  installed build, implement the tolerant branch and leave a `VERIFY:` comment.
* Every registration goes through `ctx.effect`/`ctx.on` and returns a cleanup.
* Idempotent teardown everywhere.
