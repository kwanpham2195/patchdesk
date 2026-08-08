# Live QA operations

How to drive the running Patchdesk dev app from another session (herdr +
agent-browser + CDP + the loopback API). Read the `herdr` and
`agent-browser` skills for the general CLI; this note records the
patchdesk-specific workflow and gotchas proven in Aug 2026.

## Dev app in a herdr tab

Launch the dev app in a herdr tab so it survives and is observable:

```bash
herdr tab create --cwd /Users/kwanpham/Work/cfw/patchdesk --label patchdesk-dev
# parse the new pane id from the JSON result (result.root_pane.pane_id, e.g. wF:p16)
herdr pane send-text wF:p16 "pnpm dev -- --remote-debugging-port=9233"
herdr pane send-keys wF:p16 enter
herdr pane read wF:p16   # tail build output
```

- Pane ids are `workspace:pane` (e.g. `wF:p16`), not `tab.pane`.
- Interrupt a running command with `herdr pane send-keys <pane> "ctrl+c"`
  (the literal string `ctrl+c`; `ctrl-c` and `Ctrl-C` are rejected).
- `herdr tab new` does not exist; the command is `herdr tab create`.

## CDP launch flag

Electron only honors the kebab-case switch with `=`:

- Works: `pnpm dev -- --remote-debugging-port=9233`
- Does NOT work: `--remoteDebuggingPort 9233` (silently no CDP listener)

The flag is read at launch; an already-running app must be restarted to pick
it up. Verify with `curl -s http://127.0.0.1:9233/json/version`.

## Agent-browser

```bash
agent-browser --session patchdesk-dev --cdp 9233 snapshot -i   # a11y tree
agent-browser --session patchdesk-dev --cdp 9233 click @e33     # act on a ref
agent-browser --session patchdesk-dev --cdp 9233 eval "..."     # JS in page
agent-browser --session patchdesk-dev --cdp 9233 console        # page console
```

- Refs are fresh per snapshot; re-snapshot after every page change.
- `eval` runs in the same JS world as the app.

## Loopback API access

The local API binds a random port; find it with
`lsof -nP -iTCP -sTCP:LISTEN | grep Electron`. Direct `curl` fails with
"Missing local API capability" — the capability header is process-local and
not readable from outside.

From the page, use the preload bridge (no capability needed):

```js
window.patchdesk.request({ path: "/v1/reviews/open", method: "POST",
  body: { profileId, host, owner, repo, number } })
```

## Renderer-side debugging gotchas

- `window.patchdesk` is FROZEN: monkeypatching `window.patchdesk.request` to
  trace calls silently does nothing. Instead, add a temporary
  `console.log(...)` in the source (HMR applies it in seconds) and read it
  from `agent-browser console`.
- To run a module's function in the live page (e.g. a parser), import it from
  the vite dev server with a cache-busting query:
  `await import('/src/renderer-contracts.ts?v=' + Date.now())`.
- Full-suite parallel runs can make timing-sensitive tests flaky; rerun the
  failing test in isolation before assuming a regression.
