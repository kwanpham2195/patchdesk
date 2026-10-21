import type { GuideReadFailure } from "#src/domain/guide-progress";
import { guidePreparedInputCodec } from "#src/domain/guide-preparation";
import type { InsightTextRootDescriptor } from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import {
  GUIDE_PAGE_BUDGET_BYTES,
  decodeCursor,
  encodeCursor,
} from "./guide-result-projection";
import type { GuideResultView } from "./guide-result-reader";

type Position = { readonly block: number; readonly unit: number };

const HEADER = "\ndiff --git ";
/** Enough of the previous block to see a header line split across two blocks. */
const CARRY_UNITS = HEADER.length - 1;

/**
 * Serves the captured patch of one file, selected by validated `fN`, from the prepared immutable evidence of the
 * published result: never the current source and never the whole patch. File start positions come from one streaming
 * scan of the stored patch blocks (kept for the last result only); the inventory count must match the number of file
 * headers found, or the result is reported invalid rather than guessed at.
 */
export class GuideCapturedFilePages {
  private offsets:
    | { readonly digest: string; readonly starts: ReadonlyArray<Position> }
    | undefined;

  async part(
    view: GuideResultView,
    fileId: string,
    cursor: string | null,
  ): Promise<
    Result<
      { readonly text: string; readonly next: string | null },
      GuideReadFailure
    >
  > {
    const number = Number(fileId.slice(1));
    if (!(number >= 1 && number <= view.root.inventory.count))
      return err("invalid_cursor");
    const scope = `captured_patch:${fileId}`;
    const at = decodeCursor(cursor, {
      digest: view.digest,
      kind: "text",
      scope,
    });
    if (at === undefined) return err("invalid_cursor");
    const prepared = await view.artifacts.readObject(
      view.profileId,
      view.reviewId,
      guidePreparedInputCodec,
      view.root.preparation,
    );
    if (prepared._tag === "err") return err("invalid_result");
    const patch = prepared.value.patch;
    const starts = await this.startsOf(view, patch);
    if (starts === undefined || starts.length !== view.root.inventory.count)
      return err("invalid_result");
    const begin = starts[number - 1];
    const end = starts[number];
    if (begin === undefined) return err("invalid_result");
    let position: Position =
      cursor === null ? begin : { block: at.p, unit: at.u };
    if (
      before(position, begin) ||
      (end !== undefined && !before(position, end))
    )
      return err("invalid_cursor");
    let text = "";
    let bytes = 0;
    for (;;) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a part reads a few consecutive blocks
      const read = await view.store.readTextPart(patch, position, 4_096);
      if (read._tag === "err") return err("invalid_result");
      let piece = read.value.text;
      if (end !== undefined && position.block === end.block)
        piece = piece.slice(0, Math.max(0, end.unit - position.unit));
      const fitted = fit(piece, GUIDE_PAGE_BUDGET_BYTES - bytes);
      text += fitted.text;
      bytes += fitted.bytes;
      const advanced: Position | null =
        fitted.text.length < piece.length
          ? { block: position.block, unit: position.unit + fitted.text.length }
          : read.value.next;
      const finished =
        advanced === null || (end !== undefined && !before(advanced, end));
      if (finished) return ok({ text, next: null });
      if (
        fitted.text.length < piece.length ||
        bytes >= GUIDE_PAGE_BUDGET_BYTES - 6_144
      )
        return ok({
          text,
          next: encodeCursor({
            d: view.digest,
            k: "text",
            s: scope,
            p: advanced.block,
            u: advanced.unit,
          }),
        });
      position = advanced;
    }
  }

  /** Where each file's block starts, in header order: one pass over the stored patch blocks, cached per result digest. */
  private async startsOf(
    view: GuideResultView,
    patch: InsightTextRootDescriptor,
  ): Promise<ReadonlyArray<Position> | undefined> {
    if (this.offsets?.digest === view.digest) return this.offsets.starts;
    const starts: Position[] = [];
    let carry = "";
    let previous: { block: number; length: number } | undefined;
    let position: Position | null =
      patch.data.blocks.count === 0 ? null : { block: 0, unit: 0 };
    while (position !== null) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- every continuation advances the immutable patch position
      const read = await view.store.readTextPart(patch, position, 4_096);
      if (read._tag === "err") return undefined;
      const text = read.value.text;
      const first = position.block === 0 && position.unit === 0;
      const combined = (first ? "\n" : "") + carry + text;
      const shift = (first ? 1 : 0) + carry.length;
      for (
        let at = combined.indexOf(HEADER);
        at >= 0;
        at = combined.indexOf(HEADER, at + 1)
      ) {
        const start = position.unit + at + 1 - shift;
        starts.push(
          start >= 0 ||
            previous === undefined ||
            previous.block === position.block
            ? { block: position.block, unit: Math.max(0, start) }
            : { block: previous.block, unit: previous.length + start },
        );
      }
      carry = combined.slice(-CARRY_UNITS);
      previous = { block: position.block, length: position.unit + text.length };
      const next = read.value.next;
      if (next !== null && !before(position, next)) return undefined;
      position = next;
    }
    this.offsets = { digest: view.digest, starts };
    return starts;
  }
}

function before(left: Position, right: Position): boolean {
  return (
    left.block < right.block ||
    (left.block === right.block && left.unit < right.unit)
  );
}

/** The longest prefix of `text` whose JSON-escaped UTF-8 size fits `budget`, never splitting a surrogate pair. */
function fit(text: string, budget: number) {
  let bytes = 0;
  let at = 0;
  while (at < text.length) {
    const unit = text.charCodeAt(at);
    const pair = unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length;
    const cost = pair
      ? 4
      : unit === 0x22 ||
          unit === 0x5c ||
          unit === 0x0a ||
          unit === 0x09 ||
          unit === 0x0d
        ? 2
        : unit < 0x20 || (unit >= 0x7f && unit < 0x80)
          ? 6
          : unit < 0x80
            ? 1
            : unit < 0x800
              ? 2
              : 3;
    if (bytes + cost > budget) break;
    bytes += cost;
    at += pair ? 2 : 1;
  }
  return { text: text.slice(0, at), bytes };
}
