# Review schema evolution

- Persisted `ReviewSession` data is an upgrade boundary, not an internal implementation detail.
- Before changing its schema, inventory every reader, writer, fixture, and recovery path.
- Prove the real open/load flow with a prior-version stored-session fixture. The result must either:
  - migrate to the current schema while preserving user-owned state, or
  - enter a clear safe recovery path that does not leave the PR unable to open.
- Keep stored schemas strict. Do not silently discard unknown fields just to parse stale data.
- Test migration or recovery through the local API and renderer boundary, not only a storage parser.
