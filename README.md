# Patchdesk

Patchdesk is a desktop app for reviewing GitHub pull requests. It runs on
your Mac, next to your local checkouts, with no server in between.

You open the Pull requests screen, pick a Selected repository, and see the
list GitHub gives you for it. From there you read diffs, comment, resolve
conversations, submit a Review, and merge. None of that needs a model.
Models are optional, and only add Insights: a summary, a walkthrough, or an
analysis of the diff.

## Requirements

- macOS on Apple Silicon (arm64). Patchdesk does not run on Intel Macs,
  Windows, or Linux.
- `git`.
- The GitHub CLI (`gh`), logged in:

  ```bash
  gh auth login
  ```

Patchdesk never stores a GitHub token. It runs `gh auth token` each time it
needs one.

You do not need Node.js installed. The part of Patchdesk that runs Insights
ships inside the app and runs on Electron's own Node.

## Install

1. Download the `.dmg` from the
   [Releases page](https://github.com/kwanpham2195/patchdesk/releases).
2. Open the `.dmg` and drag Patchdesk into Applications.

The first time you open Patchdesk, macOS shows "Apple could not verify
Patchdesk.app". This is expected: the build is not signed with an Apple Developer ID
or notarized. Open it anyway, using either of these:

- System Settings → Privacy & Security → Open Anyway, or
- right-click `Patchdesk.app` → Open.

If neither works, clear the quarantine flag macOS adds to downloads:

```bash
xattr -cr /Applications/Patchdesk.app
```

Opening Patchdesk a second time while it is already running quits the new
copy right away; the existing window comes to the front instead.

## First run

The Pull requests screen starts with a checklist:

1. Confirm GitHub access — choose the account Patchdesk should use.
2. Check local tools — Patchdesk checks for `git` and `gh`, and that `gh` is
   logged in. Fix anything missing in a terminal, then press Re-check.
3. Add your first repository — a local checkout Patchdesk can work in.

After that, go to Settings → Workspace to point Patchdesk at a workspace
root. It finds repositories under that root for you to add.

## Reviewing pull requests

Open the Pull requests screen and pick a Selected repository. Patchdesk
shows one repository's list at a time; GitHub decides what is in it, the
order, and the count.

From a pull request you can read the diff, leave comments, resolve
conversations, submit a Review, and merge. This is the core flow, and it
needs no model.

Use More filters to filter by Review state or Check status. Active selections
appear as chips and persist with the active profile across reloads. Clear a
chip to remove one selection, or choose Clear all filters in More filters to
clear those selections.

## Insights

An Insight is optional. It helps you understand or evaluate a change, but it
never replaces a Review. Patchdesk offers three: Analysis, Walkthrough, and
Brief. A fourth, the Scope gauge, needs no model at all — it buckets changed
files by path and is always on wherever it is shown.

Each run opens a dialog where you choose the Insight provider, the model,
and the reasoning level. Patchdesk asks every time; it does not remember a
choice for you.

There are two Insight providers.

### Pi

Pi is a model client bundled with Patchdesk — you do not install anything
separate. Pi talks directly to a model API, and you supply the key through
an environment variable; there is no key field in the app.

Pi supports 32 providers. Thirty of them read a key from an environment
variable:

- Ant Ling — `ANT_LING_API_KEY`
- Anthropic — `ANTHROPIC_API_KEY`
- Azure OpenAI — `AZURE_OPENAI_API_KEY`
- Cerebras — `CEREBRAS_API_KEY`
- Cloudflare AI Gateway — `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and
  `CLOUDFLARE_GATEWAY_ID`; all three are required
- DeepSeek — `DEEPSEEK_API_KEY`
- Fireworks — `FIREWORKS_API_KEY`
- Google — `GEMINI_API_KEY`
- Groq — `GROQ_API_KEY`
- Hugging Face — `HF_TOKEN`
- Kimi Coding — `KIMI_API_KEY`
- MiniMax — `MINIMAX_API_KEY`
- MiniMax China — `MINIMAX_CN_API_KEY`
- Mistral — `MISTRAL_API_KEY`
- Moonshot — `MOONSHOT_API_KEY`
- Moonshot China — `MOONSHOT_API_KEY`
- NVIDIA — `NVIDIA_API_KEY`
- OpenAI — `OPENAI_API_KEY`
- OpenCode — `OPENCODE_API_KEY`
- OpenCode Go — `OPENCODE_API_KEY`
- OpenRouter — `OPENROUTER_API_KEY`
- Together — `TOGETHER_API_KEY`
- Vercel AI Gateway — `AI_GATEWAY_API_KEY`
- xAI — `XAI_API_KEY`
- Xiaomi — `XIAOMI_API_KEY`
- Xiaomi Token Plan (AMS) — `XIAOMI_TOKEN_PLAN_AMS_API_KEY`
- Xiaomi Token Plan (China) — `XIAOMI_TOKEN_PLAN_CN_API_KEY`
- Xiaomi Token Plan (Singapore) — `XIAOMI_TOKEN_PLAN_SGP_API_KEY`
- ZAI — `ZAI_API_KEY`
- ZAI Coding China — `ZAI_CODING_CN_API_KEY`

Moonshot and Moonshot China read the same variable, and so do OpenCode and
OpenCode Go.

The other two providers use credentials instead of a key:

- Amazon Bedrock — your normal AWS credentials
- Google Vertex — your normal GCP credentials, or `GOOGLE_CLOUD_API_KEY`

The list in `src/adapters/pi/pi-provider-catalog.ts` is the authoritative one.

Providers that sign in through OAuth or a login flow, such as GitHub Copilot
or the Codex subscription inside Pi, are left out of the Pi provider on
purpose; the Codex CLI account provider below covers the Codex case.

Export the variable in your shell profile (`~/.zshrc`), then restart
Patchdesk:

```bash
export ANTHROPIC_API_KEY="sk-..."
```

Patchdesk runs your login shell once at startup and reads back the provider
keys and your PATH, so a Dock or Finder launch sees the same key a terminal
does. It reads nothing else from your shell, and it never overwrites a
variable Patchdesk already has. A key you add later needs a restart.

If Patchdesk cannot read your shell's startup files, set the variable for the
whole login session instead:

```bash
launchctl setenv ANTHROPIC_API_KEY "sk-..."
```

That lasts until you log out.

Only the variables the selected provider needs reach the model process, and
only that process sees them — keys never reach the app's UI. The model list
you see is Pi's catalog, filtered to providers you have a key for. That
catalog is refreshed with each Patchdesk release; there is nothing to
update on your side.

### Codex CLI account

This provider uses your existing Codex CLI login. Install Codex and run
`codex login` yourself; Patchdesk never starts a login for you.

Patchdesk finds `codex` by searching your PATH only. It reads PATH from your
login shell, so a Homebrew or npm install is found, and Patchdesk runs the
same `codex` your terminal runs.

If Patchdesk cannot find Codex, the dialog says so directly: "Install Codex
and expose codex on the app launch PATH, then log in externally."

With either provider, the model never touches GitHub, your checkout, or the
network beyond the model API itself.

## Where Patchdesk keeps its files

- Config: `~/.config/patchdesk`
- Data: `~/.local/share/patchdesk`
- Cache: `~/.cache/patchdesk`
- Logs: `~/.local/share/patchdesk/logs/patchdesk.jsonl`

Patchdesk does not use `~/Library`.

## How Patchdesk stays safe

The local API only listens on `127.0.0.1`, and the app window is sandboxed:
it has no direct access to Node.js or your filesystem.

A GitHub write only happens from an action you name explicitly, like Add to
review. Finishing an Insight never triggers one on its own. If Patchdesk
cannot confirm that a write went through, it locks further writes until you
check GitHub again — it never retries a write on its own.

## Known limits

- GitHub rate limits and blocked reads (an IP allow list, SAML, a missing
  scope) show up as what they are, with no retry button — retrying cannot
  fix either one.
- Patchdesk is built for a sighted person using a keyboard and mouse. It has
  no screen reader support.
- The Pull requests screen only refreshes when you ask: opening the screen,
  changing a filter or page, or pressing ⌘R.

## Contributing

To build Patchdesk from source or contribute changes, see
[CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/architecture.md](docs/architecture.md). Patchdesk is
[MIT licensed](LICENSE).
