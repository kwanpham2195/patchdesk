import type {
  Dashboard,
  DashboardScreenState,
  Profile,
} from "./renderer-models";
import type { InboxResponse } from "./renderer-contracts";
import { record, stringArray } from "./json-guards";

type WorkspaceState = {
  readonly profiles: ReadonlyArray<Profile>;
  readonly dashboard?: Dashboard;
  readonly inbox?: InboxResponse;
  readonly screen: DashboardScreenState;
  readonly refreshing: boolean;
  readonly refreshFailed: boolean;
};

export type WorkspaceAction =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly screen: DashboardScreenState }
  | {
      readonly _tag: "loaded";
      readonly profiles: ReadonlyArray<Profile>;
      readonly inbox: InboxResponse;
      readonly dashboard: Dashboard;
      readonly screen: DashboardScreenState;
    }
  | { readonly _tag: "refreshStarted" }
  | {
      readonly _tag: "refreshSucceeded";
      readonly inbox: InboxResponse;
      readonly dashboard: Dashboard;
      readonly screen: DashboardScreenState;
    }
  | { readonly _tag: "refreshFailed" }
  | { readonly _tag: "refreshFinished" }
  | { readonly _tag: "cleared" };

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action._tag) {
    case "loading":
      return { ...state, screen: "loading" };
    case "failed":
      return { ...state, screen: action.screen };
    case "loaded":
      return {
        ...state,
        profiles: action.profiles,
        inbox: action.inbox,
        dashboard: action.dashboard,
        screen: action.screen,
        refreshFailed: false,
      };
    case "refreshStarted":
      return { ...state, refreshing: true, refreshFailed: false };
    case "refreshSucceeded":
      return {
        ...state,
        inbox: action.inbox,
        dashboard: action.dashboard,
        screen: action.screen,
        refreshFailed: false,
      };
    case "refreshFailed":
      return { ...state, refreshFailed: true };
    case "refreshFinished":
      return { ...state, refreshing: false };
    case "cleared":
      return {
        profiles: state.profiles,
        refreshing: state.refreshing,
        refreshFailed: false,
        screen: "loading",
      };
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the Profile I/O boundary parser for the raw /v1/profiles response; there is no earlier boundary to move the parse to.
export function isProfile(value: unknown): value is Profile {
  return (
    record(value) &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof value.id === "string" &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof value.label === "string" &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof value.githubHost === "string" &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof value.ghAccount === "string" &&
    (value.workspaceRoots === undefined || stringArray(value.workspaceRoots)) &&
    (value.ownerFilters === undefined || stringArray(value.ownerFilters)) &&
    (value.rulePaths === undefined || stringArray(value.rulePaths))
  );
}
export function dashboardFromInbox(inbox: InboxResponse): Dashboard {
  const workspaceRootsField =
    inbox.profile.workspaceRoots === undefined
      ? {}
      : { workspaceRoots: inbox.profile.workspaceRoots };
  const ownerFiltersField =
    inbox.profile.ownerFilters === undefined
      ? {}
      : { ownerFilters: inbox.profile.ownerFilters };
  const rulePathsField =
    inbox.profile.rulePaths === undefined
      ? {}
      : { rulePaths: inbox.profile.rulePaths };
  const reposField =
    inbox.profile.repos === undefined ? {} : { repos: inbox.profile.repos };
  return {
    profile: {
      id: inbox.profile.id,
      label: inbox.profile.label,
      githubHost: inbox.profile.githubHost,
      ghAccount: inbox.profile.ghAccount,
      ...workspaceRootsField,
      ...ownerFiltersField,
      ...rulePathsField,
      ...reposField,
    },
    dashboard: {
      repos: inbox.inbox.repositories.map((outcome) => {
        const resumeAtField =
          outcome.resumeAt === undefined ? {} : { resumeAt: outcome.resumeAt };
        const forbiddenReasonField =
          outcome.forbiddenReason === undefined
            ? {}
            : { forbiddenReason: outcome.forbiddenReason };
        return {
          repo: {
            host: outcome.repo.host,
            owner: outcome.repo.owner,
            repo: outcome.repo.repo,
          },
          state: outcome.state,
          ...resumeAtField,
          ...forbiddenReasonField,
        };
      }),
    },
  };
}
