# Patchdesk Design

This context names the design-review concepts shared by the Patchdesk product UI and its standalone visual prototype.

## Design language

**Interactive visual prototype**:
A faithful, runnable representation of the product UI used to evaluate visual design and interaction states before production data and services are connected.
_Avoid_: throwaway mock, low-fidelity wireframe

**Design scenario**:
A stable, named product state that can be opened directly for design review, such as an empty inbox, a completed review, or a merge confirmation.
_Avoid_: random fixture, test case

**Design index**:
The discovery surface for the available design scenarios. It belongs to the Design app and is not part of the Patchdesk product shell.
_Avoid_: product dashboard, settings page

**Product surface**:
The app-rendered Patchdesk UI that users evaluate, including the shell, inbox, workbench, settings, dialogs, and state feedback.
_Avoid_: native window chrome, backend screen
