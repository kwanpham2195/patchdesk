# Authenticate GitHub as the profile account

> **Amended by ADR 0046, "Call the GitHub API directly".** The rule below — every
> call runs as the account the workspace profile names, resolved through
> `gh auth token` and cached in memory — is unchanged. What changed is how the
> credential is carried: Patchdesk sends it as a request header from the main
> process rather than through a `gh` child's `GH_TOKEN`/`GH_ENTERPRISE_TOKEN`
> environment. `gh auth token` is still the only source of the credential, and
> the token is still never logged or persisted.

Every GitHub call Patchdesk makes runs as the account configured on the workspace profile that owns the work, never as whichever GitHub CLI account happens to be active machine-wide. The adapter resolves that account's stored credential through the GitHub CLI (`gh auth token --hostname <host> --user <account>`), caches it in memory for a short window, and supplies it to each `gh` child through its environment — `GH_TOKEN` for github.com and ghe.com hosts, `GH_ENTERPRISE_TOKEN` for GitHub Enterprise Server hosts. Patchdesk never switches the machine-wide active account, never logs or persists a token, and never asks the maintainer to switch accounts by hand to work in a profile. When a profile's account has no usable stored credential, the call fails closed as an authentication failure before it reaches GitHub, and a credential GitHub rejects is dropped from the cache so the next attempt re-reads it. Profiles therefore stay live side by side, each on its own account.
