# React toolchain advisory disposition — 2026-08-14

## Evidence scope

Task 6 captured the current root graph and package evidence at
`2026-08-14T14:54:08Z` UTC. The audit JSON files are preserved at:

- `/tmp/patchdesk-audit-prod.json`
- `/tmp/patchdesk-audit-full.json`
- `/tmp/patchdesk-task6-audit-status.txt`
- `/tmp/patchdesk-task6-versions.txt`

Commands and exact results:

- `pnpm audit --prod --audit-level high --json`: exit `0`; `217` total production dependencies; `0` critical, `0` high, `0` moderate, `0` low, and `0` info findings.
- `pnpm audit --audit-level high --json`: exit `1`; `1,036` total dependencies; `0` critical, `11` high, `9` moderate, `0` low, and `0` info findings.
- The production audit is clean. The full audit remains non-zero only for development/build dependency paths listed below.

The root direct/runtime graph is unchanged by Task 6 and resolves to:

- Hono `4.13.2` (`package.json` range `^4.13.2`).
- `@hono/node-server` `2.1.1` (`package.json` range `^2.1.1`).
- Mermaid `11.16.1`.
- Mermaid's transitive DOMPurify `3.4.13`.

`pnpm why` and `pnpm list --depth 0 --json` prove these versions. No dependency, manifest, lockfile, source, test, or Flue file was changed by Task 6.

Flue closure is unchanged:

- `runtime/flue/package.json` direct dependencies: `@earendil-works/pi-ai` `0.84.1`, `@flue/runtime` `2.0.3`, and `valibot` `1.4.2`.
- `runtime/flue/pnpm-lock.yaml` SHA-256: `05847f8ea0e5979e90740e363104a11344216b14cc247cf450c20ef497dc37dc`.

## Development/build advisory paths (not shipped runtime)

The production audit has no findings. All remaining full-audit findings are
owned by development, build, or packaging tooling. They are not shipped
runtime advisories under the clean production graph.

| Advisory IDs                                         | Package and path                                                                     | Severity      | Patched target                   | Disposition and owner                                                                                                                                                                                                                           | Verification                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1124064, 1130720                                     | `fast-uri@3.1.3` via `electron-builder -> ajv` and `react-doctor -> conf -> ajv`     | high          | `>=3.1.5`                        | Build/test tooling only. No override: two development parents own the path and a cross-major override is not approved. Owner: build-tool maintenance.                                                                                           | `pnpm why fast-uri`; full audit JSON.             |
| 1130588, 1130589, 1130591, 1130734, 1130736, 1130737 | `brace-expansion@1.1.16`, `2.1.2`, and `5.0.7` via Electron Builder and React Doctor | high          | `>=1.1.18`, `>=2.1.4`, `>=5.0.9` | Build/test tooling only. Each major path has different owners; no incompatible blanket override. Owner: packaging/tool maintenance.                                                                                                             | `pnpm why brace-expansion`; full audit JSON.      |
| 1138115                                              | `js-yaml@4.3.0` via `electron-builder` and React Doctor                              | high          | `>=4.3.1`                        | Build/test tooling only. Current supported direct parents do not provide a verified compatible patch-only route; no override added. Owner: packaging/tool maintenance.                                                                          | `pnpm why js-yaml`; full audit JSON.              |
| 1139427                                              | `nanoid@3.3.16` via Vite/PostCSS                                                     | high          | `>=3.3.18`                       | Build/test tooling only. Advisory is conditional on attacker-controlled zero-size custom generators; no affected application path was identified. A Vite/PostCSS migration is not approved by this plan. Owner: frontend toolchain maintenance. | `pnpm why nanoid`; full audit JSON.               |
| 1130709                                              | `postcss@8.5.19` via Vite                                                            | moderate      | `>=8.5.23`                       | Build/test tooling only. Requires a verified Vite/PostCSS parent update; no incompatible override added. Owner: frontend toolchain maintenance.                                                                                                 | `pnpm why postcss`; full audit JSON.              |
| 1130715, 1130718, 1130726, 1130729, 1130731          | `undici@7.28.0` via Electron download tooling                                        | high/moderate | `>=7.29.0`                       | Build/test tooling only. Requires an Electron/toolchain parent update; Electron major migration is out of scope. Owner: Electron toolchain maintenance.                                                                                         | `pnpm why undici`; full audit JSON.               |
| 1130716, 1130727, 1130732                            | `undici@6.27.0` via `electron-builder -> @electron/rebuild -> node-gyp`              | moderate      | `>=6.28.0`                       | Build/test tooling only. Requires a packaging parent update; no cross-major override added. Owner: packaging/tool maintenance.                                                                                                                  | `pnpm why undici`; full audit JSON.               |
| 1124287                                              | `tar@7.5.20` via packaging tooling                                                   | moderate      | `>=7.5.21`                       | Build/test tooling only. Current parent path is build-only and no compatible direct owner update was verified. Owner: packaging/tool maintenance.                                                                                               | Full audit JSON; package graph remains unchanged. |

## Verification record

The required Task 6 gates ran against the current graph:

- `pnpm test:bundle`: passed. Pierre theme catalog matched; Electron main,
  preload, and renderer builds passed; renderer bundle separation passed.
- `pnpm package:mac`: passed. The current arm64 macOS directory package was
  built with Electron `43.1.1`; Flue runtime staging, icon verification, and
  native dependency installation passed. Code signing was intentionally skipped
  because the build identity is `null`.
- `pnpm test:package-smoke`: passed against the current package. The packaged
  runtime reported Flue `2.0.3`, Pi `0.84.1`, Node `24.18.0`, and loaded the
  fixture workbench from `release/mac-arm64/Patchdesk.app`.
- `pnpm exec oxfmt --check plans/audit-2026-08-14-react-toolchain-advisories.md`:
  passed.
- `git diff --check -- plans/audit-2026-08-14-react-toolchain-advisories.md
package.json pnpm-lock.yaml runtime/flue/package.json
runtime/flue/pnpm-lock.yaml`: passed.
- `git diff --cached --name-only`: empty; no files are staged.

No root `pnpm.overrides` was added. No package version, package manager,
Electron, Vite, electron-builder, React Doctor, or Flue upgrade was performed
by this task.

## Residual blockers and owners

The remaining full-audit set is `11` high and `9` moderate findings in
build/test tooling. Build-tool, packaging-tool, frontend-toolchain, and
Electron-toolchain owners must verify compatible parent upgrades before any
future fix. Do not add a cross-major override or perform a major migration from
this evidence task. The production graph is clean, and no shipped runtime
advisory remains.
