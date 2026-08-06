---
created_at: 2026-08-06
repos: [cfw/patchdesk]
status: proposed
---

# Watchlist, Profile, and Model Selection

Simplify the watchlist to a tick-based discovery surface, auto-detect profiles from the active `gh` account, and show provider-prefixed model labels.

## Watchlist

- Workspace roots stay in profile settings. Discovery finds git repos under each root.
- Repos are grouped by workspace root. Already-watched repos show pre-ticked. Toggle to add or remove.
- Remove manual `owner/repo` text input, path mapping, archive action, and history retention.
- Refresh scoped to the active view, not every watched repo.

## Profile and gh account

- `gh` account is the source of truth. Patchdesk auto-detects the active account via `gh api user`.
- Profile switcher in the app shell. Switching profiles runs `gh auth switch`. Switching `gh auth` in the terminal auto-selects the matching profile.
- Hierarchy: `gh` account → profile → workspace roots → watchlist → inbox.

## Model selection

- Model combobox label uses `provider/model-code` format (same as the internal `id`).
- Change `projectModels` label from `model.name` to `provider/id`.

## Out of scope

- Custom saved inbox views.
- Owner filters (keep as-is until Discovery proves they are redundant).
