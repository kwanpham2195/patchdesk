import type {
  RegisteredCheckout,
  RelocatedCheckout,
} from "#src/services/local-repository-service";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type {
  WorkspaceRepositorySet,
  WorkspaceSetupStatus,
} from "#src/services/workspace-setup-service";
import type { SetupCommandName } from "./setup-commands";
import { callPatchdeskApp } from "./socket-client";

const setupSubcommands = {
  status: "setup_status",
  "add-repo": "setup_add_repo",
  "add-checkout": "setup_add_checkout",
  "set-checkout": "setup_set_checkout",
  "relocate-checkout": "setup_relocate_checkout",
} as const satisfies Record<string, SetupCommandName>;

type SetupCliIo = {
  readonly socketPath: string;
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly report: (line: string) => void;
};

/**
 * `patchdesk setup <status|add-checkout|relocate-checkout|add-repo|set-checkout> [--cwd <path>] [--json]`
 * (#702). Returns the exit code, or undefined when the arguments name no
 * setup command, so the caller prints its usage.
 */
export async function runSetupCommand(
  args: ReadonlyArray<string>,
  io: SetupCliIo,
): Promise<number | undefined> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        cwd: { type: "string" },
        json: { type: "boolean" },
        "repository-id": { type: "string" },
        confirm: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return undefined;
  }
  const [subcommand, ...rest] = parsed.positionals;
  const command = Object.entries(setupSubcommands).find(
    ([name]) => name === subcommand,
  )?.[1];
  if (command === undefined || rest.length > 0) return undefined;
  if (command === "setup_status" && parsed.values.cwd !== undefined)
    return undefined;
  const relocation = command === "setup_relocate_checkout";
  const repositoryId = parsed.values["repository-id"];
  if (
    relocation !== (repositoryId !== undefined) ||
    (!relocation && parsed.values.confirm !== undefined)
  )
    return undefined;
  const folder = { cwd: resolve(io.cwd, parsed.values.cwd ?? ".") };
  const call = await callPatchdeskApp(io.socketPath, {
    tool: command,
    arguments:
      command === "setup_status"
        ? {}
        : relocation
          ? {
              ...folder,
              repositoryId,
              confirm: parsed.values.confirm === true,
            }
          : folder,
  });
  if (!call.reply.ok) {
    io.report(`${call.reply.error}: ${call.reply.message}`);
    return 1;
  }
  // A relocation without --confirm only previews; it is not a success.
  // SAFETY: the dispatcher replies to setup_relocate_checkout with a RelocatedCheckout.
  const previewOnly =
    relocation && (call.reply.result as RelocatedCheckout).relocated === false;
  if (parsed.values.json === true) {
    io.out(`${JSON.stringify(call.reply.result, null, 2)}\n`);
    return previewOnly ? 1 : 0;
  }
  // SAFETY: the app answered this command ok, and its setup dispatcher replies
  // with the result type this command names; both sides build from this repository.
  io.out(
    command === "setup_status"
      ? describeStatus(call.reply.result as WorkspaceSetupStatus)
      : command === "setup_add_checkout"
        ? describeRegisteredCheckout(call.reply.result as RegisteredCheckout)
        : relocation
          ? describeRelocation(call.reply.result as RelocatedCheckout)
          : describeRepositorySet(call.reply.result as WorkspaceRepositorySet),
  );
  return previewOnly ? 1 : 0;
}

/** The status as lines a person or an agent reads, ending with the steps still to do. */
export function describeStatus(status: WorkspaceSetupStatus): string {
  const account = status.githubAccounts.find((candidate) => candidate.active);
  const lines = [
    `git: ${status.git}`,
    `gh: ${status.gh}`,
    `GitHub: ${status.github.kind === "disconnected" ? "not connected" : account === undefined ? "not signed in" : `${account.login} on ${account.host}`}`,
    `Workspace: ${status.profile === undefined ? "none" : status.profile.ghAccount === undefined ? status.profile.label : `${status.profile.label} (${status.profile.ghAccount})`}`,
  ];
  for (const registration of status.localRepositories)
    lines.push(
      `Checkout: ${registration.displayName} (${registration.id}, ${registration.state})`,
    );
  if (status.repositories.length > 0) lines.push("Repositories:");
  for (const repository of status.repositories)
    lines.push(
      `  ${repository.owner}/${repository.repo}: ${repositoryCheckout(repository)}`,
    );
  const steps = nextSteps(status);
  lines.push(
    steps.length === 0 ? "Setup is complete." : "Next steps:",
    ...steps.map((step) => `  - ${step}`),
  );
  return `${lines.join("\n")}\n`;
}

function repositoryCheckout(
  repository: WorkspaceSetupStatus["repositories"][number],
): string {
  switch (repository.checkout) {
    case "chosen":
      return repository.localPath ?? "";
    case "missing":
      return `${repository.localPath ?? ""} (missing)`;
    case "not_chosen":
      return "no checkout";
  }
}

function nextSteps(status: WorkspaceSetupStatus): ReadonlyArray<string> {
  const steps: string[] = [];
  if (status.git === "missing") steps.push("Install git.");
  if (status.github.kind === "connected" && status.gh === "missing")
    steps.push("Install the GitHub CLI (gh).");
  if (status.github.kind === "connected" && status.githubAuth !== "ready")
    steps.push("The user runs gh auth login.");
  if (status.localRepositories.length === 0 && status.repositories.length === 0)
    steps.push(
      "Run patchdesk setup add-checkout --cwd <path> to register a checkout.",
    );
  for (const registration of status.localRepositories)
    if (
      registration.state === "missing" &&
      registration.identityKey.kind === "local"
    )
      steps.push(
        `Run patchdesk setup relocate-checkout --repository-id ${registration.id} --cwd <path> --confirm in the moved checkout of ${registration.displayName}.`,
      );
  for (const repository of status.repositories) {
    const name = `${repository.owner}/${repository.repo}`;
    if (repository.checkout === "missing")
      steps.push(
        `Run patchdesk setup set-checkout in the moved checkout of ${name}.`,
      );
    if (repository.checkout === "not_chosen")
      steps.push(`Run patchdesk setup add-repo in a checkout of ${name}.`);
  }
  return steps;
}

function describeRelocation(moved: RelocatedCheckout): string {
  const { registration } = moved;
  const reviews = moved.affectedReviews.map(
    (review) => `  ${review.reviewId} ${review.title}`,
  );
  const header = `${moved.relocated ? "Relocated" : "Not relocated: rerun with --confirm to move"} ${registration.displayName} (${registration.id}) to ${moved.checkout}.`;
  return `${[
    header,
    moved.affectedReviews.length === 0
      ? "No Reviews belong to it."
      : `Reviews that keep their IDs (${moved.affectedReviews.length}):`,
    ...reviews,
  ].join("\n")}\n`;
}

function describeRegisteredCheckout(set: RegisteredCheckout): string {
  return `Registered ${set.registration.displayName} (${set.registration.id}) in ${set.profile.label}.\nCheckout: ${set.checkout}\n`;
}

function describeRepositorySet(set: WorkspaceRepositorySet): string {
  const name = `${set.repository.owner}/${set.repository.repo}`;
  return `${[
    ...(set.profileCreated
      ? [
          `Created the ${set.profile.label} workspace for ${set.profile.ghAccount}.`,
        ]
      : []),
    set.repositoryAdded
      ? `Added ${name} to the ${set.profile.label} workspace.`
      : `The ${set.profile.label} workspace already watches ${name}.`,
    `Checkout: ${set.localPath}`,
  ].join("\n")}\n`;
}
