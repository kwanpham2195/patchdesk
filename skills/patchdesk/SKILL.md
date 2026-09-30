---
name: patchdesk
description: Hand your code change to the user for review in Patchdesk, a macOS review app, and act on their notes. Use when the user asks for a review in Patchdesk, says "check Patchdesk", or asks you to install or connect Patchdesk.
---

# Patchdesk

Patchdesk is a macOS app where the user reviews your change beside its diff and leaves notes on its lines. You reach it through the `patchdesk` MCP server; your host may prefix the tool names, as Claude Code shows `mcp__patchdesk__review_local`.

## When the tools are missing

If no Patchdesk tools are available, set Patchdesk up from a terminal in the checkout under review, usually your working directory. Skip any step that is already done:

1. Run `patchdesk setup status`.
   - Command not found: follow the setup prompt under "Finish setup" in https://raw.githubusercontent.com/kwanpham2195/patchdesk/main/README.md.
   - `app_not_running`: run `open -a Patchdesk`, wait a few seconds, and retry.
   - `app_outdated`: ask the user to quit and reopen Patchdesk.
   - It asks for `gh auth login`: stop and ask the user to run it.
2. If the status does not list this repository with this checkout, run `patchdesk setup add-repo`.
3. If your host has no `patchdesk` server (`claude mcp get patchdesk` or `codex mcp get patchdesk`), register one over stdio with the command `patchdesk` and the argument `mcp`, for example `claude mcp add patchdesk -- patchdesk mcp`. A server registered only for another folder does not load here; register it for this project too. Then run `patchdesk mcp --check`.
4. Tell the user to restart you from this checkout so the tools load.

## Review loop

<!-- START AUTOMATED REVIEW LOOP -->

Patchdesk is the user's review desk for your changes. The user stays the reviewer: an Insight runs only after they press Run, and the Review moves to your newer code only when they press Refresh.

- When the user asks for a review in Patchdesk, call `review_local` with your working directory as `cwd` and the task you were given as `intent`.
- To get an Analysis, Walkthrough, or Brief, call `run_insight` with the `reviewId` and `sessionId` from `review_local`. It returns `awaiting_approval`: stop, and tell the user the request waits for their approval in Patchdesk. Call `get_insight` when the user says it ran.
- Before `get_feedback`, call `list_local_reviews` with your working directory as `cwd` to find the Review the user is looking at, and use its `reviewId`. If it returns several Reviews for your branch, ask the user which base they meant.
- When the user says "check Patchdesk", call `get_insight` for any Insight you requested, then `get_feedback` with `open: true`; address every Finding and comment, and answer each comment with `reply_to_note`: `addressed`, `skipped` with the reason, or `question`. Then call `refresh_review` and tell the user the changes are ready. To get an Insight on the new code, call `run_insight` with the `preparedSessionId` from `refresh_review`; on `awaiting_refresh`, tell the user to press Refresh in Patchdesk.

<!-- END AUTOMATED REVIEW LOOP -->

## Refusals you can fix

- `checkout_not_found` or `no_profile`: run `patchdesk setup add-repo` in the checkout under review, then retry.
- `checkout_missing`: the checkout moved. Run `patchdesk setup set-checkout` in its new folder, then retry.
- `base_required`: pass `base`, the branch this change should be compared with, such as `main`.

For any other refusal, relay its message to the user. Troubleshooting in https://raw.githubusercontent.com/kwanpham2195/patchdesk/main/docs/mcp.md lists every code.
