import { useEffect, useState } from "react";
import {
  AlertTriangle,
  FolderOpen,
  Inbox,
  MoreHorizontal,
  Search,
  Settings as SettingsIcon,
  X,
} from "lucide-react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../renderer/src/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../renderer/src/components/ui/alert-dialog";
import { Button } from "../renderer/src/components/ui/button";
import { Badge } from "../renderer/src/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../renderer/src/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../renderer/src/components/ui/dialog";
import { Label } from "../renderer/src/components/ui/label";
import { Input } from "../renderer/src/components/ui/input";
import { ScrollArea } from "../renderer/src/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../renderer/src/components/ui/select";
import { Separator } from "../renderer/src/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../renderer/src/components/ui/tabs";
import {
  cleanupCopy,
  type CleanupActionKey,
} from "../renderer/src/review-copy";

type SettingsSection = "general" | "workspace" | "review" | "data";

/**
 * Browser-only Settings overlay. The Design app opens it as a centered modal
 * over the current scenario route, so it is not a destination in the renderer
 * shell. It always starts on General and uses only the local copy map. The
 * optional `autoOpenCleanup` and `onCleanupDialogChange` props let the
 * `dialog-clear-local-data` scenario open a confirmation over a General-first
 * Settings surface without making Data & recovery the first visible section.
 */
export function DesignSettingsOverlay({
  onClose,
  initialSection = "general",
  autoOpenCleanup,
  onCleanupDialogChange,
}: {
  readonly onClose: () => void;
  readonly initialSection?: SettingsSection;
  readonly autoOpenCleanup?: CleanupActionKey | undefined;
  readonly onCleanupDialogChange?: (next: CleanupActionKey | undefined) => void;
}): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [pendingCleanup, setPendingCleanup] = useState<
    CleanupActionKey | undefined
  >(autoOpenCleanup);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [openWatchlistActions, setOpenWatchlistActions] = useState<
    "api" | "customer" | undefined
  >();
  const [editingWatchlistRepo, setEditingWatchlistRepo] = useState<string>();

  useEffect(() => {
    if (autoOpenCleanup !== undefined) setPendingCleanup(autoOpenCleanup);
  }, [autoOpenCleanup]);

  const updatePending = (next: CleanupActionKey | undefined): void => {
    setPendingCleanup(next);
    onCleanupDialogChange?.(next);
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(90vh,960px)] max-h-[90vh] w-[min(96vw,1200px)] max-w-[min(96vw,1200px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1200px)]"
          aria-describedby="patchdesk-settings-description"
        >
          <div className="border-b px-10 py-8">
            <DialogTitle className="flex items-center gap-2">
              <SettingsIcon className="size-4" /> Settings
            </DialogTitle>
            <DialogDescription id="patchdesk-settings-description">
              Set Patchdesk appearance and diff themes.
            </DialogDescription>
          </div>
          <Tabs
            value={section}
            onValueChange={(value) => {
              if (
                value === "general" ||
                value === "workspace" ||
                value === "review" ||
                value === "data"
              )
                setSection(value);
            }}
            orientation="horizontal"
            className="min-h-0 flex-1 gap-0"
          >
            <TabsList className="mx-10 mt-8">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="workspace">Workspace</TabsTrigger>
              <TabsTrigger value="review">Review</TabsTrigger>
              <TabsTrigger value="data">Data &amp; recovery</TabsTrigger>
            </TabsList>
            <ScrollArea className="min-h-0 flex-1 px-10 py-8">
              <TabsContent
                value="general"
                data-testid="settings-section-general"
                className="mt-0 grid gap-6 lg:grid-cols-2"
              >
                <Card>
                  <CardHeader>
                    <CardTitle>Appearance</CardTitle>
                    <CardDescription>
                      Follow the system setting, or keep Patchdesk in light or
                      dark mode.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Label className="grid gap-1.5">
                      Theme
                      <Select defaultValue="dark">
                        <SelectTrigger className="h-12">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="system">System</SelectItem>
                          <SelectItem value="light">Light</SelectItem>
                          <SelectItem value="dark">Dark</SelectItem>
                        </SelectContent>
                      </Select>
                    </Label>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Diff theme</CardTitle>
                    <CardDescription>
                      Choose the Pierre theme used for light and dark
                      appearance.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4 sm:grid-cols-2">
                    <Label className="grid gap-1.5">
                      Light appearance
                      <Select defaultValue="light-plus">
                        <SelectTrigger className="h-12">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="light-plus">Light Plus</SelectItem>
                        </SelectContent>
                      </Select>
                    </Label>
                    <Label className="grid gap-1.5">
                      Dark appearance
                      <Select defaultValue="dark-plus">
                        <SelectTrigger className="h-12">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="dark-plus">Dark Plus</SelectItem>
                        </SelectContent>
                      </Select>
                    </Label>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent
                value="review"
                data-testid="settings-section-review"
                className="flex flex-col gap-4 p-2"
              >
                <Card>
                  <CardHeader>
                    <CardTitle>Review preferences</CardTitle>
                    <CardDescription>
                      Profile-scoped defaults for the next review run. They
                      never start work.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <Label className="grid gap-1.5">
                      Default model
                      <Select defaultValue="pi-design">
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pi-design">
                            Design review model
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Label>
                    <Label className="grid gap-1.5">
                      Default reasoning
                      <Select defaultValue="medium">
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                        </SelectContent>
                      </Select>
                    </Label>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent
                value="workspace"
                data-testid="settings-section-workspace"
                className="mt-0 grid items-start gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"
              >
                <div className="flex flex-col gap-6">
                  <Card>
                    <CardHeader>
                      <CardTitle>Profile</CardTitle>
                      <CardDescription>
                        The active GitHub account and profile details for this workspace.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <Label className="grid gap-1.5">
                        Active profile
                        <Select defaultValue="cfw">
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="cfw">CFW</SelectItem>
                          </SelectContent>
                        </Select>
                      </Label>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Label className="grid gap-1.5 sm:col-span-2">
                          Profile ID
                          <Input defaultValue="cfw" disabled />
                        </Label>
                        <Label className="grid gap-1.5">
                          Label
                          <Input defaultValue="CFW QA" />
                        </Label>
                        <Label className="grid gap-1.5">
                          GitHub account
                          <Input defaultValue="pmquan2cfw" />
                        </Label>
                        <Label className="grid gap-1.5 sm:col-span-2">
                          GitHub host
                          <Input defaultValue="github.com" />
                        </Label>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Workspace scope</CardTitle>
                      <CardDescription>
                        Where Patchdesk looks for repositories and the rules that apply.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5">
                      <ScopePreview
                        label="Workspace roots"
                        value="/Users/pmquan2cfw/Documents/workspaces/cfw"
                        choose
                        addLabel="Add workspace root"
                      />
                      <ScopePreview
                        label="Owner filters"
                        value="centraldigital"
                        addLabel="Add owner filter"
                      />
                      <ScopePreview
                        label="Rule paths"
                        value="/Users/pmquan2cfw/patchdesk/AGENTS.md"
                        addLabel="Add rule path"
                      />
                    </CardContent>
                  </Card>
                </div>
                <DesignWatchlist
                  openActions={openWatchlistActions}
                  editingRepo={editingWatchlistRepo}
                  onActionsChange={setOpenWatchlistActions}
                  onEditingChange={setEditingWatchlistRepo}
                />
              </TabsContent>
              <TabsContent
                value="data"
                data-testid="settings-section-data"
                className="mt-0 flex flex-col gap-6"
              >
                <Card data-testid="local-review-data-card">
                  <CardHeader>
                    <CardTitle>Local review data</CardTitle>
                    <CardDescription>
                      Two global actions, ordered by severity. Confirmations
                      state what stays and what goes.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Alert className="border-info/30 bg-info/5">
                      <Inbox />
                      <AlertTitle>Stored reviews stay readable</AlertTitle>
                      <AlertDescription>
                        Clear cache keeps review history. Clear local review
                        data removes completed and failed local reviews; an
                        active review and diagnostic reports stay.
                      </AlertDescription>
                    </Alert>
                    <div className="flex flex-col gap-2">
                      <Button
                        variant="outline"
                        onClick={() => updatePending("clear_cache")}
                      >
                        Clear cache
                      </Button>
                      <Button
                        variant="outline"
                        data-testid="clear-local-data-button"
                        onClick={() => updatePending("clear_local_review_data")}
                      >
                        Clear local review data
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Both confirmations disable their controls while pending
                      and retry the same classification on failure.
                    </p>
                  </CardContent>
                </Card>
                <Card data-testid="review-activity-card">
                  <CardHeader>
                    <CardTitle>Review activity</CardTitle>
                    <CardDescription>
                      Redacted local milestones for review and walkthrough runs.
                      Prompts, tokens, paths, and provider output are never
                      shown.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Button
                      variant="outline"
                      onClick={() => setActivityLoaded(true)}
                    >
                      Load activity
                    </Button>
                    {activityLoaded ? (
                      <ol
                        aria-label="Review activity log"
                        className="space-y-2 text-sm"
                      >
                        <li className="rounded-md border p-3">
                          <p className="font-medium">Workflow Failed</p>
                          <p className="text-muted-foreground">
                            run · can retry · 17s
                          </p>
                          <p className="mt-1 text-muted-foreground">
                            review_execution_failed
                          </p>
                        </li>
                      </ol>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Load activity to inspect the redacted local run trail.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </ScrollArea>
          </Tabs>
          <Separator />
          <div className="flex justify-end px-10 py-6">
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>
      <CleanupDialog
        pending={pendingCleanup}
        onCancel={() => updatePending(undefined)}
        onConfirm={() => updatePending(undefined)}
      />
    </>
  );
}

function ScopePreview({
  label,
  value,
  addLabel,
  choose = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly addLabel: string;
  readonly choose?: boolean;
}): React.JSX.Element {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border p-2">
        <Input defaultValue={value} />
        {choose ? (
          <Button size="sm" variant="outline">
            <FolderOpen data-icon="inline-start" />
            Choose folder
          </Button>
        ) : null}
        <Button size="icon-sm" variant="outline" aria-label={`Remove ${label}`}>
          <X />
        </Button>
      </div>
      <Button size="sm" variant="outline" className="w-fit">{addLabel}</Button>
    </fieldset>
  );
}

function DesignWatchlist({
  openActions,
  editingRepo,
  onActionsChange,
  onEditingChange,
}: {
  readonly openActions: "api" | "customer" | undefined;
  readonly editingRepo: string | undefined;
  readonly onActionsChange: (value: "api" | "customer" | undefined) => void;
  readonly onEditingChange: (value: string | undefined) => void;
}): React.JSX.Element {
  return (
    <section role="region" aria-label="Watchlist">
      <Card className="h-full">
        <CardHeader className="gap-2 pb-4">
          <CardTitle>Watchlist</CardTitle>
          <CardDescription>
            Repositories in the active queue. Saved review history remains local.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Repository</Label>
            <Input placeholder="owner/repository" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm">Add repository</Button>
              <Button size="sm" variant="outline">
                <Search data-icon="inline-start" />
                Discover
              </Button>
            </div>
          </div>
          <WatchlistPreviewRow
            repoKey="api"
            label="centraldigital/cfw-sales-crm-api"
            path="/absolute/repository/path"
            openActions={openActions === "api"}
            editing={editingRepo === "api"}
            onToggleActions={() =>
              onActionsChange(openActions === "api" ? undefined : "api")
            }
            onEdit={() => {
              onEditingChange("api");
              onActionsChange(undefined);
            }}
            onCancel={() => onEditingChange(undefined)}
          />
          <WatchlistPreviewRow
            repoKey="customer"
            label="centraldigital/cfw-bo-customer-management-service"
            path="/absolute/repository/path"
            openActions={openActions === "customer"}
            editing={editingRepo === "customer"}
            onToggleActions={() =>
              onActionsChange(openActions === "customer" ? undefined : "customer")
            }
            onEdit={() => {
              onEditingChange("customer");
              onActionsChange(undefined);
            }}
            onCancel={() => onEditingChange(undefined)}
          />
          <WatchlistPreviewRow
            repoKey="workflow"
            label="centraldigital/cfw-workflow-service"
            path="No local path selected"
            openActions={false}
            editing={false}
            onToggleActions={() => undefined}
            onEdit={() => undefined}
            onCancel={() => undefined}
          />
        </CardContent>
      </Card>
    </section>
  );
}

function WatchlistPreviewRow({
  repoKey,
  label,
  path,
  openActions,
  editing,
  onToggleActions,
  onEdit,
  onCancel,
}: {
  readonly repoKey: string;
  readonly label: string;
  readonly path: string;
  readonly openActions: boolean;
  readonly editing: boolean;
  readonly onToggleActions: () => void;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="relative border-b py-3 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{label}</p>
          {editing ? null : (
            <p className="truncate text-xs text-muted-foreground">{path}</p>
          )}
        </div>
        <Badge variant="secondary">Active</Badge>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={`More actions for ${label}`}
          aria-expanded={openActions}
          onClick={onToggleActions}
        >
          <MoreHorizontal />
        </Button>
      </div>
      {openActions ? (
        <div
          role="menu"
          aria-label={`Actions for ${label}`}
          className="absolute top-10 right-0 z-10 flex w-44 flex-col gap-1 rounded-lg border bg-popover p-1 shadow-md"
        >
          <Button size="sm" variant="ghost" className="justify-start">Refresh</Button>
          <Button size="sm" variant="ghost" className="justify-start" onClick={onEdit}>
            Edit local path
          </Button>
          <Button size="sm" variant="ghost" className="justify-start">Archive</Button>
          <Button size="sm" variant="ghost" className="justify-start text-destructive">Remove</Button>
        </div>
      ) : null}
      {editing ? (
        <div className="mt-3 flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
          <Label htmlFor={`watchlist-preview-path-${repoKey}`}>Local path</Label>
          <Input
            id={`watchlist-preview-path-${repoKey}`}
            defaultValue="/absolute/repository/path"
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm">
              <FolderOpen data-icon="inline-start" />
              Choose folder
            </Button>
            <Button size="sm">Save path</Button>
            <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CleanupDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  readonly pending: CleanupActionKey | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  if (pending === undefined) return <></>;
  const copy = cleanupCopy(pending);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent data-testid={`cleanup-dialog-${pending}`}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4" /> {copy.title}
            </span>
          </AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {copy.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
