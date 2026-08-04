# Run Insight types independently

Each Insight type owns at most one active generation run. Analysis and Walkthrough may run concurrently, report progress independently, and fail or retry without changing the other Insight.

Starting a replacement affects only the same Insight type. Files and the Review draft remain usable while Insight work runs. This keeps future Insight types from sharing one global generation queue or one overloaded review-completion state.

Detecting newer GitHub activity does not cancel active Insight work. Patchdesk warns that the result may be outdated, revokes any authorized auto-publication, and lets the run finish against its immutable revision unless the maintainer cancels it. After refresh moves the workbench forward, a successful old-revision result remains readable as outdated.
