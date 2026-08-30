import * as v from "valibot";

import {
  BRIEF_ALIAS_SYNTAX,
  type BriefCitation,
  type BriefDescriptionDrift,
  type BriefError,
  type NormalizedBrief,
} from "./brief";
import { definedProps } from "./defined-props";
import {
  parseContentHash,
  parseGitSha,
  parseRepoRelativePath,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";

const storedCitationSchema = v.strictObject({
  alias: v.pipe(v.string(), v.regex(BRIEF_ALIAS_SYNTAX)),
  kind: v.picklist(["hunk", "description", "commit"]),
  label: v.string(),
  path: v.optional(v.string()),
});
const storedBriefSchema = v.strictObject({
  snapshot: v.strictObject({
    profileId: v.string(),
    sessionId: v.string(),
    headSha: v.string(),
    patchHash: v.string(),
  }),
  citationStatus: v.picklist(["verified", "partially_verified"]),
  goal: v.pipe(
    v.array(
      v.strictObject({
        text: v.pipe(v.string(), v.minLength(1)),
        citations: v.pipe(v.array(storedCitationSchema), v.minLength(1)),
      }),
    ),
    v.minLength(1),
  ),
  assumptions: v.array(
    v.strictObject({ text: v.string(), demoted: v.boolean() }),
  ),
  /** Absent on every Brief retained before the description-vs-diff block existed. */
  descriptionDrift: v.optional(
    v.strictObject({
      claimed: v.array(
        v.strictObject({
          quote: v.pipe(v.string(), v.minLength(1)),
          note: v.string(),
          citations: v.pipe(v.array(storedCitationSchema), v.minLength(1)),
        }),
      ),
      undescribed: v.array(
        v.strictObject({
          text: v.pipe(v.string(), v.minLength(1)),
          citations: v.pipe(v.array(storedCitationSchema), v.minLength(1)),
        }),
      ),
    }),
  ),
});

type StoredBriefCitation = v.InferOutput<typeof storedCitationSchema>;

/**
 * Parses one Brief that storage already holds. A retained Brief carries its own
 * resolved citation labels, so reading it back needs no patch bytes -- unlike a
 * Walkthrough, which must be renormalized against its session's patch.
 */
export function parseStoredBrief(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the stored Brief's read boundary; the very next statement runs `safeParse(storedBriefSchema, input)` against it before anything else touches it.
  input: unknown,
): Result<NormalizedBrief, BriefError> {
  const parsed = v.safeParse(storedBriefSchema, input);
  if (!parsed.success) return malformedBrief();
  const profileId = parseWorkspaceProfileId(parsed.output.snapshot.profileId);
  const sessionId = parseReviewSessionId(parsed.output.snapshot.sessionId);
  const headSha = parseGitSha(parsed.output.snapshot.headSha);
  const patchHash = parseContentHash(parsed.output.snapshot.patchHash);
  if (
    profileId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
  )
    return malformedBrief();
  const goal: Array<NormalizedBrief["goal"][number]> = [];
  for (const item of parsed.output.goal) {
    const citations = parseStoredCitations(item.citations);
    if (citations === undefined) return malformedBrief();
    goal.push({ text: item.text, citations });
  }
  const drift = parsed.output.descriptionDrift;
  const claimed: Array<BriefDescriptionDrift["claimed"][number]> = [];
  const undescribed: Array<BriefDescriptionDrift["undescribed"][number]> = [];
  for (const item of drift?.claimed ?? []) {
    const citations = parseStoredCitations(item.citations);
    if (citations === undefined) return malformedBrief();
    claimed.push({ quote: item.quote, note: item.note, citations });
  }
  for (const item of drift?.undescribed ?? []) {
    const citations = parseStoredCitations(item.citations);
    if (citations === undefined) return malformedBrief();
    undescribed.push({ text: item.text, citations });
  }
  return ok({
    snapshot: {
      profileId: profileId.value,
      sessionId: sessionId.value,
      headSha: headSha.value,
      patchHash: patchHash.value,
    },
    citationStatus: parsed.output.citationStatus,
    goal,
    assumptions: parsed.output.assumptions,
    ...definedProps({
      descriptionDrift:
        drift === undefined ? undefined : { claimed, undescribed },
    }),
  });
}

/** Re-parses one stored citation list; `undefined` means a path no longer parses. */
function parseStoredCitations(
  stored: ReadonlyArray<StoredBriefCitation>,
): ReadonlyArray<BriefCitation> | undefined {
  const citations: Array<BriefCitation> = [];
  for (const citation of stored) {
    const path =
      citation.path === undefined
        ? undefined
        : parseRepoRelativePath(citation.path);
    if (path?._tag === "err") return undefined;
    citations.push({
      alias: citation.alias,
      kind: citation.kind,
      label: citation.label,
      ...definedProps({ path: path?.value }),
    });
  }
  return citations;
}

/** Every way a stored Brief can fail to read is the same failure: it is not one. */
function malformedBrief(): Result<never, BriefError> {
  return err({ _tag: "InvalidBrief", reason: "malformed" });
}
