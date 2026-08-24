# Run Call Flow as a revision-bound one-shot analysis

Call Flow explains which calls changed and keeps only the resolved ancestors needed to understand them. It is a deterministic Review reading aid, not a complete runtime graph, an Insight, a model result, or a source of GitHub review authority.

## The decision

Call Flow is a fourth top-level Review workbench screen beside Conversation, Diff, and Insights. The screen compares the immutable base and head commits recorded by the current Review session. It shows compact changed-call explanations, a raw CallDiff view, source links, search, and unchanged context controls. `New only` projects added calls with the unchanged ancestors needed to explain each path. `Call Diff` presents removed base paths and added head paths in side-by-side Before and After panes.

Patchdesk runs one exact `calldiff` `runDiff` analysis in an Electron-as-Node child process for every supported source extension, including Go. The parent sends one bounded invocation through stdin. The child returns one strictly parsed and bounded JSON value through stdout, then exits. The child receives the represented-review worktree path and the session's base and head SHAs. It never reads a mutable maintainer checkout or GitHub state.
The strict node contract accepts `call` and `branch`, which are the node kinds emitted by `calldiff`. Call Flow is syntactic and does not claim receiver, collaborator, interface, implementation, or runtime semantics. An added or removed edge is compared with an existing definition on both revisions; an edge to a one-revision definition stops at that edge.

The first release supports five packaged source languages: Go, JavaScript, JSX, TypeScript, and TSX. Go uses exact `tree-sitter@0.25.1` and `tree-sitter-go@0.25.0` production packages. `calldiff` resolves that installed grammar before it considers its on-demand cache, so Patchdesk does not download parsers. The macOS package keeps their published N-API prebuilt binaries instead of rebuilding native addons on the packaging machine. Package filters exclude local `build/` outputs so `node-gyp-build` selects the published target prebuild. A target without the exact packaged prebuilt is unsupported until package verification proves it. The child inherits no general process environment and has no GitHub credentials or network capability.

The service deduplicates one active analysis per Review session. It caches successful and unsupported results for that immutable session. It does not cache unavailable results, so Retry starts a new child after a timeout or execution failure. A returned snapshot must match the workbench session and head SHA before the renderer displays it.

Call Flow source links return to the canonical Diff screen from Paths, New only, and Call Diff. Removed nodes select the old side. Added and unchanged nodes select the new side. Shift-click selects more than one path step without changing screens.

## Why Call Flow is not an Insight

Insights are retained Analysis and Walkthrough results with their own run lifecycle. Call Flow is a deterministic projection of one immutable commit pair. It has no provider selection, generated prose, retained record, or GitHub review command.

Putting it inside Insights would make a local parser look like a model run and would add lifecycle states that do not apply. A separate workbench screen keeps the interaction direct while the Diff remains the source of revision and line evidence.

## Limits

`calldiff` performs syntax-based inference. It does not resolve types, imports, dynamic dispatch, runtime data, side effects, test coverage, or execution probability. A path is an inferred reading aid, not proof that production code executes that path.

The parent limits source files, result trees, nodes, raw output size, and child runtime. Reaching a bound produces a clear unavailable or truncated state. Reviews with no changed supported source files show an unsupported state and remain usable.

## Rejected alternatives

Run CallDiff in the Electron main process. Rejected because parsing a large repository would block the main event loop and weaken the process boundary used for bounded analysis.

Make Call Flow a model-generated Insight. Rejected because the source engine is deterministic and does not need model authority or Insight retention.

Install language parsers on demand. Rejected because a Review read should not cause an implicit network or package installation. New languages require an explicit packaged dependency and a new support decision.

## Consequences

- The production build has a second main-process entry for the Call Flow runner.
- Electron Builder native dependency rebuilds stay disabled; packaging verification must prove the published parser prebuilt loads in the packaged Call Flow child.
- A represented-review worktree is required. Metadata-only Reviews show Call Flow as unavailable.
- The renderer can navigate from an inferred step to the canonical diff but cannot write to GitHub from Call Flow.
- Upgrading `calldiff` changes analysis behavior and requires focused real-repository tests before the version changes.
