import type { RepoRelativePath } from "./ids";

/*
 * A leaf module: no import here may depend on `brief.ts` or `brief-flow.ts`.
 * Both of those import from here (directly, or through
 * `brief-citation-resolution.ts`), so this file existing separately is what
 * keeps `brief.ts` <-> `brief-flow.ts` from becoming a cycle. `brief.ts`
 * re-exports everything below, so an existing importer of `BriefCitation`,
 * `BriefManifest`, or `BRIEF_ALIAS_SYNTAX` from `./brief` needs no change.
 */

/** Which kind of evidence one Brief alias resolves to. */
export type BriefCitationKind = "hunk" | "description" | "commit";

/**
 * One resolvable alias offered to the Brief model and, once resolved, one
 * citation carried on a Brief sentence. The alias namespace is prefixed --
 * `h*` hunks, `d*` description paragraphs, `c*` commits -- so a citation names
 * its evidence kind before anything looks it up.
 */
export type BriefCitation = {
  readonly alias: string;
  readonly kind: BriefCitationKind;
  readonly label: string;
  readonly path?: RepoRelativePath;
};

/** The immutable alias-to-source manifest supplied to the Brief model. */
export type BriefManifest = ReadonlyArray<BriefCitation>;

/** `h*` hunks, `d*` description paragraphs, `c*` commits; anything else is not an alias. */
export const BRIEF_ALIAS_SYNTAX = /^[hdc][1-9]\d*$/;
