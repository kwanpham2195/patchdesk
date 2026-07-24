import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { requestJson } from "../api-client";
import {
  DIFF_DARK_THEMES,
  DIFF_LIGHT_THEMES,
  type DiffThemePreferences,
} from "../diff-theme-preferences";
import type { AppearancePreference } from "../appearance-preferences";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import type { Dashboard, Profile, Repo } from "../renderer-models";

export function SettingsFlow({
  dashboard,
  paths,
  setPaths,
  newRepo,
  setNewRepo,
  profileDraft,
  setProfileDraft,
  appearance,
  onAppearanceChange,
  diffThemePreferences,
  onDiffThemeChange,
  suggestions,
  discoveryFeedback,
  profiles,
  pathFeedback,
  onAdd,
  onSaveProfile,
  onDiscover,
  onAddSuggestion,
  onSelectProfile,
  onPath,
  onChoosePath,
  onRemove,
  onArchive,
  onRefreshRepo,
}: {
  readonly dashboard?: Dashboard;
  readonly paths: Record<string, string>;
  readonly setPaths: Dispatch<SetStateAction<Record<string, string>>>;
  readonly newRepo: string;
  readonly setNewRepo: (value: string) => void;
  readonly profileDraft: {
    readonly id: string;
    readonly label: string;
    readonly githubHost: string;
    readonly ghAccount: string;
    readonly workspaceRoot: string;
  };
  readonly setProfileDraft: Dispatch<
    SetStateAction<{
      id: string;
      label: string;
      githubHost: string;
      ghAccount: string;
      workspaceRoot: string;
    }>
  >;
  readonly appearance: AppearancePreference;
  readonly onAppearanceChange: (value: AppearancePreference) => void;
  readonly diffThemePreferences: DiffThemePreferences;
  readonly onDiffThemeChange: (value: DiffThemePreferences) => void;
  readonly suggestions: ReadonlyArray<Repo>;
  readonly discoveryFeedback: string | undefined;
  readonly profiles: ReadonlyArray<Profile>;
  readonly pathFeedback?: string;
  readonly onAdd: () => void;
  readonly onSaveProfile: () => void;
  readonly onDiscover: () => void;
  readonly onAddSuggestion: (repo: Repo) => void;
  readonly onSelectProfile: (id: string) => void;
  readonly onPath: (repo: Repo) => void;
  readonly onChoosePath: (repo: Repo) => void;
  readonly onRemove: (repo: Repo) => Promise<void>;
  readonly onArchive: (repo: Repo) => void;
  readonly onRefreshRepo: (repo: Repo) => void;
}): React.JSX.Element {
  const [removalTarget, setRemovalTarget] = useState<Repo>();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const [githubAccess, setGithubAccess] = useState<string>();
  const [environment, setEnvironment] = useState<Record<string, string>>();
  const loadEnvironment = async (): Promise<void> => {
    const value = await requestJson("/v1/environment");
    if (!record(value)) return;
    setEnvironment(
      Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    );
  };
  useEffect(() => {
    void loadEnvironment();
  }, []);
  const testGitHubAccess = async (): Promise<void> => {
    const value = await requestJson("/v1/github/access", { method: "POST" });
    if (record(value) && typeof value.state === "string")
      setGithubAccess(value.state);
  };
  const setupSteps =
    environment === undefined ? [] : environmentSetupSteps(environment);

  const confirmRemoval = async (): Promise<void> => {
    if (removalTarget === undefined || removing) return;
    setRemoving(true);
    setRemoveError(undefined);
    try {
      await onRemove(removalTarget);
      setRemovalTarget(undefined);
    } catch (cause: unknown) {
      setRemoveError(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not remove this repository.",
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace profiles, repository paths, and safe environment
          diagnostics.
        </p>
      </header>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>
              Follow the system setting, or keep Patchdesk in light or dark
              mode.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select
              value={appearance}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark")
                  onAppearanceChange(value);
              }}
            >
              <SelectTrigger aria-label="Appearance">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Diff theme</CardTitle>
            <CardDescription>
              Choose one of every Pierre-supported light and dark theme. The
              matching choice is used when the app appearance changes.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="diff-theme-light">Light appearance</Label>
              <Select
                value={diffThemePreferences.light}
                onValueChange={(value) => {
                  if (
                    value !== null &&
                    DIFF_LIGHT_THEMES.some((theme) => theme.id === value)
                  ) {
                    onDiffThemeChange({
                      ...diffThemePreferences,
                      light: value,
                    });
                  }
                }}
              >
                <SelectTrigger
                  id="diff-theme-light"
                  aria-label="Light diff theme"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIFF_LIGHT_THEMES.map((theme) => (
                    <SelectItem key={theme.id} value={theme.id}>
                      {theme.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="diff-theme-dark">Dark appearance</Label>
              <Select
                value={diffThemePreferences.dark}
                onValueChange={(value) => {
                  if (
                    value !== null &&
                    DIFF_DARK_THEMES.some((theme) => theme.id === value)
                  ) {
                    onDiffThemeChange({ ...diffThemePreferences, dark: value });
                  }
                }}
              >
                <SelectTrigger
                  id="diff-theme-dark"
                  aria-label="Dark diff theme"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIFF_DARK_THEMES.map((theme) => (
                    <SelectItem key={theme.id} value={theme.id}>
                      {theme.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Workspace profile</CardTitle>
            <CardDescription>
              GitHub reads and local paths are scoped to the selected profile.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="active-profile">Active profile</Label>
              <Select
                value={dashboard?.profile.id ?? profileDraft.id}
                items={profiles.map((profile) => ({
                  label: profile.label,
                  value: profile.id,
                }))}
                onValueChange={(value) => {
                  if (value !== null) onSelectProfile(value);
                }}
              >
                <SelectTrigger id="active-profile" className="mt-1.5">
                  <SelectValue placeholder="Select a profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(
              [
                ["Profile ID", "id"],
                ["Label", "label"],
                ["GitHub host", "githubHost"],
                ["GitHub account", "ghAccount"],
                ["Workspace root", "workspaceRoot"],
              ] as const
            ).map(([label, field]) => (
              <div key={field}>
                <Label htmlFor={`profile-${field}`}>{label}</Label>
                <Input
                  id={`profile-${field}`}
                  className="mt-1.5"
                  value={profileDraft[field]}
                  placeholder={
                    field === "workspaceRoot"
                      ? "/absolute/workspace/path"
                      : undefined
                  }
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      [field]: event.target.value,
                    }))
                  }
                />
              </div>
            ))}
            <Button onClick={onSaveProfile}>Save profile</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Environment diagnostics</CardTitle>
            <CardDescription>
              Readiness only; Patchdesk never displays token values or command
              output.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void loadEnvironment()}>
                {setupSteps.length === 0
                  ? "Check environment"
                  : "Recheck environment"}
              </Button>
              <Button variant="outline" onClick={() => void testGitHubAccess()}>
                Test GitHub access
              </Button>
            </div>
            {githubAccess === undefined ? null : (
              <p className="mt-4 text-sm">
                GitHub access: <Badge variant="outline">{githubAccess}</Badge>
              </p>
            )}
            {environment === undefined ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Loading safe environment diagnostics.
              </p>
            ) : (
              <>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  {Object.entries(environment)
                    .filter(
                      ([name]) =>
                        ![
                          "productName",
                          "version",
                          "architecture",
                          "distribution",
                        ].includes(name),
                    )
                    .map(([name, value]) => (
                      <div key={name} className="rounded-md border p-2">
                        <dt className="text-muted-foreground">{name}</dt>
                        <dd className="mt-1 font-medium">
                          {value.replaceAll("_", " ")}
                        </dd>
                      </div>
                    ))}
                </dl>
                {setupSteps.length === 0 ? null : (
                  <Alert variant="destructive" className="mt-4">
                    <AlertTitle>Setup action required</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc space-y-1 pl-5">
                        {setupSteps.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>About Patchdesk</h2>
            </CardTitle>
            <CardDescription>
              Build identity for diagnostics and internal distribution.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {environment === undefined ? (
              <p className="text-muted-foreground">
                Loading build information.
              </p>
            ) : (
              <>
                <p className="font-medium">
                  Version {environment.version ?? "unknown"}
                </p>
                <p>
                  <span className="text-muted-foreground">Architecture </span>
                  {environment.architecture ?? "unknown"}
                </p>
                <Badge variant="outline">
                  {environment.distribution === "unsigned_internal"
                    ? "Unsigned internal build"
                    : "Development build"}
                </Badge>
                <p className="text-muted-foreground">
                  Signing, notarization, and external distribution are outside
                  this internal build.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Watchlist</CardTitle>
          <CardDescription>
            Archive hides a repository from the active queue and is reversible.
            Remove deletes only the watchlist entry; saved review history and
            drafts remain local.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-60 flex-1">
              <Label htmlFor="repo-add">Repository</Label>
              <Input
                id="repo-add"
                className="mt-1.5"
                value={newRepo}
                onChange={(event) => setNewRepo(event.target.value)}
                placeholder="owner/repo"
              />
            </div>
            <Button onClick={onAdd}>Add repository</Button>
            <Button variant="outline" onClick={onDiscover}>
              Discover
            </Button>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Discovery searches only your configured workspace roots, up to four
            directory levels, with five-second local command limits. It runs in
            Patchdesk’s main process and offers local paths only in this
            Settings suggestion list; it never sends them to GitHub.
          </p>
          {discoveryFeedback === undefined ? null : (
            <p
              role="status"
              aria-live="polite"
              className="mt-3 text-sm text-muted-foreground"
            >
              {discoveryFeedback}
            </p>
          )}
          {suggestions.length === 0 ? null : (
            <div className="mt-4 space-y-2">
              {suggestions.map((repo) => (
                <div
                  key={key(repo)}
                  className="flex items-center justify-between rounded-md border p-3 text-sm"
                >
                  <span>
                    {repo.owner}/{repo.repo}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAddSuggestion(repo)}
                  >
                    Add suggestion
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {pathFeedback === undefined ? null : (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          {pathFeedback}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {dashboard?.dashboard.repos.map(({ repo }) => (
          <Card key={key(repo)}>
            <CardHeader>
              <CardTitle>
                {repo.owner}/{repo.repo}
              </CardTitle>
              <CardDescription>
                {repo.archived ? "Archived repository" : "Active repository"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Label htmlFor={`path-${key(repo)}`}>
                Local path for {repo.owner}/{repo.repo}
              </Label>
              <div className="mt-1.5 flex gap-2">
                <Input
                  id={`path-${key(repo)}`}
                  value={paths[key(repo)] ?? repo.localPath ?? ""}
                  onChange={(event) =>
                    setPaths((current) => ({
                      ...current,
                      [key(repo)]: event.target.value,
                    }))
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onChoosePath(repo)}
                  aria-label={`Choose folder for ${repo.owner}/${repo.repo}`}
                >
                  Choose folder
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => onPath(repo)}
                  aria-label={`Save path for ${repo.owner}/${repo.repo}`}
                >
                  Save path
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRefreshRepo(repo)}
                  aria-label={`Refresh ${repo.owner}/${repo.repo}`}
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onArchive(repo)}
                  aria-label={`${repo.archived ? "Restore" : "Archive"} ${repo.owner}/${repo.repo}`}
                >
                  {repo.archived ? "Restore" : "Archive"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  aria-label={`Remove ${repo.owner}/${repo.repo}`}
                  onClick={() => {
                    setRemoveError(undefined);
                    setRemovalTarget(repo);
                  }}
                >
                  Remove
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <AlertDialog
        open={removalTarget !== undefined}
        onOpenChange={(open) => {
          if (!open && !removing) {
            setRemovalTarget(undefined);
            setRemoveError(undefined);
          }
        }}
      >
        <AlertDialogContent aria-busy={removing}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removalTarget?.owner}/{removalTarget?.repo} from the
              watchlist?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Saved review history and drafts remain on this Mac.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm text-muted-foreground">
            Remove deletes the watchlist entry. Choose Archive instead when you
            only want to hide this repository from the active queue.
          </p>
          {removeError === undefined ? null : (
            <Alert variant="destructive">
              <AlertTitle>Repository was not removed</AlertTitle>
              <AlertDescription>{removeError}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removing}
              onClick={() => {
                void confirmRemoval();
              }}
            >
              {removing ? "Removing…" : "Confirm removal"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
function environmentSetupSteps(
  environment: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  const steps: Array<string> = [];
  if (environment.git !== "ready" || environment.gh !== "ready")
    steps.push(
      "Git and GitHub CLI must be available to Patchdesk from a Dock-launched environment.",
    );
  if (environment.githubAuth !== "ready")
    steps.push(
      "Authenticate the configured GitHub CLI account, then test GitHub access again.",
    );
  if (environment.runtime !== "ready" && environment.runtime !== "bundled")
    steps.push(
      "Install or repair the bundled review runtime before starting a review.",
    );
  if (
    environment.modelConfiguration !== "ready" &&
    environment.modelConfiguration !== "configured"
  )
    steps.push(
      "Configure a model provider before running a review; local history remains readable without it.",
    );
  return steps;
}

function key(repo: Repo): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
