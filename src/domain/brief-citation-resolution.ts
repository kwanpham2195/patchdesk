import { BRIEF_ALIAS_SYNTAX, type BriefCitation } from "./brief-citation";

/*
 * A leaf module, like `brief-citation.ts`: it imports nothing from `brief.ts`
 * or `brief-flow.ts`, so both of those may depend on it without a cycle.
 * `brief-flow.ts` imports it from here directly, which is what breaks the
 * cycle the two of them used to form.
 */

/** The aliases one item resolved to, and how many of them named nothing. */
export type ResolvedBriefCitations = {
  readonly citations: ReadonlyArray<BriefCitation>;
  readonly rejected: number;
};

/**
 * Resolves a list of citation aliases against one manifest, dropping an
 * alias that names nothing and a repeat of one already used. Used by
 * `normalizeBriefFlow` (`brief-flow.ts`), which narrows further to hunk-only
 * citations after this.
 */
export function resolveBriefCitations(
  aliases: ReadonlyArray<string>,
  byAlias: ReadonlyMap<string, BriefCitation>,
): ResolvedBriefCitations {
  const citations: Array<BriefCitation> = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const alias of aliases) {
    const entry = BRIEF_ALIAS_SYNTAX.test(alias)
      ? byAlias.get(alias)
      : undefined;
    if (entry === undefined || seen.has(alias)) {
      rejected += 1;
      continue;
    }
    seen.add(alias);
    citations.push(entry);
  }
  return { citations, rejected };
}
