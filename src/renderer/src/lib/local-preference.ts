import * as v from "valibot";

/**
 * A `localStorage`-backed renderer preference: one key, one schema, and the
 * value every failed read falls back to.
 *
 * Reads are total. A missing key, a store that cannot be reached at all
 * (a browser in private mode throws on `window.localStorage`), stored text
 * that is not the expected format, and a value the schema rejects all return
 * `defaultValue`. A stored value written by an older build must never break
 * the screen that reads it.
 *
 * A rejected value stays in storage rather than being cleared. `load` runs
 * during render, so it must not write; and a value this build rejects can be
 * one another build still understands — `diff-theme-preferences.ts` reads
 * exactly such a value through its v1 path.
 *
 * Writes are best effort for the same reason: a full or unreachable store
 * loses the preference, not the interaction that changed it.
 *
 * Each preference owns its own key and its own read, so one unreadable key
 * cannot cost another its value. How much of a *single* rejected record is
 * lost is the schema's decision, not this module's — see ADR 0022 "Choose a
 * validation style by data boundary": preference schemas give every field its
 * own `v.fallback` so one bad field resets only itself, while the Codex model
 * cache deliberately rejects the whole list because a refetch rebuilds it.
 */
export type LocalPreference<Output, Fallback, Scope> = {
  /** Reads the stored value, falling back to `defaultValue`. Never throws. */
  readonly load: (scope: Scope) => Output | Fallback;
  /** Persists a value. A failed write is swallowed. */
  readonly save: (scope: Scope, value: Output) => void;
  /** Removes the stored value. A failed removal is swallowed. */
  readonly clear: (scope: Scope) => void;
  /** Applies the schema to an already-decoded value, falling back the same way `load` does. */
  readonly parse: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the localStorage boundary parser; callers pass JSON already parsed out of storage or off a CustomEvent detail, and there is no earlier boundary to parse at.
    value: unknown,
  ) => Output | Fallback;
};

type PreferenceDefinition<Output, Fallback, Scope> = {
  /** The storage key, or how to build it from a profile id or similar scope. */
  readonly key: string | ((scope: Scope) => string);
  readonly schema: v.GenericSchema<unknown, Output>;
  /** What every failed read returns. */
  readonly defaultValue: Fallback;
  /**
   * Turns the stored text into a value for the schema. Defaults to JSON.
   * Override it for a key whose stored text is not JSON.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- decoding stops at text; `schema` is what gives the decoded value a type, one line later.
  readonly decodeStored?: (raw: string) => unknown;
  /**
   * Turns a value into the shape written to storage, which is then serialised
   * as JSON. Defaults to the value itself. Override it for a key whose stored
   * shape wraps the value, such as a `{ version, preferences }` envelope.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the stored shape is whatever JSON.stringify accepts; naming it would mean naming an envelope type per preference.
  readonly encodeStored?: (value: Output) => unknown;
};

/** Defines one `localStorage`-backed preference. See {@link LocalPreference}. */
export function definePreference<Output, Fallback = Output, Scope = void>(
  definition: PreferenceDefinition<Output, Fallback, Scope>,
): LocalPreference<Output, Fallback, Scope> {
  const {
    key,
    schema,
    defaultValue,
    decodeStored = decodeJson,
    encodeStored = identity,
  } = definition;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `key` is this module's own two-shape option, not external input: a fixed key, or one built from a scope.
  const keyFor = typeof key === "string" ? () => key : key;

  const parse = (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the localStorage boundary parser; `schema` is the parse.
    value: unknown,
  ): Output | Fallback => {
    const parsed = v.safeParse(schema, value);
    return parsed.success ? parsed.output : defaultValue;
  };

  return {
    parse,
    load: (scope) => {
      const stored = readStored(keyFor(scope));
      if (stored === undefined) return defaultValue;
      try {
        return parse(decodeStored(stored));
      } catch {
        return defaultValue;
      }
    },
    save: (scope, value) => {
      try {
        globalThis.window?.localStorage.setItem(
          keyFor(scope),
          JSON.stringify(encodeStored(value)),
        );
      } catch {
        // Best effort. A full or unreachable store loses the preference; the
        // interaction that changed it still completes.
      }
    },
    clear: (scope) => {
      try {
        globalThis.window?.localStorage.removeItem(keyFor(scope));
      } catch {
        // Best effort. The value this removes is already stale.
      }
    },
  };
}

/** Reads one key, treating an absent key and an unreachable store alike. */
function readStored(key: string): string | undefined {
  try {
    return globalThis.window?.localStorage.getItem(key) ?? undefined;
  } catch {
    // Reading `window.localStorage` itself throws in a browser configured to
    // block site data, before any key is involved.
    return undefined;
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- the decoded value is genuinely unknown here; the caller's schema is what gives it a type.
function decodeJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  return parsed;
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- the stored shape is whatever JSON.stringify will accept; only the caller's encodeStored knows more.
function identity<Output>(value: Output): unknown {
  return value;
}
