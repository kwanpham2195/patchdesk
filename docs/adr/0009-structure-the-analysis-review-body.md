# Structure the Analysis Review body

Every Analysis result produces a predictable Review body for preview and GitHub publication. It includes **Review Scope**, **Pull Request Overview**, **Reviewed Changes**, **Findings**, and **Verdict** in that order.

**Verification** and **Human Reviewer Callouts** appear when the Analysis has relevant evidence or follow-up guidance. Patchdesk omits empty optional sections instead of generating filler. Models supply structured content for this contract rather than an arbitrary Markdown document.

The Verdict proposes **Comment**, **Approve**, or **Request changes** and preselects the matching GitHub review decision in the publication preview. The maintainer may change that decision. Patchdesk keeps the Analysis Verdict visible and never publishes or changes the GitHub decision automatically.
