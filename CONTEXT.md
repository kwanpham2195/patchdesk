# Patchdesk glossary

## Review item

A local, snapshot-bound action that may later be sent to GitHub: an inline
comment, thread reply, or thread-state change. Human and model items share the
same structure; provenance records how the item started.

## Provenance

The local origin of a review item: `human` or `model`. It is not the GitHub
author. When a human changes a model item, the UI may concisely say `Model
draft · edited by you`.

## Review batch

The one durable collection of local review items for an immutable prepared PR
snapshot. A model run may add or replace its own items, but never removes human
items.
