# Make Analysis merge policy configurable

Each workspace profile chooses how a current Analysis result affects merge: **Advisory**, **Require acknowledgement**, or **Block**. Require acknowledgement is the default. Advisory never changes merge availability; Require acknowledgement asks the maintainer to confirm current P0 or P1 Findings; Block prevents merge while current P0 or P1 Findings remain actionable.

An outdated Analysis never affects current merge behavior. GitHub merge rules, stale or unrefreshed remote state, unresolved write safety, and failed required checks remain non-configurable safety blocks.

A Finding is actionable, pending, published, or dismissed with a required reason. Adding a Finding to the GitHub pending review does not clear its effect on merge. Under the Block policy, only open P0 or P1 Findings block merge. Patchdesk does not expose a generic **Resolved** action because refreshed code and a replacement Analysis supply the evidence that a code concern is gone.

Every successful replacement Analysis creates a fresh Finding set. Dismissals do not carry between runs because model-supplied Finding identifiers and wording do not provide a stable semantic identity. Independently authored GitHub pending-review content remains untouched.
