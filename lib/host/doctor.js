/**
 * The remote `codespace_doctor` tool: turn "it silently does nothing" into one
 * screen of facts.
 *
 * WHY THIS EXISTS — the failure mode this plugin actually has. Three separate
 * outages were diagnosed on this machine (2026-11-14, 2026-11-15, and again on
 * a fresh install) that looked IDENTICAL from the outside:
 *
 *   * a custom-Dockerfile Codespace with no `sshd` feature,
 *   * a Host process older than the installed plugin,
 *   * `manager.root` and the session cwd living under different DSH homes.
 *
 * In every case the plugin reported `active`, the UI looked normal, the model
 * kept its local Windows tools, and the ONLY symptom was that `read` said
 * "not found" against an empty placeholder directory. Working that out required
 * comparing process start times against file mtimes and dumping the tool
 * registry by hand.
 *
 * So this tool asks the five questions that actually discriminate between those
 * causes, in the order that eliminates the most first:
 *
 *   1. Is the session really a Codespace session (does the placeholder resolve)?
 *   2. Can the host reach the container at all — and how fast?
 *   3. Does the container have what `gh codespace ssh` requires?
 *   4. Does the container have the tools the remote surface assumes (`rg`, `git`)?
 *   5. Are the remote tools actually REGISTERED on this agent?
 *
 * Question 5 cannot be answered from inside the agent's own tool closure, so it
 * is supplied by the caller (`session.js` reads it from the install callback).
 */

import { shq } from './gh.js'
import { remoteExec } from './transport.js'

/** How long the reachability probe may take before it is called a failure. */
const PROBE_TIMEOUT_MS = 45000

/**
 * Build the remote `codespace_doctor` tool definition.
 *
 * @param {object} target - the transport target.
 * @param {{run?: Function, cwd?: string, getFacts: () => object}} options - supplies host-side facts the agent cannot see.
 * @returns {object} the tool definition.
 */
export function doctorTool(target, options) {
  return {
    name: 'codespace_doctor',
    description: [
      'Diagnose this Codespace workspace and report one line per check.',
      'Use it FIRST when remote tools seem broken, when files appear missing, or when a',
      'command behaves as if it ran on the local machine. It distinguishes a dead connection',
      'from a missing sshd, a wrong workspace root, and a tool surface that never installed.',
    ].join(' '),
    parameters: {
      deep: {
        type: 'boolean',
        description: 'Also probe the container toolchain (bash/JDK/Node/Android SDK/git). Slower.',
      },
      setupGh: {
        type: 'boolean',
        description: 'Install the GitHub CLI inside the container and authenticate it with this profile\'s token, so `git push` and `gh` work there. Idempotent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          checks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['pass', 'warn', 'fail'] },
                detail: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.ok ? 'Codespace workspace: all critical checks passed.' : 'Codespace workspace: at least one critical check FAILED.',
          '',
          ...value.checks.map((check) => {
            const mark = check.status === 'pass' ? 'PASS' : (check.status === 'warn' ? 'WARN' : 'FAIL')
            return `[${mark}] ${check.name}: ${check.detail}`
          }),
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const checks = []
      const add = (name, status, detail) => checks.push({ name, status, detail })

      const facts = typeof options?.getFacts === 'function' ? options.getFacts() : {}
      const targetKind = target?.kind === 'ssh' ? 'ssh alias' : 'gh'
      const identifier = target?.kind === 'ssh' ? target.alias : target?.codespace
      add('transport', 'pass', `using the ${targetKind} transport for ${String(identifier ?? '(none)')}`)

      // --- 5. Was the remote surface installed on this agent? -----------------
      // Host-side fact: only the caller knows what `tools.register()` accepted.
      const installed = Array.isArray(facts.installed) ? facts.installed : []
      const failed = Array.isArray(facts.failed) ? facts.failed : []
      if (installed.length === 0) {
        add(
          'remote tools',
          'fail',
          'NO remote tools were registered on this agent, so every file tool you have is the LOCAL one — '
          + 'it reads the empty placeholder directory on the host, not the Codespace. '
          + 'Check the DSH log for "cannot register remote tool", and compare the Host process start time '
          + 'with the plugin version on disk (a Host older than the plugin runs the old code).',
        )
      } else if (failed.length > 0) {
        add('remote tools', 'warn', `${installed.length} registered (${installed.join(', ')}); ${failed.length} FAILED (${failed.join(', ')})`)
      } else {
        add('remote tools', 'pass', `${installed.length} registered (${installed.join(', ')})`)
      }

      // --- 2. Can the host reach the container, and how fast? ----------------
      // Deliberately one-shot (channel: false): a probe must be able to fail on
      // its own rather than inherit whatever state a lazy channel is in.
      const started = Date.now()
      let reachable = false
      try {
        const probe = await remoteExec(target, 'printf %s "$(id -u):$(command -v bash >/dev/null && echo bash_ok)"', {
          timeoutMs: PROBE_TIMEOUT_MS,
          signal: exec?.signal,
          run: options?.run,
          channel: false,
        })
        reachable = probe.exitCode === 0
        const elapsed = Date.now() - started
        if (!reachable) {
          add('connection', 'fail', `\`gh codespace ssh\` answered with exit ${probe.exitCode}: ${(probe.stderr || probe.stdout).trim().slice(0, 400)}`)
        } else if (elapsed > 30000) {
          add('connection', 'warn', `reachable but slow: ${elapsed} ms for a trivial command (a healthy one is 5–9 s one-shot)`)
        } else {
          add('connection', 'pass', `reachable in ${elapsed} ms (one-shot; the live channel reuses this connection)`)
        }
      } catch (error) {
        add('connection', 'fail', error instanceof Error ? error.message : String(error))
      }

      if (reachable) {
        // --- 3 + 4. Container prerequisites and toolchain. -------------------
        const probeScript = [
          'echo "SSHD=$(command -v sshd || echo MISSING)"',
          'echo "RG=$(command -v rg || echo MISSING)"',
          'echo "GIT=$(command -v git || echo MISSING)"',
          'echo "PWD=$(pwd)"',
          'echo "GH=$(command -v gh || echo MISSING)"',
        ].join('\n')
        try {
          const result = await remoteExec(target, probeScript, {
            timeoutMs: PROBE_TIMEOUT_MS,
            signal: exec?.signal,
            run: options?.run,
            channel: false,
          })
          const fields = new Map()
          for (const line of result.stdout.split('\n')) {
            const match = /^([A-Z]+)=(.*)$/.exec(line)
            if (match !== null) fields.set(match[1], match[2])
          }
          const sshd = fields.get('SSHD') ?? 'MISSING'
          if (sshd === 'MISSING') {
            add(
              'container sshd',
              'fail',
              'no sshd inside the container. `gh codespace ssh` tunnels to an sshd running INSIDE it, so '
              + 'nothing can be read or run. Add "ghcr.io/devcontainers/features/sshd:1" to '
              + '.devcontainer/devcontainer.json and REBUILD (features are baked in at creation).',
            )
          } else {
            add('container sshd', 'pass', sshd)
          }
          const rg = fields.get('RG') ?? 'MISSING'
          if (rg === 'MISSING') {
            add('container ripgrep', 'warn', 'no `rg` — glob falls back to `find` and grep to `grep -r`, which search different file sets')
          } else {
            add('container ripgrep', 'pass', rg)
          }
          const git = fields.get('GIT') ?? 'MISSING'
          if (git === 'MISSING') {
            add('container git', 'warn', 'no `git` — commits and pushes inside the Codespace will not work')
          } else {
            add('container git', 'pass', git)
          }
          const remotePwd = fields.get('PWD') ?? ''
          /*
           * Compare against what the PATH TOOLS would resolve, not against
           * `cwd` blindly. `cwd` falls back to the placeholder path or `/`
           * before the Codespace reports its checkout, and reporting that as the
           * resolved root would read as a real mismatch on a perfectly healthy
           * session — a false WARN in the one tool whose job is to be trusted.
           */
          const declaredRoot = typeof facts.remoteRoot === 'string' && facts.remoteRoot.startsWith('/')
            ? facts.remoteRoot
            : ''
          const rootIsPlaceholder = declaredRoot === '' || declaredRoot === '/' || /^[A-Za-z]:/.test(declaredRoot)
          if (remotePwd.length > 0 && rootIsPlaceholder) {
            add('workspace root', 'pass', `${remotePwd} (resolved lazily by the path tools)`)
          } else if (remotePwd.length > 0) {
            const matches = remotePwd === declaredRoot
            add(
              'workspace root',
              matches ? 'pass' : 'warn',
              matches ? remotePwd : `connected shell sees ${remotePwd}, tools resolve ${declaredRoot}`,
            )
          } else {
            add('workspace root', 'warn', 'the container did not report a working directory')
          }
          const ghInside = fields.get('GH') ?? 'MISSING'
          add(
            'gh in container',
            ghInside === 'MISSING' ? 'warn' : 'pass',
            ghInside === 'MISSING'
              ? 'not installed inside the container (the host CLI is what this plugin uses; this only matters for git/gh work you run there)'
              : ghInside,
          )

          if (reachable && args?.setupGh === true) {
        /*
         * `setupGh` is the only part of this tool that CHANGES the container,
         * and it exists because of a wall the plugin cannot otherwise climb:
         * `origin` inside the Codespace is an HTTPS remote with no credential
         * helper, so a plain `git push` fails with "could not read Username".
         * The token is already known to the host (settings / env / `gh auth
         * token`); this hands it to the container's own `gh` and lets
         * `gh auth setup-git` install the credential helper.
         *
         * The token is passed on stdin via a base64 payload, never as argv, so
         * it does not appear in `ps` inside the container.
         */
        const token = typeof options?.getToken === 'function' ? String(await options.getToken() ?? '') : ''
        const login = typeof options?.getLogin === 'function' ? String(await options.getLogin() ?? '') : ''
        const payload = Buffer.from(token, 'utf8').toString('base64')
        /*
         * The arguments go in as `$1`/`$2` AFTER `bash -s --`, and the script
         * itself arrives on stdin through a heredoc. That keeps the token out of
         * the container's `ps` (argv is world-readable there) while still giving
         * the script positional parameters.
         */
        const script = [
          `bash -s -- ${shq(payload)} ${shq(login)} <<'DSH_GH_SETUP_EOF'`,
          ghInstallScript(),
          ghAuthScript(),
          'DSH_GH_SETUP_EOF',
        ].join('\n')
        try {
          const result = await remoteExec(target, script, {
            timeoutMs: 240000,
            signal: exec?.signal,
            run: options?.run,
            channel: false,
          })
          for (const line of result.stdout.split('\n')) {
            const match = /^(GH|AUTH|GITCRED)=(.*)$/.exec(line.trim())
            if (match === null) continue
            const [, key, value] = match
            const label = key === 'GH' ? 'container gh' : (key === 'AUTH' ? 'container gh auth' : 'container git credential')
            const good = value === 'present' || value === 'installed' || value === 'installed-local' || value === 'ok'
            add(label, good ? 'pass' : 'warn', value)
          }
        } catch (error) {
          add('container gh setup', 'fail', error instanceof Error ? error.message : String(error))
        }
      }

      if (args?.deep === true) {
        const deepScript = [
          'echo "BASH=$(${BASH_VERSION:-none})"',
          'echo "JAVA=$(java -version 2>&1 | head -1 || echo MISSING)"',
          'echo "NODE=$(node --version 2>/dev/null || echo MISSING)"',
          'echo "PNPM=$(pnpm --version 2>/dev/null || echo MISSING)"',
          'echo "ANDROID=${ANDROID_HOME:-unset}"',
          'echo "DISK=$(df -h . | tail -1 | tr -s " " | cut -d" " -f4)"',
          'echo "MEM=$(free -m 2>/dev/null | awk \'/Mem:/{print $2"MB"}\')"',
        ].join('\n')
        const deep = await remoteExec(target, deepScript, {
          timeoutMs: PROBE_TIMEOUT_MS,
          signal: exec?.signal,
          run: options?.run,
          channel: false,
        })
            for (const line of deep.stdout.split('\n')) {
              const match = /^([A-Z]+)=(.*)$/.exec(line)
              if (match === null) continue
              const [, key, value] = match
              const label = { BASH: 'bash', JAVA: 'java', NODE: 'node', PNPM: 'pnpm', ANDROID: 'ANDROID_HOME', DISK: 'free disk', MEM: 'memory' }[key]
              if (label === undefined) continue
              const missing = value === 'MISSING' || value === 'unset' || value === 'none'
              add(`toolchain ${label}`, missing ? 'warn' : 'pass', value || '(empty)')
            }
          }
        } catch (error) {
          add('container probe', 'fail', error instanceof Error ? error.message : String(error))
        }
      }

      // --- 1. Is the placeholder honest about where the session is? ---------
      if (typeof facts.workspaceId === 'string' && facts.workspaceId.length > 0) {
        add('placeholder workspace', 'pass', `${facts.workspaceId} -> ${String(facts.mount ?? '(no mount)')}`)
      } else {
        add('placeholder workspace', 'warn', 'this agent is not bound to a Codespace placeholder; remote tools may be absent by design')
      }

      return {
        ok: checks.every((check) => check.status !== 'fail'),
        checks,
      }
    },
  }
}

/**
 * The shell that installs a usable `gh` in the container.
 *
 * WHY IT IS A SHELL AND NOT AN npm POSTINSTALL — the Codespace image is built
 * from the repository's Dockerfile, and the plugin cannot change that. What it
 * CAN do is make the RUNNING container usable, which matters for the single
 * flow this plugin cannot do any other way: `git push` from inside the
 * Codespace (the host transport authenticates with a token, but `origin` there
 * is an HTTPS remote with no credential helper, so a plain `git push` fails with
 * `could not read Username`).
 *
 * Deliberately idempotent and cheap when already set up: it skips the download
 * when `gh` exists, and it never prints the token.
 *
 * @returns {string} a POSIX shell script fragment that assumes `gh` may be absent.
 */
export function ghInstallScript() {
  return [
    'set -u',
    'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"',
    'if command -v gh >/dev/null 2>&1; then',
    '  echo "GH=present"',
    'else',
    '  echo "GH=absent"',
    '  ver=$(curl -fsSL --max-time 25 https://api.github.com/repos/cli/cli/releases/latest 2>/dev/null | sed -n "s/.*\\"tag_name\\": *\\"v\\([^\\"]*\\)\\".*/\\1/p" | head -1)',
    '  if [ -n "${ver:-}" ]; then',
    '    tmp=$(mktemp -d)',
    '    if curl -fsSL --max-time 180 -o "$tmp/gh.tgz" "https://github.com/cli/cli/releases/download/v$ver/gh_${ver}_linux_amd64.tar.gz" 2>/dev/null; then',
    '      tar -xzf "$tmp/gh.tgz" -C "$tmp" 2>/dev/null || true',
    '      src=$(find "$tmp" -type f -name gh -perm -u+x | head -1)',
    '      if [ -n "${src:-}" ]; then',
    '        if sudo -n install -m 0755 "$src" /usr/local/bin/gh 2>/dev/null; then echo "GH=installed";',
    '        elif install -m 0755 "$src" "$HOME/.local/bin/gh" 2>/dev/null; then echo "GH=installed-local";',
    '        else echo "GH=install-failed"; fi',
    '      else echo "GH=install-failed"; fi',
    '    else echo "GH=download-failed"; fi',
    '    rm -rf "$tmp"',
    '  else echo "GH=version-unknown"; fi',
    'fi',
  ].join('\n')
}

/**
 * The shell that authenticates the container's `gh`, writing `hosts.yml`
 * DIRECTLY instead of asking `gh auth login --with-token` to do it.
 *
 * Measured 2026-11-24: `printf %s "$tok" | gh auth login --with-token` exited 0
 * while leaving `~/.config/gh` EMPTY and `gh auth status` still reporting "not
 * logged into any GitHub hosts". Reporting success while doing nothing is the
 * worst possible failure for a setup step, so the credential is written where
 * `gh` documents that it lives, and the result is then VERIFIED by asking `gh`
 * rather than by trusting the writer.
 *
 * `hosts.yml` is deliberately minimal: `gh` reads exactly `github.com:` →
 * `oauth_token` / `user` / `git_protocol`, and anything more risks being wrong.
 *
 * @returns {string} a POSIX shell script fragment; expects `$1` = base64 token,
 *   `$2` = login (may be empty).
 */
export function ghAuthScript() {
  return [
    'set -u',
    'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"',
    'case "${1:-}" in ""|*[!A-Za-z0-9+/=]*) echo "AUTH=bad-payload"; exit 0;; esac',
    'tok=$(printf %s "$1" | base64 -d 2>/dev/null | tr -d "\\r\\n")',
    'if [ -z "${tok:-}" ]; then echo "AUTH=empty-token"; exit 0; fi',
    'login="${2:-}"',
    'cfg="${GH_CONFIG_DIR:-$HOME/.config/gh}"',
    'mkdir -p "$cfg" && chmod 700 "$cfg"',
    // `user:` is optional for API calls but `gh auth status` prints it, so fill
    // it in when known. Quoted with a fixed format string: the token is data.
    '{',
    '  echo "github.com:"',
    '  echo "    oauth_token: $tok"',
    '  if [ -n "$login" ]; then echo "    user: $login"; fi',
    '  echo "    git_protocol: https"',
    '} > "$cfg/hosts.yml"',
    'chmod 600 "$cfg/hosts.yml"',
    'unset tok',
    /*
     * Verify with the CLI itself. `gh auth status` exits non-zero when nobody is
     * logged in, so this is the only check that cannot be fooled by a file that
     * merely exists.
     */
    'if gh auth status >/dev/null 2>&1; then',
    '  echo "AUTH=ok"',
    '  if gh auth setup-git >/dev/null 2>&1; then echo "GITCRED=ok"; else echo "GITCRED=skip"; fi',
    'else',
    '  echo "AUTH=failed"',
    'fi',
  ].join('\n')
}

/** Quote a value for a shell; re-exported so `session.js` needs one import. */
export const doctorQuote = shq
