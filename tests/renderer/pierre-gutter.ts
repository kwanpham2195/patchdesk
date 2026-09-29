import { act, waitFor } from "@testing-library/react";

/** One diff line as Pierre numbers it: `additions` is the new side, `deletions` the old. */
export type GutterLine = {
  readonly line: number;
  readonly side?: "additions" | "deletions";
};

/**
 * Presses Pierre's own gutter `+` on `from` and releases it over `to`, the
 * pointer sequence a maintainer's click (`to` omitted) or drag makes. Pierre
 * draws the button inside each file's shadow root only once a line is
 * hovered, so jsdom has to hover first; Testing Library queries cannot reach
 * it.
 */
export async function dragDiffGutter(
  from: GutterLine,
  to: GutterLine = from,
): Promise<void> {
  // Pierre renders a file, and wires its pointer handling, a moment after mount.
  await waitFor(() => {
    if (hoveredGutterButton(from) === null)
      throw new Error(
        `Pierre drew no gutter button on line ${String(from.line)}`,
      );
  });
  const pointer = { bubbles: true, composed: true, pointerId: 1 };
  // One synchronous block: a React commit between hover and release can redraw the rows under the pointer.
  await act(async () => {
    const button = hoveredGutterButton(from);
    if (button === null) throw new Error("Pierre removed the gutter button");
    const end = numberCell(to);
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointer,
        pointerType: "mouse",
        button: 0,
      }),
    );
    end.dispatchEvent(
      new PointerEvent("pointermove", { ...pointer, pointerType: "mouse" }),
    );
    end.dispatchEvent(
      new PointerEvent("pointerup", {
        ...pointer,
        pointerType: "mouse",
        button: 0,
      }),
    );
  });
}

/** Hovers `target` and returns the gutter `+` Pierre draws there; throws until Pierre has drawn the line. */
export function hoveredGutterButton(target: GutterLine): HTMLElement | null {
  const cell = numberCell(target);
  cell.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
    }),
  );
  return cell.querySelector<HTMLElement>("[data-utility-button]");
}

function numberCell({ line, side = "additions" }: GutterLine): HTMLElement {
  const types =
    side === "additions"
      ? ["change-addition", "context"]
      : ["change-deletion", "context"];
  const cells = [...document.querySelectorAll("diffs-container")].flatMap(
    (host) => [
      ...(host.shadowRoot?.querySelectorAll<HTMLElement>(
        `[data-column-number="${String(line)}"]`,
      ) ?? []),
    ],
  );
  const matching = cells.filter((cell) =>
    types.includes(cell.getAttribute("data-line-type") ?? ""),
  );
  // In split view a context line has a number cell per side; the new side is drawn second.
  const cell = side === "additions" ? matching.at(-1) : matching.at(0);
  if (cell === undefined)
    throw new Error(`Pierre rendered no ${side} line ${String(line)}`);
  return cell;
}
