# Roadmap

This file records where Patchdesk is headed and in what order. GitHub Issues
track the work itself; each entry here links the issues it covers.

Patchdesk is growing toward **developers who write most of their code through
coding agents** and review that output every day. Local Review and the MCP
server are the core of the product; pull request review stays supported.

The near-term goal is **outside users**: someone other than the maintainer can
install Patchdesk, get it working, and report a problem.

## Now

- **Fix the open bugs an outside user would hit.** A merge GitHub refuses
  locks the Review (#691). A missing Review worktree is blamed on GitHub
  (#616). Smaller bugs: #549, #550, #615, #617–#623, #692.
- **Keep Electron patched.** #696, #697, #698.
- **Live-check resolved UX friction.** Most resolved items in
  `docs/product-description/ux-friction.md` say "Not checked live". Check them
  in the next monthly verification (#336).

## Next

- **Fresh-eyes UX pass.** Walk the path a new user takes: install, add a
  repository, run an Insight, and finish one local Review loop with a coding
  agent. Record friction in `docs/product-description/ux-friction.md` and file
  issues. Run it before building the other Next items, since it may reorder
  them. No issue yet.
- **In-app agent setup.** Show the MCP configuration for Claude Code and
  Codex in the app, copy it, and confirm when the agent connects. Today this
  setup lives only in `docs/mcp.md`. No issue yet.

- **Update check.** Tell users when a newer release is published, so they do
  not have to watch GitHub. No issue yet.
- **Insight provider onboarding.** First run covers the GitHub account and
  repositories but not Insight providers, so a new user may never reach Brief,
  Walkthrough, or Analysis. No issue yet.
- **Feedback channel.** Add issue templates, and let users export diagnostics
  from Settings → Logs to attach to a report. No issue yet.

## Later

- **Shortcut discoverability.** A keyboard shortcut sheet and in-place hints,
  so Walkthrough navigation, diff navigation, and the command dialog are
  findable without the docs.

- **Finish local Review.** Remove a local Review (#511), reach drafts on
  other branches (#486), and signal a Change intent added after an Analysis
  (#499).
- **Deeper Insights.** A separate challenge run in Analysis (#516) and tracing
  a chosen scenario through the changed code (#439). Both need a prototype
  first.
- **Know what needs you.** Needs your reply (#271), one "needs me" list
  (#435), and the Watch notification toggle (#436). Blocked on superseding ADR
  0031 and amending ADR 0045.

## Long term

Themes for agent-heavy developers, in rough order. None has an issue yet;
each needs a design or ADR before work starts.

1. **Agent desk.** One view of every agent change in flight across a
   repository's worktrees, sorted by what needs you: ready for review, updates
   waiting for Refresh, agent replied, or waiting on the agent.
2. **Evidence per revision.** The agent attaches test runs, command output, or
   screenshots to a revision over MCP. Analysis and Walkthrough cite them, and
   a Finding can say whether a test covers it. This also supplies the
   "observed in a run" evidence #439 needs.
3. **Large diff triage.** For a big agent change, sort files into read
   carefully, skim, and generated, so attention goes where the risk is.
4. **Local Review to pull request handoff.** When the agent opens a pull
   request from a reviewed branch, the pull request Review starts with the
   local Review's Change intent, Insights, and resolved notes. Patchdesk still
   does not push or open the pull request itself (ADR 0051).
5. **Review memory.** Notes you repeat across Reviews become suggested rules
   for the repository's agent instructions, such as `AGENTS.md`, so the agent
   stops repeating the same mistake.
6. **Linux.** Many agent-heavy developers work on Linux machines. This means
   Linux packaging and release builds, replacements for macOS folder pickers
   and notifications, and a Linux verification pass.

## Not planned

- **Cross-repository pull requests view** (#57).
- **Notarized releases.** Installs keep the quarantine step for now.
- **Windows.**
- **Team features.** Patchdesk stays local-first with one reviewer per
  machine. GitHub is the shared layer; there is no sync service or shared
  Review state.
- **A review loop for cloud agent pull requests.** Pull requests opened by
  cloud coding agents stay ordinary pull requests.
