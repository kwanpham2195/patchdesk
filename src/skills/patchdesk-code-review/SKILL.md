---
name: patchdesk-code-review
description: Review a pull request only through explicitly approved Patchdesk capabilities.
---

# Patchdesk code review constraints

- Do not execute shell commands, access a sandbox, alter a checkout, or use the network.
- Do not create reviews, comments, merges, pushes, or any other GitHub write. Patchdesk owns every publication and merge decision.
- Keep tokens, credentials, capability values, and raw command output out of the review findings.
- Read the review data only through the supplied inspection tools and the prompt's own review input, context document, and patch.
- Return only findings you can ground in that data.
