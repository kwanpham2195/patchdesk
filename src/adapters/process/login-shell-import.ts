/**
 * The launch's one login-shell import, as something a reader can wait on.
 *
 * The import runs beside the window rather than before it (ADR 0038, amended
 * 2026-09-19), so whatever needs an imported PATH or provider credential
 * waits here instead of the whole app waiting for a shell to source the
 * maintainer's dotfiles. It is held as a module value because the readers —
 * every child spawn, the Pi child invoker, the provider catalog, Codex
 * discovery — reach the process environment ambiently too, the way
 * `requestAbortContext` in `command-runner.ts` is reached.
 */
let running: Promise<void> | undefined;

/** Starts the launch's login-shell import. A second call returns the first one's promise, so it runs exactly once. */
export function startLoginShellEnvironmentImport(
  importEnvironment: () => Promise<void>,
): Promise<void> {
  running ??= importEnvironment();
  return running;
}

/**
 * Resolves once this launch's login-shell import has finished, successfully
 * or not, and immediately when none was started — a unit test, a script, or
 * any platform where the import does nothing at all. The import bounds itself
 * at three seconds, so this wait is bounded too.
 */
export function whenLoginShellEnvironmentImported(): Promise<void> {
  return running ?? Promise.resolve();
}
