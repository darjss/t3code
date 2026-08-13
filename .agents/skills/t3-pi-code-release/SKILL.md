---
name: t3-pi-code-release
description: Sync the T3-Pi Code fork (darjss/t3code) with upstream, rebuild the desktop AppImage, and refresh the launcher install. Use when pulling new upstream commits, cutting a new desktop build, or after server/web/desktop changes that should ship in the AppImage. Not for upstream-first development without a desktop release.
---

# T3-Pi Code release

This fork adds the Pi provider (`apps/server/src/provider/pi`, `PiAdapter.ts`) and rebrands the desktop app as "T3-Pi Code". Upstream (pingdotgg/t3code) has no Pi code, so the pi work never conflicts. Conflicts come from shared frontend files and from GitHub workflow files the fork deliberately pins.

**Remotes:** `origin` = darjss/t3code, `upstream` = pingdotgg/t3code.

## 0. Preconditions

`main` is clean and pushed to origin. Record `OLD_MAIN=$(git rev-parse HEAD)` — step 2 and step 7 diff against it.

## 1. Sync with upstream

```bash
git fetch upstream
git log --oneline HEAD..upstream/main | wc -l   # how much is new
# overlap: files both sides changed since the merge base
comm -12 \
  <(git diff --name-only $(git merge-base HEAD upstream/main) HEAD | sort) \
  <(git diff --name-only $(git merge-base HEAD upstream/main) upstream/main | sort)
git rebase upstream/main
```

Expected friction:

- **`apps/web/src/components/chat/ComposerPrimaryActions.tsx`** — our compact-session button vs upstream's chat button changes. Resolve by keeping our `compactButton` (`onCompact` prop, "Compact session context") beside the Send button, and adopting upstream's Send-button styling (`stageBackdropVariant` art, `bg-transparent text-white` variant) into our Send button. Then verify `onCompact` still threads through `ChatView.tsx` and `ChatComposer.tsx`.
- **`.github/workflows/*`** — the `chore(fork): pin workflow files to pre-rebase content` commit (if present) conflicts: skip it (`git rebase --skip`); step 2 restores the fork's workflows.
- `GIT_EDITOR=true git rebase --continue` when a step needs a message editor.
- Recurring `.git/index.lock` right after hooks: retry with `sleep 1`.
- Upstream may add dependencies (e.g. `culori` for the OKLCH theme work): run `vp install` before typechecking.

**Done when:** rebase reports success, `git grep -l '^<<<<<<< '` finds nothing, and the typechecks in step 3 pass.

## 2. Restore the fork's workflow set

The GitHub token lacks `workflow` scope (pushes touching `.github/workflows/` are rejected) and the fork keeps its own workflow set. After the rebase, make workflows identical to the pre-rebase fork tip:

```bash
git checkout $OLD_MAIN -- .github/workflows
git rm .github/workflows/mobile-fingerprint-check.yml \
       .github/workflows/web-preview.yml      # adjust to whatever upstream added
git commit --no-verify -m "chore(fork): keep fork workflow set, drop upstream's new workflows"
```

**Done when:** `git diff $OLD_MAIN -- .github/workflows` prints nothing and `git status` is clean. If the user ever wants upstream workflows, they must run `gh auth refresh -h github.com -s workflow` first — never push workflow changes without it.

## 3. Verify

```bash
vp run --filter web typecheck
vp run --filter t3 typecheck
vp test run \
  apps/server/src/provider/Layers/PiAdapter.test.ts \
  apps/server/src/provider/pi/PiRpcClient.test.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
```

**Done when:** both typechecks exit 0 and all listed tests pass. No repo-wide checks — CI owns those.

## 4. Push

```bash
git push --force-with-lease origin main
```

The rebase rewrote history, so force-with-lease is expected. **Done when:** the push lands. A workflow-scope rejection means step 2 was missed.

## 5. Build the AppImage

```bash
pnpm dist:desktop:linux     # ~2 min
```

Artifact: `release/T3-Pi-Code-0.0.33-x86_64.AppImage`. **Done when:** exit 0 and the artifact mtime is fresh.

## 6. Install into the launcher

The launcher is `~/.local/share/applications/t3-pi-code.desktop`, pointing at `~/Applications/T3-Pi-Code-0.0.33-x86_64.AppImage` with `--no-sandbox`, icon `t3-pi-code`, and the `t3code-pi://` scheme handler. Icons live in `~/.local/share/icons/hicolor/` (16–512px). These only need changes when the version in `package.json` bumps — rename the file, edit the entry, and refresh both caches (`update-desktop-database`, `gtk-update-icon-cache`).

```bash
cp release/T3-Pi-Code-0.0.33-x86_64.AppImage ~/Applications/ && chmod +x ~/Applications/T3-Pi-Code-0.0.33-x86_64.AppImage
desktop-file-validate ~/.local/share/applications/t3-pi-code.desktop
timeout 8 ~/Applications/T3-Pi-Code-0.0.33-x86_64.AppImage --no-sandbox & sleep 5; pgrep -f 'T3-Pi-Code-0.0.33' && echo launches
```

**Done when:** validate prints nothing and pgrep finds the process (Electron, so it must survive a few seconds).

## 7. Report what shipped

```bash
git log --oneline $OLD_MAIN..HEAD --no-merges | grep -E '^(feat|fix)' | head -30
```

**Done when:** the user gets a plain-language list of user-visible wins, grouped by surface (web/server/mobile/connect), with anything Pi-specific called out.

## Manual test reference

- Parity plan: `.plans/11-pi-rpc-parity.md` (items 1–6 done; item 7 reasoning traces deferred; item 8 bdsqqq port not started).
- Manual test checklist + E2E results: `.plans/12-pi-rpc-parity-manual-test.md`.
- E2E runs use a sandboxed dev server (`vp run dev --home-dir .t3/pi-e2e`) with `AGENT_BROWSER_SESSION=t3-e2e`; never the live `~/.t3` state.
