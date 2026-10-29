import { err, type Result } from "#src/domain/result";
import {
  isConnectedWorkspaceProfile,
  type ConnectedWorkspaceProfile,
  type WorkspaceProfileConfig,
} from "#src/domain/workspace-profile";
import type { GitHubWriteFailure } from "#src/domain/github-write";
import type { GitHubReadFailure } from "./gh-request-runner";

/** The adapter's read boundary requires a configured connection before dispatch. */
export async function readConnectedGitHub<
  Input extends { readonly profile: WorkspaceProfileConfig },
  Value,
>(
  input: Input,
  read: (
    connected: Input & { readonly profile: ConnectedWorkspaceProfile },
  ) => Promise<Result<Value, GitHubReadFailure>>,
): Promise<Result<Value, GitHubReadFailure>> {
  if (!isConnectedWorkspaceProfile(input.profile))
    return err({
      _tag: "GitHubAuthenticationFailed",
      operation: "auth_status",
    });
  return read({ ...input, profile: input.profile });
}

/** A disconnected workspace cannot dispatch a GitHub write. */
export async function writeConnectedGitHub<
  Input extends { readonly profile: WorkspaceProfileConfig },
  Value,
>(
  input: Input,
  write: (
    connected: Input & { readonly profile: ConnectedWorkspaceProfile },
  ) => Promise<Result<Value, GitHubWriteFailure>>,
): Promise<Result<Value, GitHubWriteFailure>> {
  if (!isConnectedWorkspaceProfile(input.profile))
    return err({
      _tag: "GitHubWriteFailure",
      category: "auth",
      message: "Workspace has no GitHub connection.",
    });
  return write({ ...input, profile: input.profile });
}
