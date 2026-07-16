import type { Hono } from "hono";

/**
 * SAFETY: This mirrors Flue's narrow routing export while its beta.9 declaration graph
 * imports an invalid third-party declaration. Runtime resolution remains the package export.
 */
export declare function flue(): Hono;
