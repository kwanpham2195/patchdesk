# Remove the Call Flow feature

Call Flow (ADR "Run Call Flow as a revision-bound one-shot analysis") never shipped in a tagged release. No maintainer saw it outside development. It is removed rather than kept behind a flag.

## The decision

Patchdesk removes Call Flow: the workbench screen, the `call-flow-service.ts` and `call-flow-child-invoker.ts` services, the `call-flow-runner.ts` main-process entry, the renderer panel, and their domain types and tests. The `calldiff`, `tree-sitter`, and `tree-sitter-go` dependencies are removed with it; nothing else in Patchdesk depends on them.

The renderer's persisted workbench UI state (`patchdesk.workbench-ui.v1.*` in `localStorage`, see `screen-restore.ts`) can still hold an old `activeTab: "call_flow"` value written before this change. `activeTabSchema` drops `call_flow` from its picklist, and the surrounding field already uses `v.fallback(v.optional(activeTabSchema), undefined)`: an unrecognized stored value is dropped, not rejected, so the workbench opens on its default tab instead of failing to restore. No migration of stored state is needed.

This supersedes ADR "Run Call Flow as a revision-bound one-shot analysis", which is kept as historical record.

## Consequences

- The production build loses its second main-process entry for the Call Flow runner.
- Packaging no longer needs to verify a published Go parser prebuild loads in a Call Flow child.
- The dependency tree drops `calldiff`, `tree-sitter`, and `tree-sitter-go`.
- The changelog carries no entry for this removal: Call Flow was never in a tagged release, so there is nothing for a maintainer to notice as gone.
