# Add state and contract Flow kinds

> **Status: Accepted.** Extends ADR 0039's Flow kinds. The node shape, the
> caps, and the rendering from ADR 0039 are unchanged.

ADR 0039 gave Flow three kinds: `call_tree`, `control_flow`, and `component`.
Two common changes fit none of them. A patch that rewires a lifecycle, such as
a write that used to fail on timeout and now becomes unknown until
reconciliation, is a change to states and transitions; a call tree shows the
functions that move it, and a control-flow sketch shows the conditions, but
neither shows which state leads to which. A patch that changes an exported
signature, type, or field is a change to a contract other code depends on;
the call tree can name the function, but not the old and new signature side
by side.

## The decision

Flow gains two kinds:

- `state` — a lifecycle's named states. Each root is one state as written in
  the code, such as `pending`. Its children are its outgoing transitions,
  written as `→ <next state> on <event>`, such as `→ failed on timeout`. Each
  state appears once as a root, even when a transition leads back to it.
- `contract` — an exported name and its shape. Each root is the exported
  name, such as `saveDraft`. Its children are its signature or its fields,
  one per line, as written in the patch. The old signature is marked removed
  and the new one added.

Both kinds use the same node shape as the other three: a label, an `added`,
`removed`, or `unchanged` marker, hunk citations, and children up to three
levels deep. The same caps apply. Flow still keeps at most one tree per kind
and at most three trees in all, so with five kinds the model chooses the
kinds that show the change most directly. The `component` rule that drops
the tree when the patch changes no user-interface file applies only to
`component`.

Both kinds render as the same diff-styled rows as the other views, with a
kind badge that reads `state` or `contract`. A state view reads:

```diff
 pending
   → confirmed on 2xx
-  → failed on timeout
+  → unknown on timeout
+unknown
+  → confirmed on reconcile match
```

A generated Mermaid state diagram for `state` is deferred. Rows cannot draw
a cycle as an edge, so a flow with many back-transitions may read poorly;
Patchdesk adds a diagram only when a trial on real pull requests shows that.

## Consequences

- The stored Brief schema accepts the two new kinds. A Brief retained before
  this decision parses unchanged, because the older kinds are still valid.
- A Brief retained with a `state` or `contract` tree does not parse in an
  older Patchdesk build.
- The guidance names five kinds against a cap of three trees, so a patch that
  touches every kind shows only the three the model ranks first.
