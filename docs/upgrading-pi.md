# Upgrading Pi

Bumping the bundled Pi model client is how new models and providers reach the
run dialog.

Patchdesk never imports Pi at the root. `runtime/insight` pins
`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to one exact
version, its generator projects Pi's model tables into
`src/adapters/pi/pi-ai-catalog.generated.ts`, and the root app re-validates
that artifact against a version literal and a digest. A bump is therefore one
version string copied into every pin, plus regeneration, plus a review of what
the model list gained and lost.

Work on a clean tree on a fresh `chore/pi-<new-version>` branch. Every step
below ends on a check; do not move on until it passes.

## 1. Pick the target

```bash
npm view @earendil-works/pi-ai version
npm view @earendil-works/pi-agent-core version
```

`pi-ai` and `pi-agent-core` are both direct dependencies of `runtime/insight`
and always move together to the same version. (The runtime lives in
`runtime/insight`; see ADR 0041.)

Done when: you can name OLD and NEW.

## 2. Replace every pin

Find the pins by searching for the old version. The generated files and the
lockfile are excluded because step 3 rewrites them, and `docs/` because this
page names past versions as examples.

```bash
rg -n 'OLD' --glob '!node_modules' --glob '!pnpm-lock.yaml' --glob '!*.generated.ts' --glob '!runtime-manifest.json' --glob '!docs/**'
```

Expect hits in exactly these places, and edit each one to NEW:

- `runtime/insight/package.json` (two dependencies: `pi-ai` and
  `pi-agent-core`)
- `runtime/insight/scripts/write-manifest.mjs` and
  `generate-model-catalog.d.mts`
- `src/adapters/pi/pi-ai-catalog.ts` (the `v.literal`)
- `src/main/insight-runtime.ts`
- `scripts/stage-insight-runtime-lib.mjs` (one) and `scripts/package-smoke.mjs`
  (three)
- test fixtures: `runtime/insight/tests/insight-runtime.test.ts` (one),
  `tests/main-desktop-hardening.test.ts` (three, plus one deliberate mismatch
  fixture that must stay a version other than NEW),
  `tests/scripts/stage-insight-runtime.test.ts` (two lines, one of them naming
  both packages)

That is 16 lines in 10 files. `perl -pi -e 's/OLD/NEW/g' <files>` does the
edit; BSD `sed -i ''` loses its empty suffix under some shell wrappers.

The three script pins are checked only by the release workflow, never on a PR,
so a missed one is green in CI and red on the tag. A hit in an unexpected file
is a new pin: edit it too and add it to the list above.

Done when: the `rg` above returns nothing.

## 3. Regenerate

```bash
pnpm --dir runtime/insight install --config.auto-install-peers=false
pnpm --dir runtime/insight build
```

This rewrites `runtime/insight/pnpm-lock.yaml`,
`src/adapters/pi/pi-ai-catalog.generated.ts`, and
`runtime/insight/runtime-manifest.json`. Never hand-edit those three; the root
validates the catalog digest and the manifest digest at startup, and
`pnpm install` at the root regenerates them anyway.

Done when: `git status` shows those three files modified and the build exits 0.

## 4. Review the model delta

`git diff` on the generated file is thousands of lines. Diff the id sets
instead, before anything is committed so `HEAD` still holds the old catalog:

```bash
git show HEAD:src/adapters/pi/pi-ai-catalog.generated.ts > /tmp/old-catalog.ts
pnpm pi:catalog-delta /tmp/old-catalog.ts src/adapters/pi/pi-ai-catalog.generated.ts
```

Read the whole report. Three findings need action:

- **Likely id renames.** A provider changed its id scheme (0.84.4 moved
  `cloudflare-ai-gateway` Anthropic ids from `-` to `.` and
  `vercel-ai-gateway` xAI models from `xai/` to `spacexai/`). Saved
  `defaultModel` or `enabledModels` entries in `~/.pi/agent/settings.json`
  naming the old id silently stop matching. Name these in the changelog entry.
- **NEW PROVIDER in the delta.** Impossible unless someone edited the
  generator, since the generator imports a fixed list. Treat it as a mistake
  and check the diff.
- **A provider Pi ships that the generator does not import.** Check for one
  every bump:

  ```bash
  ls runtime/insight/node_modules/@earendil-works/pi-ai/dist/providers/ | grep '\.models' | sed 's/\..*//' | sort -u
  ```

  Compare against the `CATALOGS` array in
  `runtime/insight/scripts/generate-model-catalog.mjs`. Policy: OAuth and
  Worker-binding providers are never added, whatever Pi ships. Only a provider
  configured by an API key in an environment variable qualifies. At 0.84.x the
  excluded set is `baseten`, `cloudflare-workers-ai`, `github-copilot`,
  `openai-codex`, and the three `qwen-token-plan*`; a new module whose Pi
  source reads a token file or runs a login flow joins that set silently. A new
  key-authenticated provider is a three-file coordinated edit: an import plus a
  `CATALOGS` entry in the generator, a `provider(...)` entry in the `PROVIDERS`
  allowlist in `src/adapters/pi/pi-provider-catalog.ts` with its environment
  variable and guidance text, and the provider-count assertions in
  `tests/adapters/pi-runtime-model-catalog.test.ts` and
  `runtime/insight/tests/insight-runtime.test.ts`. Then rerun step 3.

Pi may also drop a vendor SDK. `tests/scripts/stage-insight-runtime.test.ts`
asserts the staged lock contains each provider SDK Pi wraps; if that loop fails
at step 5, check Pi's `dist/api/<provider>-*.js` for the import. A provider
whose client was rewritten over Pi's own fetch keeps its models and loses only
the lock entry: remove that one SDK from the list and say so in the commit
body. A provider whose module is gone is a removal; report it.

Also confirm `openai/gpt-4-turbo` survived;
`tests/adapters/pi-runtime-model-catalog.test.ts` pins it as a real fixture and
a retirement reads as a catalog bug rather than a stale test.

Done when: every rename is written down for the changelog, and the provider
module list minus the seven excluded equals the generator's `CATALOGS`.

## 5. Gate

The PR gate, then the release-only gate, then the live surface. All three; a
passing test suite does not prove the packaged runtime still resolves.

```bash
pnpm typecheck && pnpm typecheck:scripts && pnpm lint && pnpm test:all
pnpm package:mac && pnpm test:package-smoke
```

Then launch the app and run one Insight against a newly added model, using a
low-cost one on a provider the maintainer has a key for (see `AGENTS.md` on
spending). The run dialog listing the new model proves the catalog; the run
completing proves `resolveInsightRuntime` accepted the manifest.

Done when: all commands exit 0 and one Insight run on a new model completed.

## 6. Changelog and commit

Add the entry with `/update-changelog`, never by hand. It is user-facing: newer
models are available, name the headline additions, and warn which saved model
ids were renamed by their provider so a saved default may need re-picking. Do
not name the Pi version; no entry in this repo ever has.

Commit pins, regenerated files, tests, and changelog as one unit. CI runs
`pnpm install --frozen-lockfile`, so a lockfile landing apart from its
`package.json` fails immediately. Conventional commit, e.g.
`chore(deps): upgrade Pi to NEW`.

Done when: one commit, `git status` clean, PR open.
