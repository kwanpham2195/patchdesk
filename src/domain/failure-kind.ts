/**
 * The class of a service refusal, independent of transport. Each service
 * exports one table from its failure reasons to these kinds; the local API
 * answers a kind with an HTTP status, and an MCP tool reports the reason
 * itself (ADR 0052 "Error model").
 */
export type FailureKind =
  | "invalid"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unavailable";

/** A service's reason table: total over its reasons, so a new reason fails the build until it is classified. */
export type FailureKinds<Reason extends string> = {
  readonly [Key in Reason]: FailureKind;
};
