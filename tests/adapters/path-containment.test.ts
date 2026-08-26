import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import { isPathContained } from "../../src/adapters/storage/path-containment";

// Every containment check that guards a destructive filesystem operation
// (worktree cleanup, the preparation journal, the review inspector) shares
// this one predicate. These cases are the shapes that a lexical
// `startsWith("..")` check gets wrong or that a naive implementation could
// regress on.
describe("isPathContained", () => {
  it("treats the root itself as contained", () => {
    // `relative(root, root)` is "". This is the journal's existing, more
    // permissive contract: a write directly at the root is still owned by
    // the root. Callers that must reject the root itself (the inspector)
    // add their own extra condition on top of this predicate.
    expect(isPathContained("/tmp/root", "/tmp/root")).toBe(true);
  });

  it("rejects the parent directory", () => {
    expect(isPathContained("/tmp/root", "/tmp")).toBe(false);
  });

  it("rejects a path that escapes by one segment", () => {
    expect(isPathContained("/tmp/root", "/tmp/x")).toBe(false);
  });

  it("resolves an unnormalized candidate before checking containment", () => {
    // The candidate string itself contains ".." segments that only escape
    // the root once resolved; a check that compares raw strings (or only
    // the final `relative()` output without first resolving both sides)
    // could be fooled by this. `resolve()` collapses "x/../.." down to the
    // grandparent of root before `relative()` ever runs.
    expect(isPathContained("/tmp/root/a", "/tmp/root/a/x/../..")).toBe(false);
  });

  it("accepts a genuine descendant", () => {
    expect(isPathContained("/tmp/root", "/tmp/root/child/file.txt")).toBe(true);
  });

  it("rejects an absolute candidate outside the root", () => {
    expect(isPathContained("/tmp/root", "/completely/different")).toBe(false);
  });

  it("rejects a relative() result that reads as a Windows-absolute path", () => {
    // `path.relative` can never itself return a POSIX-absolute string (POSIX
    // has one root, "/"), so the only way to exercise the `win32.isAbsolute`
    // guard on this platform is a path that is lexically nested under root
    // (no leading "..") but whose remaining segment is itself named to look
    // like a Windows drive path. Patchdesk never names a directory this way
    // itself, but an attacker-controlled ancestor symlink can redirect a
    // real, expected path onto one that is (see the worktree cleanup
    // regression test). The predicate must reject it defensively rather
    // than only checking for a leading "..".
    const candidate = ["", "tmp", "root", "C:\\evil", "file.txt"].join(sep);
    expect(isPathContained("/tmp/root", candidate)).toBe(false);
  });

  it("rejects a candidate that is lexically a sibling with a shared prefix", () => {
    // Guards against the classic `target.startsWith(root)` string-prefix
    // bug; `relative()` operates on path segments, so "root2" must not be
    // treated as contained in "root".
    expect(isPathContained("/tmp/root", "/tmp/root2/file.txt")).toBe(false);
  });
});
