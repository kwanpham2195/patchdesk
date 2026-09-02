import type { RepoRelativePath } from "./ids";

/*
 * A leaf module: no import here may depend on `brief.ts` or `brief-flow.ts`.
 * Both of those import from here (directly, or through
 * `brief-citation-resolution.ts`), so this file existing separately is what
 * keeps `brief.ts` <-> `brief-flow.ts` from becoming a cycle. `brief.ts`
 * re-exports everything below, so an existing importer of `BriefCitation`,
 * `BriefManifest`, or `BRIEF_ALIAS_SYNTAX` from `./brief` needs no change.
 */

/**
 * Which kind of evidence one Brief alias resolves to. `description` and
 * `commit` are kept for stored Briefs from 0.1.3; nothing new emits `d*` or
 * `c*` (ADR 0040) -- Flow, the one block left that cites anything, cites
 * hunks only.
 */
type BriefCitationKind = "hunk" | "description" | "commit";

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

/**
 * `h*` hunks, `d*` description paragraphs, `c*` commits; anything else is not
 * an alias. Kept for stored Briefs from 0.1.3; nothing new emits `d*` or `c*`
 * (ADR 0040).
 */
export const BRIEF_ALIAS_SYNTAX = /^[hdc][1-9]\d*$/;
