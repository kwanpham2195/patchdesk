import { join } from "node:path";

import * as v from "valibot";

import { readJsonFile, writeAtomicJson } from "../adapters/storage/json-file";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";

export type WindowBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

const defaultBounds: WindowBounds = { x: 80, y: 80, width: 1280, height: 840 };

const coordinate = v.pipe(v.number(), v.finite());
const extent = v.pipe(v.number(), v.finite(), v.gtValue(0));
/** The on-disk window-state record; extra keys from older versions are ignored. */
const windowBoundsSchema = v.object({
  x: coordinate,
  y: coordinate,
  width: extent,
  height: extent,
});

export async function loadWindowBounds(
  workAreas: ReadonlyArray<WindowBounds>,
): Promise<WindowBounds> {
  const stored = await readJsonFile(windowStatePath());
  const parsed =
    stored._tag === "ok"
      ? v.safeParse(windowBoundsSchema, stored.value)
      : undefined;
  return clampWindowBounds(
    parsed !== undefined && parsed.success ? parsed.output : defaultBounds,
    workAreas,
  );
}

export async function saveWindowBounds(bounds: WindowBounds): Promise<void> {
  await writeAtomicJson(windowStatePath(), bounds);
}

/** Keep restored windows usable when displays disappear or change resolution. */
export function clampWindowBounds(
  bounds: WindowBounds,
  workAreas: ReadonlyArray<WindowBounds>,
): WindowBounds {
  const fallback = workAreas[0];
  if (fallback === undefined) return defaultBounds;
  const workArea = workAreas.reduce(
    (best, candidate) =>
      intersectionArea(bounds, candidate) > intersectionArea(bounds, best)
        ? candidate
        : best,
    fallback,
  );
  const width = Math.min(
    Math.max(bounds.width, Math.min(960, workArea.width)),
    workArea.width,
  );
  const height = Math.min(
    Math.max(bounds.height, Math.min(640, workArea.height)),
    workArea.height,
  );
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function windowStatePath(): string {
  return join(PatchdeskPaths.default().configDirectory(), "window-state.json");
}

function intersectionArea(left: WindowBounds, right: WindowBounds): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  return width * height;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
