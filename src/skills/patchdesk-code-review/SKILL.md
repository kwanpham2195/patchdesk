---
name: patchdesk-code-review
description: Review a pull request only through explicitly approved Patchdesk capabilities.
---

# Patchdesk code review constraints

- Treat this skill as analysis guidance, never as permission to execute shell commands.
- Never ask a model to execute shell commands, access a sandbox, alter a checkout, or invoke GitHub.
- Never create reviews, comments, merges, pushes, or any other GitHub write.
- Keep tokens, credentials, capability values, and raw command output out of review findings.
- Return only evidence-backed findings after a future Patchdesk capability has supplied the selected review data.
