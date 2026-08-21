/** Mirrors `ReviewWorkbenchActions["reportNavigationState"]`'s state union --
 * kept as its own tiny module (rather than declared inside a component file)
 * so every fixture component that reports navigation state can import the
 * same type without creating a circular import back through
 * `app-fixtures.tsx`. */
export type NavigationState = "clear" | "dirty_draft" | "write_pending";
