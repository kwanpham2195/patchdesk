import * as v from "valibot";
import type { CodexDiagnosticFields } from "./codex-explanation-diagnostics";

type FrameFields = Required<
  Pick<
    CodexDiagnosticFields,
    "argumentKind" | "validationField" | "validationRule"
  >
>;

/** Projects only the first issue; nested union issues and external prose never cross this boundary. */
export function classifyCodexExplanationFrame(
  argument: v.GenericIssue["input"],
  issue: v.GenericIssue | undefined,
): FrameFields {
  const argumentKind =
    argument === undefined
      ? "missing"
      : argument === null
        ? "null"
        : Array.isArray(argument)
          ? "array"
          : v.is(v.string(), argument)
            ? "string"
            : v.is(v.number(), argument) || v.is(v.nan(), argument)
              ? "number"
              : v.is(v.boolean(), argument)
                ? "boolean"
                : v.is(v.object({}), argument)
                  ? "object"
                  : "other";
  const extraKey =
    issue?.kind === "schema" &&
    issue.type === "strict_object" &&
    issue.expected === "never" &&
    issue.path?.at(-1)?.origin === "key";
  const validationField = extraKey
    ? "unexpected_field"
    : frameIssueField(issue);
  let validationRule: FrameFields["validationRule"] = "other";
  if (issue !== undefined) {
    if (extraKey) validationRule = "extra_key";
    else if (issue.input === undefined) validationRule = "missing";
    else if (issue.kind === "validation") {
      switch (issue.type) {
        case "min_length":
          validationRule = "empty";
          break;
        case "max_length":
          validationRule = "too_long";
          break;
        case "regex":
          validationRule = "pattern";
          break;
      }
    } else if (issue.kind === "schema") {
      switch (issue.type) {
        case "string":
        case "number":
        case "boolean":
        case "array":
        case "object":
        case "strict_object":
        case "variant":
        case "literal":
        case "union":
          validationRule = "type";
          break;
      }
    }
  }
  return { argumentKind, validationField, validationRule };
}

function frameIssueField(
  issue: v.GenericIssue | undefined,
): FrameFields["validationField"] {
  const path = issue?.path;
  const root = path?.[0],
    field = path?.[1],
    input = path?.[2];
  if (root?.type !== "object") return "other";
  if (path?.length === 1) {
    switch (root.key) {
      case "runId":
      case "generation":
      case "cancelEpoch":
      case "connection":
      case "correlation":
        return "host_identity";
      case "call":
        return "argument_root";
      default:
        return "other";
    }
  }
  if (root.key !== "call" || field?.type !== "object") return "other";
  if (path?.length === 2) {
    if (field.key === "input") return "argument_root";
    if (field.key === "tool") return "tool";
    return "other";
  }
  if (field.key !== "input" || input?.type !== "object") return "other";
  if (
    input.key === "hunkIds" &&
    path?.length === 4 &&
    path[3]?.type === "array"
  )
    return "hunk_ids";
  if (path?.length !== 3) return "other";
  switch (input.key) {
    case "opId":
      return "op_id";
    case "title":
      return "title";
    case "focus":
      return "focus";
    case "prose":
      return "prose";
    case "chapterId":
      return "chapter_id";
    case "sectionId":
      return "section_id";
    case "hunkIds":
      return "hunk_ids";
    default:
      return "other";
  }
}
