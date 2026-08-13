# Plan portfolio execution

- Active source queue: `plans/README.md`; execute Plans 001-008 in order.
- Cross-plan evidence tracker:
  `.agents/PLANS/2026-08-13-complete-plan-portfolio.md`.
- Goal completion requires every plan DONE plus a requirement-by-requirement
  portfolio audit. Plan status alone is not proof.
- Use one implementation writer at a time. The parent reviews diffs and direct
  runtime evidence before advancing the queue.
- Keep Herdr tabs `patchdesk logs live` and `patchdesk dev live` active; IDs are
  ephemeral. The dev app must own CDP 9233.
- Plan 006 needs a new ADR for the Flue 2 one-shot child/capability boundary
  before production migration.
- Preserve pre-existing dirty work and inspect committed, staged, and unstaged
  path diffs before each plan.
