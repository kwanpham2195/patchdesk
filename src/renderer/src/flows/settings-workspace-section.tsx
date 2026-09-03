import { Plus, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../components/ui/field";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import type {
  ProfileSwitchResult,
  ProfileSwitchState,
} from "../hooks/use-profile-switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import type { Dashboard, Profile } from "../renderer-models";
import {
  useWorkspaceProfileEditor,
  type FieldStatus,
} from "./settings-workspace-profile-editor";
import { FieldSaveStatus } from "./settings-workspace-field-status";
import { useReviewingAsProbe } from "./settings-workspace-reviewing-as";
import { ReviewingAsCard, RepositoriesCard } from "./settings-workspace-cards";
import { ProfileListEditor } from "./settings-workspace-list-editor";
import { CreateWorkspaceDialog } from "./settings-workspace-create-dialog";

type WorkspaceProfileSectionProps = {
  readonly dashboard: Dashboard | undefined;
  readonly profiles: ReadonlyArray<Profile>;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly profileSwitchState: ProfileSwitchState | undefined;
  readonly onProfileSwitch:
    | ((profileId: string) => Promise<ProfileSwitchResult>)
    | undefined;
};

/**
 * The Workspace settings section, ordered by what setup needs first:
 * Reviewing as, Repositories, then the Advanced and Workspace disclosures
 * that hold optional configuration and bookkeeping. Mounted only while the
 * Workspace tab is showing: every control here commits on its own — on blur,
 * on Enter, or on pick — so there is no draft left for an unmounted section
 * to carry.
 */
export function WorkspaceProfileSection({
  dashboard,
  profiles,
  onWorkspaceReload,
  profileSwitchState,
  onProfileSwitch,
}: WorkspaceProfileSectionProps): React.JSX.Element {
  const editor = useWorkspaceProfileEditor({
    dashboard,
    profiles,
    onWorkspaceReload,
    onProfileSwitch,
  });

  // The dialog is mounted only while open: that discards a cancelled draft,
  // and keeps its `GET /v1/environment` probe off until the user asks for it.
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const probe = useReviewingAsProbe(
    editor.scalars.ghAccount,
    editor.selectAccount,
  );

  // A switch the user is waiting on, or one that failed, reports itself
  // inside the Workspace card — which must therefore be open to be read.
  const workspaceSwitchVisible =
    profileSwitchState?.pendingOwner === "settings" ||
    profileSwitchState?.error?.owner === "settings";

  return (
    <div className="flex flex-col gap-6">
      <ReviewingAsCard editor={editor} probe={probe} />
      <RepositoriesCard
        editor={editor}
        dashboard={dashboard}
        onWorkspaceReload={onWorkspaceReload}
      />
      <DisclosureCard
        title="Advanced"
        openWhen={editor.persisted.rulePaths.length > 0}
      >
        <ProfileListEditor
          label="Rule paths"
          itemLabel="Rule path"
          field="rulePaths"
          description="Files given to every review as repository rules, for example an AGENTS.md or CONTRIBUTING.md. Absolute paths."
          entries={editor.rows.rulePaths}
          placeholder="/absolute/path/to/AGENTS.md"
          status={editor.status.rulePaths}
          onChange={editor.editListEntry}
          onCommit={editor.commitList}
          onAdd={editor.addListEntry}
          onRemove={editor.removeListEntry}
        />
      </DisclosureCard>
      <DisclosureCard
        title="Workspace"
        description="This workspace's name, and switching between workspaces."
        openWhen={workspaceSwitchVisible}
      >
        <FieldGroup className="gap-4">
          <WorkspaceNameField
            value={editor.scalars.label}
            status={editor.status.label}
            onEdit={(value) => editor.editScalar("label", value)}
            onCommit={() => editor.commitScalar("label")}
          />
          <Field>
            <FieldLabel htmlFor="active-profile">Active workspace</FieldLabel>
            <Select
              value={dashboard?.profile.id ?? editor.persisted.id}
              items={profiles.map((profile) => ({
                label: profile.label,
                value: profile.id,
              }))}
              onValueChange={(value) => {
                if (value !== null) editor.selectProfile(value);
              }}
            >
              <SelectTrigger id="active-profile" aria-label="Active workspace">
                <SelectValue placeholder="Select a workspace">
                  {editor.persisted.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {profileSwitchState?.pendingOwner === "settings" ? (
              <p
                className="flex items-center gap-1.5 text-sm text-muted-foreground"
                role="status"
              >
                <Spinner aria-hidden="true" />
                Switching to{" "}
                {profiles.find(
                  (profile) => profile.id === profileSwitchState.pendingTarget,
                )?.label ?? "workspace"}
                …
              </p>
            ) : null}
            {profileSwitchState?.error?.owner === "settings" ? (
              <FieldError>{profileSwitchState.error.message}</FieldError>
            ) : null}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateDialogOpen(true)}
            >
              <Plus data-icon="inline-start" />
              New workspace
            </Button>
          </div>
        </FieldGroup>
      </DisclosureCard>
      {createDialogOpen ? (
        <CreateWorkspaceDialog
          onOpenChange={setCreateDialogOpen}
          onCreated={onWorkspaceReload}
        />
      ) : null}
    </div>
  );
}

/**
 * A card whose header is its own disclosure trigger: collapsed by default, so
 * the tab opens on the setup that is required rather than on everything at
 * once. `openWhen` opens it the moment the card gains something the user must
 * see — configuration that already exists, or a status only it renders — and
 * leaves it closable again afterwards.
 */
function DisclosureCard({
  title,
  description,
  openWhen = false,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly openWhen?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(openWhen);
  const previousOpenWhen = useRef(openWhen);

  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- opening on the rising edge only: the card must reveal what it now holds, and stay closable once the user has seen it.
    if (openWhen && !previousOpenWhen.current) setOpen(true);
    previousOpenWhen.current = openWhen;
  }, [openWhen]);

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          aria-label={title}
          className="flex w-full items-start justify-between gap-2 px-(--card-spacing) text-left"
          render={<button type="button" />}
        >
          <span className="flex flex-col gap-1">
            <span className="text-base leading-snug font-medium">{title}</span>
            {description === undefined ? null : (
              <span className="text-sm text-muted-foreground">
                {description}
              </span>
            )}
          </span>
          <ChevronDown
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent motion="disclosure">
          <CardContent className="flex flex-col gap-5 pt-(--card-spacing)">
            {children}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/** The workspace's own name. The stored profile id is derived on creation and never shown. */
function WorkspaceNameField({
  value,
  status,
  onEdit,
  onCommit,
}: {
  readonly value: string;
  readonly status: FieldStatus;
  readonly onEdit: (value: string) => void;
  readonly onCommit: () => void;
}): React.JSX.Element {
  const failed = status.state === "failed";
  return (
    <Field data-invalid={failed ? true : undefined}>
      <FieldLabel htmlFor="profile-label">Name</FieldLabel>
      <Input
        id="profile-label"
        aria-label="Name"
        value={value}
        aria-invalid={failed ? true : undefined}
        aria-describedby={failed ? "profile-label-status" : undefined}
        onChange={(event) => onEdit(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCommit();
        }}
      />
      <div id="profile-label-status">
        <FieldSaveStatus status={status} />
      </div>
    </Field>
  );
}
