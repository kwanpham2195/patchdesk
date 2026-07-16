# Patchdesk rules

- Keep the Electron renderer isolated: `nodeIntegration: false`, `contextIsolation: true`, and expose privileged data only from preload.
- Never store GitHub tokens or other credentials in Patchdesk files, local storage, logs, or telemetry.
- The renderer must never execute raw shell commands; privileged work belongs behind explicit main-process boundaries.
- Do not use broad git cleanup commands (`git clean`, `git reset --hard`, bulk restores) from Patchdesk.
- Do not automatically create GitHub reviews, comments, merges, pushes, or other remote writes; require an explicit user confirmation flow.
- Parse all local API and IPC boundary inputs, return typed expected failures from product modules, and keep capability values out of output and diagnostics.
