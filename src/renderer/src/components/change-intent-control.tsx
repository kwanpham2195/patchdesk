import { useState } from "react";
import { Target } from "lucide-react";

import { changeIntentSummary } from "../change-intent-copy";
import type {
  ChangeIntentControls,
  ChangeIntentInput,
} from "../flows/use-change-intent";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

/**
 * A local Review's Change intent in its header (#467): a one-line summary and
 * the control that opens the editor. Analysis checks the patch against it.
 */
export function ChangeIntentControl({
  controls,
  editable,
}: {
  readonly controls: ChangeIntentControls;
  /** False once the Review is merged or closed. */
  readonly editable: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const summary = changeIntentSummary(controls.current);
  const intent = controls.current?.intent;
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-xs"
      data-review-change-intent
    >
      {intent?.kind === "text" && intent.source === "agent" ? (
        <span className="shrink-0 font-medium">Intent from the agent</span>
      ) : null}
      <span className="min-w-0 truncate text-muted-foreground" title={summary}>
        {summary}
      </span>
      {editable ? (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => setOpen(true)}
        >
          <Target data-icon="inline-start" /> Change intent
        </Button>
      ) : null}
      {open ? (
        <ChangeIntentDialog controls={controls} onOpenChange={setOpen} />
      ) : null}
    </div>
  );
}

/** Mounted only while open, so cancelling drops the draft. */
function ChangeIntentDialog({
  controls,
  onOpenChange,
}: {
  readonly controls: ChangeIntentControls;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const current = controls.current?.intent;
  const [kind, setKind] = useState<ChangeIntentInput["kind"]>(
    current?.kind ?? "text",
  );
  const [markdown, setMarkdown] = useState(
    current?.kind === "text" ? current.markdown : "",
  );
  const [path, setPath] = useState(
    current?.kind === "file" ? current.path : "",
  );
  const [error, setError] = useState<string>();
  const input: ChangeIntentInput | undefined =
    kind === "text"
      ? markdown.trim() === ""
        ? undefined
        : { kind, markdown }
      : path.trim() === ""
        ? undefined
        : { kind, path: path.trim() };

  const submit = async (intent: ChangeIntentInput | null): Promise<void> => {
    setError(undefined);
    try {
      await controls.save(intent);
      onOpenChange(false);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The change intent was not saved.",
      );
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!controls.saving) onOpenChange(nextOpen);
      }}
    >
      <DialogContent showCloseButton={!controls.saving}>
        <DialogHeader>
          <DialogTitle>Change intent</DialogTitle>
          <DialogDescription>
            What the change is meant to do. Analysis reports a goal the patch
            misses, and a change the intent does not mention.
          </DialogDescription>
        </DialogHeader>
        {error === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Change intent not saved</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (input !== undefined) void submit(input);
          }}
        >
          <Tabs
            value={kind}
            onValueChange={(value) => {
              // SAFETY: every TabsTrigger below is keyed by a ChangeIntentInput kind literal.
              setKind(value as ChangeIntentInput["kind"]);
            }}
          >
            <TabsList aria-label="Change intent source">
              <TabsTrigger value="text">Text</TabsTrigger>
              <TabsTrigger value="file">Spec file</TabsTrigger>
            </TabsList>
          </Tabs>
          {kind === "text" ? (
            <Field>
              <FieldLabel htmlFor="change-intent-text">Intent</FieldLabel>
              <Textarea
                id="change-intent-text"
                rows={8}
                value={markdown}
                onChange={(event) => setMarkdown(event.target.value)}
              />
              <FieldDescription>Markdown, at most 64 KiB.</FieldDescription>
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="change-intent-path">Spec file</FieldLabel>
              <Input
                id="change-intent-path"
                placeholder="docs/spec.md"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              <FieldDescription>
                A path inside the repository, read at the reviewed revision when
                Analysis runs.
              </FieldDescription>
            </Field>
          )}
          <DialogFooter>
            {controls.current === null ? null : (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                disabled={controls.saving}
                onClick={() => void submit(null)}
              >
                Clear
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={controls.saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={controls.saving || input === undefined}
            >
              {controls.saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
