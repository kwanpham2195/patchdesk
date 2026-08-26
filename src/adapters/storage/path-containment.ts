import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

/**
 * The one path-containment check shared by worktree cleanup, the
 * preparation journal, and the review inspector, every destructive
 * filesystem operation that has to prove one path stays inside another
 * before it removes, renames, or reads it.
 *
 * A lexical `relative(root, candidate).startsWith("..")` check alone misses
 * two things a full containment check must reject:
 *
 * - `relative()` can, on Windows, return an absolute path outright (crossing
 *   drives has no relative form), so an `isAbsolute(relation)` check is
 *   required as well as the `".."` prefix check.
 * - a path that is lexically nested under root (no leading `".."`) but whose
 *   remaining segment happens to be named to read as a Windows-absolute
 *   path (for example an attacker-controlled ancestor symlink redirecting
 *   onto a directory literally named `C:\evil`) is rejected defensively via
 *   `win32.isAbsolute`, even when running on POSIX.
 *
 * The root itself counts as contained (`relation === ""`): a write directly
 * at the root is still owned by the root. A caller that must reject the
 * root itself (the review inspector, reading a file by relative path) adds
 * its own extra condition on top of this predicate rather than the
 * predicate special-casing it — the two callers disagree on this, and the
 * predicate cannot silently satisfy both.
 *
 * Callers are responsible for resolving symlinks (`realpath`) before
 * calling this: it only does path-string math, no filesystem I/O.
 */
export function isPathContained(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation) &&
      !win32.isAbsolute(relation))
  );
}
