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

/**
 * The one member of a `FileHandle` the fsync-ordering test calls through to:
 * enough to invoke the real `sync()` on whichever handle a spied call landed
 * on, without naming the whole `FileHandle` surface.
 */
type SyncableHandle = { sync: () => Promise<void> };

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

  it("fsyncs the file handle before the rename and the directory handle after it, as two distinct handles", async () => {
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
    //
    // Identity says which handles are synced, never when, and when is the
    // whole durability guarantee: a rename that publishes the name before the
    // bytes are flushed can leave a file that exists but is empty or torn
    // after a crash, and an fsync of the directory before the rename does
    // nothing to make that rename survive one. `rename` is a module binding
    // rather than a method on a shared prototype, so it cannot be spied on to
    // order calls against it without mocking `node:fs/promises` wholesale,
    // which is exactly what the prototype spy above exists to avoid. Have
    // each `sync()` record the directory as it stands at that instant
    // instead — the durable state the guarantee is about, not a proxy for it.
    // Before the rename the bytes are only under the temp name; after it,
    // only under the target name.
    const directory = await tempDirectory();
    const probePath = join(directory, ".probe");
    const probeHandle = await open(probePath, "w");
    const fileHandlePrototype: {
      sync: (this: SyncableHandle) => Promise<void>;
      writeFile: (...args: unknown[]) => Promise<void>;
    } = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    // The probe file has served its purpose (reaching the prototype) and
    // would otherwise show up in the directory listings recorded below.
    await rm(probePath);
    const realSync = fileHandlePrototype.sync;
    const directoryAtEachSync: string[][] = [];
    const syncSpy = vi
      .spyOn(fileHandlePrototype, "sync")
      .mockImplementation(async function (this: SyncableHandle): Promise<void> {
        directoryAtEachSync.push((await readdir(directory)).sort());
        await realSync.call(this);
      });
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
    // The file handle is the one synced first, the directory second.
    expect(syncSpy.mock.instances[0]).toBe(fileHandle);
    expect(syncSpy.mock.instances[1]).not.toBe(fileHandle);
    // And the rename falls between the two: at the handle fsync the bytes are
    // still under the temp name with no target published, while at the
    // directory fsync the rename has landed and the temp name is gone.
    expect(directoryAtEachSync).toHaveLength(2);
    const [atHandleSync, atDirectorySync] = directoryAtEachSync;
    expect(atHandleSync?.some((entry) => entry.endsWith(".tmp"))).toBe(true);
    expect(atHandleSync).not.toContain("artifact.bin");
    expect(atDirectorySync).toEqual(["artifact.bin"]);
  });
});
