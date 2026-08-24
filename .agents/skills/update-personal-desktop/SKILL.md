---
name: update-personal-desktop
description: Update the personal Hermes Agent fork from NousResearch upstream while preserving its custom remote-desktop patches, validate the integration, and rebuild the local Linux Electron app used by the “Hermes (Personal)” launcher. Use for requests to pull or sync the latest Hermes changes, update the personal fork, rebuild or repackage the personal Desktop app, or verify that the reopened personal app is running the newest local build.
---

# Update Personal Hermes Desktop

Update this fork carefully. Preserve its personal behavior, integrate current
upstream intent, produce a clean local build, and leave the launcher usable.
The result is the latest upstream Desktop with the personal PR behavior layered
on top; it is not a separate frozen release line.

## Repository contract

- Work in `/home/zeus/projects/hermes-agent-personal`.
- Update branch `personal/remote-desktop`.
- Treat `origin` as the personal fork and `upstream` as
  `NousResearch/hermes-agent`.
- Merge `upstream/main`; do not rebase, reset, or replace personal history.
- Do not push to `origin` unless the user explicitly asks.
- Read the applicable root and `apps/desktop/AGENTS.md` instructions before
  resolving conflicts or building.
- Preserve unrelated user changes. Never discard a dirty worktree.

The installed launcher is
`~/.local/share/applications/hermes-personal.desktop`, named
`Hermes (Personal)`. Its expected executable is:

```text
/home/zeus/projects/hermes-agent-personal/apps/desktop/release/linux-unpacked/Hermes
```

## 1. Inspect before changing anything

Confirm the repository, branch, remotes, worktree, divergence, existing build,
launcher target, and running process.

```bash
git status --short --branch
git remote -v
git branch -vv
git log --oneline --decorate -12
sed -n '1,80p' ~/.local/share/applications/hermes-personal.desktop
pgrep -af '/home/zeus/projects/hermes-agent-personal/apps/desktop/release/linux-unpacked/Hermes' || true
```

If the branch is not `personal/remote-desktop`, stop and resolve the unexpected
state instead of switching or merging blindly. If the worktree is dirty, inspect
the diff and preserve it with a descriptive stash only when that is safe. Restore
the stash after integration. Never assume a generated lockfile change is
disposable.

## 2. Fetch and integrate upstream

```bash
git fetch upstream main
git rev-list --left-right --count HEAD...upstream/main
git merge --no-edit upstream/main
```

If the merge conflicts, resolve by behavior and history:

1. Inspect the conflict, both stages, nearby tests, and the personal commits
   that introduced the custom behavior.
2. Check whether upstream now implements the same user outcome.
3. Prefer the current upstream architecture when it supersedes an older
   personal implementation.
4. Reapply personal behavior that upstream still lacks.
5. Resolve the whole behavior class, not only conflict markers.

Personal behavior that currently remains intentional:

- Rewrite the Origin only for remote gateway WebSocket upgrades through
  `apps/desktop/electron/gateway-ws-origin.ts` and its main-process hook.
- Support explicit plain-text remote-token storage on keyring-less Linux,
  including the warning/confirmation UI and `--password-store=basic` handling.
- Preserve the personal dashboard Host allowlist/security changes unless
  upstream has demonstrably replaced them with equivalent behavior.

Upstream now owns the first-run “Connect to existing Hermes” experience. Do not
resurrect the deleted personal `first-run-flow`, `first-run-gate`,
`first-run-choice-overlay`, or `store/first-run` implementation.

After resolving conflicts:

```bash
rg -n '^(<<<<<<<|=======|>>>>>>>)' . || true
git diff --check
git add <resolved-paths>
git commit --no-edit
```

Warnings originating unchanged from upstream are not personal merge failures.
Ensure `upstream/main` is an ancestor of `HEAD`.

Confirm `apps/desktop/package.json` carries upstream's current `version`. A
personal merge must not keep an older client version merely because that was
the version at which the fork began.

## 3. Install and validate

Install the exact locked workspace dependencies from the repository root:

```bash
npm ci
```

Run at least:

```bash
cd apps/desktop
npm run typecheck
npm run test:desktop:platforms
```

Run focused tests for every personal path touched during conflict resolution.
Always run the build-stamp and bootstrap-runner tests. Personal builds have two
distinct identities that must survive the full stamp-loading path:

- `commit` / `branch`: the exact personal Desktop build (`HEAD` and
  `personal/remote-desktop`), used for bundle identity.
- `runtimeCommit` / `runtimeBranch`: `upstream/main` and `main`, used to fetch
  and pin the public NousResearch installer/runtime.

`loadInstallStamp()` must preserve the runtime fields. Bootstrap must never ask
`NousResearch/hermes-agent` for the personal commit, because that commit exists
only in the fork and would return HTTP 404.

Run `npm run test:desktop:all` when the integration changes install, boot,
update, packaging, or release-path behavior. Do not hide failures as
“pre-existing” without proving that premise.

Commit the completed merge before packaging when possible so the build stamp is
clean and identifies the integration commit. Do not include unrelated user
changes in that commit.

## 4. Rebuild the launcher target

Build the unpacked Linux application used by the personal launcher:

```bash
cd apps/desktop
npm run pack
```

Do not substitute `dist:linux` unless the user asks for AppImage/deb/rpm
installers. `pack` is the correct target for the existing launcher.

## 5. Verify the artifact

From the repository root:

```bash
artifact='apps/desktop/release/linux-unpacked/Hermes'
test -x "$artifact"
stat -c '%n %s bytes %y %A' "$artifact"
sed -n '1,80p' apps/desktop/release/linux-unpacked/resources/install-stamp.json
ldd "$artifact" | rg 'not found' && exit 1 || true
git status --short --branch
git merge-base --is-ancestor upstream/main HEAD
```

Confirm the build stamp commit and branch match the intended build. Confirm the
launcher still points to this artifact. For a personal build, also assert that
the packaged `runtimeCommit` equals `git rev-parse upstream/main`, its
`runtimeBranch` is `main`, and the bootstrap resolver selects those runtime
fields rather than the personal commit. If the public raw-file endpoint is
temporarily unavailable, seed `~/.hermes/bootstrap-cache/` only from an
installer proven identical to `upstream/main`; do not treat a network failure
as proof that the ref is wrong.

If Hermes was open while packaging, its `/proc/<pid>/exe` path may end in
`(deleted)`. Do not kill it without permission. Tell the user to close and
reopen `Hermes (Personal)`, then verify the new process points to the live
executable without `(deleted)`.

## Handoff

Report:

- upstream tip and resulting personal merge commit;
- client version and packaged runtime pin;
- whether personal behavior was preserved or superseded;
- validation commands and results;
- absolute artifact and launcher paths;
- whether a restart is required;
- whether the local branch remains unpushed.
