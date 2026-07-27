# Patchdesk Design uses a browser mock boundary

Patchdesk Design will be a standalone browser entrypoint in this repository. It will reuse the existing renderer components and styles for product surfaces, while supplying typed in-memory mock data and actions instead of the local API, GitHub, filesystem, Electron preload, or service layer. This preserves visual parity and makes scenarios deterministic, resettable, and safe to share as design references.

## Considered options

- Reuse the production Electron entrypoint with live services: rejected because design review would depend on credentials, local state, and external systems.
- Duplicate the UI into a separate prototype: rejected because visual fixes would drift between the prototype and Patchdesk.

## Consequences

- The Design app needs a separate development command and scenario registry.
- Mock payloads must satisfy the same renderer-facing contracts as production payloads.
- Browser-rendered product surfaces can be compared against the Electron renderer; native macOS window chrome is outside the parity target.
