# Seed Review drafts from Analysis

> **Status: Superseded.** ADR-0015 allows Analysis only to prefill Finish review after a Finding-backed GitHub pending review exists; it never seeds a local draft.

An Analysis result produces a complete Review body plus safely mapped inline comments. When the active Review draft is empty, Patchdesk seeds it automatically from that result so the maintainer can edit and explicitly publish the same review package that GitHub will display.

If the Review draft already contains maintainer edits, Patchdesk does not overwrite them. It asks the maintainer to merge the Analysis into the draft or replace the draft with it before changing any draft content.

Merge keeps existing Review body text first under **Maintainer notes**, appends the generated Analysis body unchanged, preserves manual inline comments, and adds mapped Finding comments that are not already present. Patchdesk previews the result before applying it and does not attempt a paragraph-level Markdown merge.
