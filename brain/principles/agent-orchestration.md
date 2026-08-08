# Agent Orchestration

The primary agent coordinates multi-agent work and remains accountable for decisions, source changes, verification, and the final report.

**Concurrency limit:** at most one worker, one reviewer, and one tester at a time.

**Tool roles:**
- Use `subagent` to delegate tasks, share context, receive reports, and cancel or supersede requests.
- Treat subagent results as coordination aids, not proof of current application state.

**Evidence:** Verify the freshness of agent results from their session, route, viewport, and timestamp. The primary validates conclusions before acting on them.
