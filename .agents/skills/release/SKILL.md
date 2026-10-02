---
name: release
description: Cut a Patchdesk release, publish a drafted one, or bump the Homebrew cask and install the latest version. Use when the maintainer asks to release, ship a version, publish, or install the latest Patchdesk.
---

# Release Patchdesk

`CONTRIBUTING.md`, section Release, owns the commands and what each script refuses. This skill adds the order the maintainer expects, where to stop, and the gotchas the docs do not cover. Read that section first.

Run every outward write here (tag push, `gh release edit`, the tap push) from the main session. Subagents get denied on `gh release` and `git push`; delegate only read-only checks.

## Inputs

- Version: the one the maintainer names. Otherwise bump the patch number of the last tag (`git tag --sort=-creatordate | head -1`) and state the choice in the first update.
- "just do it" (or "publish and bump") in the request: skip the stop in step 6.
- "install the latest version" alone: run steps 8 and 9 for the latest published release.

## Steps

1. Sync and gate. Work on a branch `chore/release-<version>` cut from `origin/main` after `git fetch origin`, with a clean tree. If the main checkout is on another branch or holds another session's files, do not switch, stash, or clean it: create `git worktree add -b chore/release-<version> /tmp/patchdesk-release-<version> origin/main`, run `pnpm install` there, and do steps 3 and 4 in it. Every change to `main` goes through a pull request, releases included. Run `pnpm check > /tmp/check.txt 2>&1; echo "EXIT=$?"` (the pull request workflow is paused, so this is the only gate before the tag). A leftover untracked `release-notes.md` from a local release makes `release:prepare` refuse; trash it.

2. Check issues against the changelog.
   - Open bugs: `gh issue list --label bug --state open --json number,title`. These ship as known bugs; list them in the step 6 report. They do not block.
   - Fixed but open: collect every `#n` in the `## Unreleased` section of `CHANGELOG.md` and in `git log v<last>..HEAD`, then check each with `gh issue view <n> --json state,title` (skip numbers that are pull requests). Close an open issue whose fix landed (`gh issue close <n> --comment "Fixed in <sha>; ships in <version>."`). Leave standing or partly done issues open (a PR that said `Refs #n`, such as #335) and list them.

3. Tighten the changelog. Read `~/.agents/skills/update-changelog/SKILL.md`. Keep each Unreleased entry short: one or two sentences, the user-visible change, then the issue numbers. The maintainer asked for short entries ("make them short and concise", 0.0.13), and the release page shows this section verbatim. Commit the edit on the release branch, on its own (`docs(changelog): tighten <version> entries`) because `release:prepare` refuses a dirty tree.

4. Prepare, commit, land, tag: CONTRIBUTING.md Release steps 2 and 3. Run `pnpm release:prepare <version>`, read the diff, commit `chore: release <version>`, `git push -u origin chore/release-<version>`, open a pull request, and land it with `gh pr merge <n> --rebase --delete-branch`. Rebase merge rewrites the SHA, so then `git switch main && git pull --ff-only` (in the main checkout or the release worktree via `git fetch origin && git switch --detach origin/main`), check HEAD is the merged `chore: release <version>` commit, `git tag v<version>`, and `git push origin v<version>` (tag only).

5. Wait for the `Release` workflow: `gh run list --workflow Release --limit 1`, then `gh run watch <id> --exit-status`. It takes about 10 minutes and ends with a draft release. If it fails, stop and report the failing step with the log excerpt (`gh run view <id> --log-failed`). Run the local chain in CONTRIBUTING.md step 4 only when the workflow cannot run at all.

6. Stop for "publish". Show the maintainer, in this order: the version and tag commit, `gh release view v<version>` notes, attached assets (`.dmg` and `.zip`), issues closed in step 2, and open bugs and issues left open. End the turn and wait for "publish". Skip this stop when the request said "just do it".

7. Publish: `gh release edit v<version> --draft=false --latest`. Confirm with `gh api repos/kwanpham2195/patchdesk/releases/latest --jq .tag_name` (`gh release view --json isLatest` has no such field).

8. Bump the cask (CONTRIBUTING.md Release step 6). The tap clone is `/opt/homebrew/Homebrew/Library/Taps/kwanpham2195/homebrew-patchdesk`; run `git -C <tap> pull --ff-only` first. `pnpm release:cask` hashes `release/Patchdesk-<version>-arm64.dmg`, which a CI release does not leave locally, so download the published asset first: `gh release download v<version> --pattern 'Patchdesk-<version>-arm64.dmg' --dir release --clobber`. Then commit and push in the tap with the commands it prints.

9. Install locally: `brew update && brew audit --cask kwanpham2195/patchdesk/patchdesk && brew upgrade --cask patchdesk`, then `xattr -dr com.apple.quarantine /Applications/Patchdesk.app`, because Homebrew quarantines every upgrade and macOS then refuses to open the app ("Apple could not verify"). Verify with `defaults read /Applications/Patchdesk.app/Contents/Info CFBundleShortVersionString`. The maintainer asks for this after every release, so do it without asking.

## Homebrew gotchas

- `brew audit --cask` rejects `url ..., verified:` and the string form `depends_on macos: ">= :monterey"`. Keep the bare `url` and `depends_on macos: :monterey`.
- The cask keeps the `binary "#{appdir}/Patchdesk.app/Contents/Resources/bin/patchdesk"` line across bumps (ADR 0052). `release:cask` edits only `version` and `sha256`; do not touch other lines.
- `--no-quarantine` no longer exists. The app is ad-hoc signed, so every install and upgrade needs `xattr -dr com.apple.quarantine /Applications/Patchdesk.app`; the cask caveat says so. After 0.0.16 the upgrade skipped it and the app would not open.
- Homebrew 7 trusts a fully qualified cask on install. `brew trust --tap` was a Homebrew 6 step; skip it.
- Homebrew fetches the `.dmg` from the published release URL, so the cask cannot point at a draft.

## Report

Lead with one line: `Released <version>: published, cask bumped, installed <installed version>` (or where it stopped). Then the tag SHA, the Release run URL, closed issues, issues left open, and any skipped step with its reason.
