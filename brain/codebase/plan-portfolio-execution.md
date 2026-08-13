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
- Plan 006 is complete. ADR-0018 records the Flue 2 one-shot child and
  capability boundary. The exact isolated runtime owns Flue 2.0.3 and Pi
  0.84.1; root consumes its generated version/digest-bound model catalog.
- Production Insight children never inherit the complete Electron environment.
  They receive only the selected provider's allowlisted values, fixed system
  PATH/locale, and approved ambient HOME.
- Preserve pre-existing dirty work and inspect committed, staged, and unstaged
  path diffs before each plan.
- Plan 007 is complete. Its graph check uses exact Rollup module identities;
  Pierre theme metadata is generated and parity-checked without entering the
  eager graph. Performance timing begins after a double-animation-frame paint
  boundary and keeps the original 200 ms interaction ceilings.
