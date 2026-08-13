---
name: t3-pi-code-release
description: Sync the T3-Pi Code fork (darjss/t3code) with upstream, rebuild the branded desktop AppImage, and refresh the launcher install. Use when pulling new upstream commits, cutting a new T3-Pi Code desktop build, or after any change to apps/server, apps/web, or apps/desktop that should ship in the AppImage. Not for plain upstream-first development without a desktop release.
---

# T3-Pi Code release

This fork adds the Pi provider (`apps/server/src/provider/pi`, `PiAdapter.ts`) and rebrands the desktop app as "T3-Pi Code". Upstream (pingdotgg/t3code) has no Pi code, so the pi work never conflicts. Conflicts come from shared frontend files and from GitHub workflow files the fork deliberately pins.

## Before you start

- `git status` must be clean on `main`, with `main` pushed to `origin` (darjss/t3code).
- Record the current tip for later diffs: `OLD_MAIN=$(git rev-parse HEAD)`.
- Remotes: `origin` = darjss/t3code, `upstream` = pingdotgg/t3code.

## 1. Sync with upstream

```bash
git fetch upstream
git log --oneline HEAD..upstream/main | wc -l          # how much is new
# Overlap check — files both sides changed since the merge base:
comm -12 \
  <(git diff --name-only $(git merge-base HEAD upstream/main) HEAD | sort) \
  <(git diff --name-only $(git merge-base HEAD upstream/main) upstream/main | sort)
git rebase upstream/main
```

Expected friction:

- **`apps/web/src/components/chat/ComposerPrimaryActions.tsx`** — our compact-session button vs upstream's chat button changes. Resolve by keeping our `compactButton` (the `onCompact` prop, "Compact session context" aria-label) wrapped in the `div` next to the Send button, and adopting upstream's Send-button styling (`stageBackdropVariant` art, `bg-transparent text-white` variant) into our Send button. Verify `onCompact` is still threaded through `ChatView.tsx` and `ChatComposer.tsx` afterward.
- **`.github/workflows/*`** — the `chore(fork): pin workflow files to pre-rebase content` commit (if present) conflicts: **skip it** (`git rebase --skip`). Workflow files are restored in step 2, so the pin commit is redundant.
- `GIT_EDITOR=true git rebase --continue` when a rebase step needs a message editor.
- Recurring `.git/index.lock` transient right after hooks: retry with `sleep 1`.
- Upstream may add dependencies (e.g. `culori` for the OKLCH theme work) — run `vp install` before typechecking.

## 2. Restore the fork's workflow files

The GitHub OAuth token lacks `workflow` scope, so pushes touching `.github/workflows/` are rejected — and the fork intentionally keeps its own workflow set. After the rebase:

```bash
git checkout $OLD_MAIN -- .github/workflows            # revert modified ones
git rm .github/workflows/mobile-fingerprint-check.yml \
       .github/workflows/web-preview.yml               # drop any upstream ADDED
git commit --no-verify -m "chore(fork): keep fork workflow set, drop upstream's new workflows"
```

(`$OLD_MAIN` is the pre-rebase tip from step 0; add/remove the `git rm` list to match whatever upstream added.) This keeps the push out of workflow-scope territory. Never push workflow changes; if the user ever wants them, they must `gh auth refresh -h github.com -s workflow` first.

## 3. Verify

```bash
vp run --filter web typecheck
vp run --filter t3 typecheck
vp test run \
  apps/server/src/provider/Layers/PiAdapter.test.ts \
  apps/server/src/provider/pi/PiRpcClient.test.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
```

No repo-wide checks — CI owns those.

## 4. Push

```bash
git push --force-with-lease origin main
```

Only force-with-lease (rebase rewrote history). If it rejects on workflow scope, you missed step 2.

## 5. Rebuild the AppImage

```bash
pnpm dist:desktop:linux     # ~2 min; runs in background, exit 0 = done
```

Artifact: `release/T3-Pi-Code-0.0.33-x86_64.AppImage`. Version stays 0.0.33 unless `package.json` is bumped — if it changes, update the desktop entry path in step 6.

## 6. Install into the launcher

```bash
cp release/T3-Pi-Code-0.0.33-x86_64.AppImage ~/Applications/ && chmod +x ~/Applications/T3-Pi-Code-0.0.33-x86_64.AppImage
desktop-file-validate ~/.local/share/applications/t3-pi-code.desktop
# sanity launch (Electron, so it must survive a few seconds):
timeout 8 ~/Applications/T3-Pi-Code-0.0.33-x86_64.AppImage --no-sandbox & sleep 5; pgrep -f 'T3-Pi-Code-0.0.33' && echo launches
```

The `.desktop` entry (`~/.local/share/applications/t3-pi-code.desktop`) points at that path with `--no-sandbox`, icon `t3-pi-code`, and the `t3code-pi://` scheme handler — it only needs edits if the AppImage filename changes. Icons live in `~/.local/share/icons/hicolor/` (16–512px), installed once; re-run `update-desktop-database`/`gtk-update-icon-cache` only if icons change.

## 7. Report what shipped

```bash
git log --oneline $OLD_MAIN..HEAD --no-merges | grep -E '^(feat|fix)' | head -30
```

Summarize the user-visible wins in plain language, grouped by web/server/mobile/connect, and note anything Pi-specific.

## Manual test reference

- Parity plan: `.plans/11-pi-rpc-parity.md` (items 1–6 done; item 7 reasoning traces deferred; item 8 bdsqqq port not started).
- Manual test checklist + E2E results: `.plans/12-pi-rpc-parity-manual-test.md`.
- E2E runs use a sandboxed dev server (`vp run dev --home-dir .t3/pi-e2e`) + `AGENT_BROWSER_SESSION=t3-e2e`; never the live `~/.t3` state.
