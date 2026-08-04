# Retain the latest successful analysis and walkthrough

Each review retains one successful analysis result and one successful walkthrough until the maintainer requests a replacement. Starting a replacement does not remove the retained result. A successful run replaces it; a failed or cancelled run leaves it intact.

Every retained result remains bound to the pull request revision that produced it. After the code changes, Patchdesk may keep the result available but must mark it outdated and exclude it from current findings, evidence mapping, and readiness decisions. Patchdesk does not maintain a user-facing history of earlier generations.

An outdated result remains fully readable in its normal surface under a persistent revision warning. Patchdesk offers replacement for the current revision as the primary action, disables old evidence navigation, and does not provide a previous-revision viewer.
