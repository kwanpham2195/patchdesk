import { screen } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

/** The viewed count trigger's accessible name, such as "3/15 viewed". */
export const VIEWED_COUNT = /^\d+\/\d+ viewed$/;

/**
 * Opens a diff toolbar menu. Base UI's menu trigger opens on a real mousedown,
 * which jsdom's synthetic pointer sequence does not satisfy, so the keyboard
 * is the only way in here; the pointer path is checked live.
 */
export async function openToolbarMenu(
  user: User,
  name: string | RegExp,
): Promise<void> {
  screen.getByRole("button", { name }).focus();
  await user.keyboard("{Enter}");
}

/** Chooses a Patch view, All changes, or Since your review from the Changes menu. */
export async function chooseChanges(user: User, name: string): Promise<void> {
  await openToolbarMenu(user, "Changes");
  await user.click(await screen.findByRole("menuitemradio", { name }));
}

/** Runs Mark all viewed or Show all from the viewed count's menu. */
export async function chooseViewedAction(
  user: User,
  name: "Mark all viewed" | "Show all",
): Promise<void> {
  await openToolbarMenu(user, VIEWED_COUNT);
  await user.click(await screen.findByRole("menuitem", { name }));
}

/** Chooses All files or Selected in View options, then closes the popover. */
export async function chooseFileMode(
  user: User,
  name: "All files" | "Selected",
): Promise<void> {
  await user.click(screen.getByRole("button", { name: "View options" }));
  await user.click(await screen.findByRole("button", { name }));
  await user.keyboard("{Escape}");
}
