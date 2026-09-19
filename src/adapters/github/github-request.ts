/**
 * What the GitHub adapter asks GitHub for, described once instead of as an
 * argv array per call site, so a later change of transport is a change to the
 * runner rather than to every caller (ADR 0046).
 */
export type GitHubRequest =
  | GitHubRestRequest
  | GitHubGraphQlRequest
  | GitHubPullRequestDiffRequest;

/** The verbs this adapter sends; an absent method is a GET. */
type GitHubRestMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export type GitHubRestRequest = {
  readonly kind: "rest";
  readonly host: string;
  /** Path under the API root, query string included, already URL-encoded by the caller. */
  readonly path: string;
  readonly method?: GitHubRestMethod;
  /** Media type the response is wanted in, when the default JSON is not it. */
  readonly accept?: string;
  /** Serialized JSON request body, sent to gh on stdin rather than through a shell. */
  readonly jsonBody?: string;
  /** jq filter gh applies to the response. */
  readonly jq?: string;
  /** Follow every page and answer one array of pages (`--paginate --slurp`). */
  readonly paginate?: boolean;
};

export type GitHubGraphQlRequest = {
  readonly kind: "graphql";
  readonly host: string;
  readonly document: string;
  /** Sent in this order, because gh passes repeated variables through as given. */
  readonly variables: ReadonlyArray<GitHubGraphQlVariable>;
};

/**
 * One GraphQL variable. The distinction is load-bearing: `string` always
 * arrives as a GraphQL String (gh's `-f`), which is how a numeric-looking
 * owner, branch, or search term stays a String, while `typed` lets gh infer
 * the type (`-F`) for the numbers and ids that need it.
 */
type GitHubGraphQlVariable =
  | {
      readonly kind: "string";
      readonly name: string;
      readonly value: string;
    }
  | {
      readonly kind: "typed";
      readonly name: string;
      readonly value: string | number;
    }
  /**
   * A real GraphQL list, which gh sends as one repeated `-F 'name[]=<value>'`
   * pair per element (verified live on gh 2.96.0).
   */
  | {
      readonly kind: "list";
      readonly name: string;
      readonly values: ReadonlyArray<string>;
    };

/** The one read that is not an API call: `gh pr diff` for a pull request with no local checkout. */
type GitHubPullRequestDiffRequest = {
  readonly kind: "pull_request_diff";
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

/** The gh invocation a request becomes, minus the parts the runner owns. */
export type GhInvocation = {
  readonly argv: ReadonlyArray<string>;
  readonly stdin?: string;
};

export function ghInvocationFor(request: GitHubRequest): GhInvocation {
  if (request.kind === "graphql") return { argv: graphQlArgv(request) };
  if (request.kind === "pull_request_diff")
    return { argv: pullRequestDiffArgv(request) };
  return restInvocation(request);
}

function restInvocation(request: GitHubRestRequest): GhInvocation {
  const argv = [
    "gh",
    "api",
    ...(request.paginate === true ? ["--paginate", "--slurp"] : []),
    "--hostname",
    request.host,
    ...(request.method === undefined ? [] : ["--method", request.method]),
    ...(request.accept === undefined
      ? []
      : ["-H", `Accept: ${request.accept}`]),
    request.path,
    ...(request.jsonBody === undefined ? [] : ["--input", "-"]),
    ...(request.jq === undefined ? [] : ["--jq", request.jq]),
  ];
  return request.jsonBody === undefined
    ? { argv }
    : { argv, stdin: request.jsonBody };
}

function graphQlArgv(request: GitHubGraphQlRequest): ReadonlyArray<string> {
  return [
    "gh",
    "api",
    "graphql",
    "--hostname",
    request.host,
    "-f",
    `query=${request.document}`,
    ...request.variables.flatMap(variableArgv),
  ];
}

function variableArgv(variable: GitHubGraphQlVariable): ReadonlyArray<string> {
  if (variable.kind === "list")
    return variable.values.flatMap((value) => [
      "-F",
      `${variable.name}[]=${value}`,
    ]);
  return [
    variable.kind === "string" ? "-f" : "-F",
    `${variable.name}=${variable.value}`,
  ];
}

function pullRequestDiffArgv(
  request: GitHubPullRequestDiffRequest,
): ReadonlyArray<string> {
  return [
    "gh",
    "pr",
    "diff",
    String(request.number),
    "--repo",
    `${request.host}/${request.owner}/${request.repo}`,
    "--patch",
  ];
}
