import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeAtomicFile } from "../../../src/adapters/storage/json-file";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-write-atomic-file-"));
  roots.push(root);
  return root;
}

describe("writeAtomicFile", () => {
  it("leaves no .tmp file behind on success", async () => {
    const directory = await tempDirectory();
    const target = join(directory, "artifact.bin");

    const written = await writeAtomicFile(target, "hello world");

    expect(written._tag).toBe("ok");
    expect(await readFile(target, "utf8")).toBe("hello world");
    const entries = await readdir(directory);
    expect(entries).toEqual(["artifact.bin"]);
    expect(entries.some((entry) => entry.includes(".tmp"))).toBe(false);
  });

  it("accepts raw bytes as well as strings", async () => {
    const directory = await tempDirectory();
    const target = join(directory, "artifact.bin");
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const written = await writeAtomicFile(target, bytes);

    expect(written._tag).toBe("ok");
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
  });

  it("leaves no partial target when rename fails, and cleans up its temp file", async () => {
    // A real (not simulated-via-mocking) `rename` failure: Node's `rename`
    // rejects with EISDIR when the destination is an existing directory, so
    // pre-creating `target` as one forces the same rename-failure branch a
    // mocked `rename` would, without any module or dependency mocking.
    const directory = await tempDirectory();
    const target = join(directory, "artifact.bin");
    await mkdir(target);
    await writeFile(join(target, "already-here"), "unrelated", "utf8");

    const written = await writeAtomicFile(target, "should never land");

    expect(written).toMatchObject({
      _tag: "err",
      error: { operation: "write", reason: "io" },
    });
    // The target is still the pre-existing directory, untouched by the
    // failed rename, and no `.tmp` sibling was left behind by the cleanup.
    const entries = await readdir(directory);
    expect(entries).toEqual(["artifact.bin"]);
    expect(await readdir(target)).toEqual(["already-here"]);
  });

  it("fsyncs both the file handle it wrote to and the directory handle, as two distinct handles", async () => {
    // `FileHandle` instances share one prototype, so spying on it (a real
    // object, not a module namespace) observes every `sync()`/`writeFile()`
    // call this write makes — including the temp file handle `writeAtomicFile`
    // opens internally — without mocking the `node:fs/promises` module itself.
    //
    // `writeAtomicFile` makes two separate fsync calls: one on the temp file
    // handle (`syncBestEffort`), one on a handle opened just to fsync the
    // containing directory (`syncDirectoryBestEffort`). Asserting only
    // `toHaveBeenCalled()` on a `sync` spy shared by both handles cannot tell
    // "both fsyncs ran" apart from "one of them ran once" — either mutant
    // leaves that assertion green. Pin it by identity instead: exactly one
    // handle ever receives `writeFile` (the temp file), and `sync` is called
    // on that same handle *and* on a second, different handle (the
    // directory) — which only holds if both fsyncs actually ran.
    const directory = await tempDirectory();
    const probeHandle = await open(join(directory, ".probe"), "w");
    const fileHandlePrototype: {
      sync: () => Promise<void>;
      writeFile: (...args: unknown[]) => Promise<void>;
    } = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const syncSpy = vi.spyOn(fileHandlePrototype, "sync");
    const writeFileSpy = vi.spyOn(fileHandlePrototype, "writeFile");
    const target = join(directory, "artifact.bin");

    const written = await writeAtomicFile(target, "synced");

    expect(written._tag).toBe("ok");
    // Exactly one handle in this write ever has contents written to it: the
    // temp file. (The directory handle is opened read-only, and only fsynced.)
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const fileHandle = writeFileSpy.mock.instances[0];
    // That file handle is fsynced (the handle fsync)...
    expect(syncSpy.mock.instances).toContain(fileHandle);
    // ...and so is a second, different handle: the directory (the directory
    // fsync). Two calls total, and not both on the file handle.
    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(
      syncSpy.mock.instances.some((instance) => instance !== fileHandle),
    ).toBe(true);
  });
});
