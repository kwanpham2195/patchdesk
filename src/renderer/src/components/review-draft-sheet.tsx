import { useEffect, useMemo, useState } from "react";
import { FilePenLine, Save } from "lucide-react";

import type { ReviewDraft } from "../../../domain/review-draft";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";

type EditableDraft = {
  readonly summaryBody: string;
  readonly comments: ReadonlyArray<{
    readonly findingId: string;
    readonly include: boolean;
    readonly body: string;
  }>;
};

export type DraftSaveState = "saved" | "unsaved" | "saving" | "save_failed";

export function ReviewDraftSheet({
  draft,
  onSave,
  onSaveState,
}: {
  readonly draft: ReviewDraft;
  readonly onSave: (
    input: EditableDraft & { readonly expectedRevision: string },
  ) => Promise<{ readonly draft: ReviewDraft; readonly revision: string }>;
  readonly onSaveState?: (state: DraftSaveState) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [editable, setEditable] = useState<EditableDraft>(() =>
    toEditable(draft),
  );
  const [revision, setRevision] = useState<string>(draft.updatedAt);
  const [state, setState] = useState<DraftSaveState>("saved");
  const [error, setError] = useState<string>();
  const previewed = useMemo(
    () =>
      editable.comments.filter(
        (comment) => comment.include && comment.body.trim().length > 0,
      ),
    [editable.comments],
  );

  useEffect(() => {
    onSaveState?.(state);
  }, [onSaveState, state]);
  useEffect(() => {
    if (state !== "unsaved") return;
    const timeout = setTimeout(() => {
      void save();
    }, 700);
    return () => clearTimeout(timeout);
  }, [editable, state]);

  const update = (next: EditableDraft): void => {
    setEditable(next);
    setState("unsaved");
    setError(undefined);
  };
  const save = async (): Promise<boolean> => {
    if (state === "saving") return false;
    setState("saving");
    try {
      const persisted = await onSave({
        ...editable,
        expectedRevision: revision,
      });
      setRevision(persisted.revision);
      setEditable(toEditable(persisted.draft));
      setState("saved");
      return true;
    } catch {
      setState("save_failed");
      setError(
        "Patchdesk could not save this revision. Your text remains in this sheet; resolve the conflict before any GitHub write.",
      );
      return false;
    }
  };
  const changeOpen = (next: boolean): void => {
    if (next) {
      setOpen(true);
      return;
    }
    if (state === "unsaved" || state === "save_failed") {
      void save().then((saved) => {
        if (saved) setOpen(false);
      });
      return;
    }
    if (state !== "saving") setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger asChild>
        <Button className="w-full">
          <FilePenLine />
          Edit review draft
        </Button>
      </SheetTrigger>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-xl"
        aria-busy={state === "saving"}
      >
        <SheetHeader>
          <SheetTitle>Review draft</SheetTitle>
          <SheetDescription>
            Edits save to the local review session. GitHub receives only the
            exact saved revision shown here.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4">
          <div className="flex items-center gap-2">
            <Badge
              variant={state === "save_failed" ? "destructive" : "secondary"}
            >
              {state.replaceAll("_", " ")}
            </Badge>
            <Badge variant="outline">Revision {revision}</Badge>
          </div>
          {error === undefined ? null : (
            <Alert variant="destructive">
              <AlertTitle>Draft not saved</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FieldGroup className="mt-5 gap-5">
          <Field>
            <FieldLabel htmlFor="draft-summary">Review summary</FieldLabel>
            <FieldDescription>
              This text becomes the saved review summary before any GitHub write.
            </FieldDescription>
            <Textarea
              id="draft-summary"
              className="mt-1.5 min-h-28"
              value={editable.summaryBody}
              onChange={(event) =>
                update({ ...editable, summaryBody: event.target.value })
              }
            />
          </Field>
          <FieldSet className="gap-3">
            <FieldLegend>Inline comments</FieldLegend>
            {editable.comments.map((comment) => (
              <Field key={comment.findingId} className="rounded-lg border p-3">
                <Field orientation="horizontal">
                  <Checkbox
                    id={`include-${comment.findingId}`}
                    checked={comment.include}
                    onCheckedChange={(checked) =>
                      update({
                        ...editable,
                        comments: editable.comments.map((candidate) =>
                          candidate.findingId === comment.findingId
                            ? { ...candidate, include: checked === true }
                            : candidate,
                        ),
                      })
                    }
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={`include-${comment.findingId}`}>
                      Include {comment.findingId}
                    </FieldLabel>
                  </FieldContent>
                </Field>
                <FieldLabel
                  className="sr-only"
                  htmlFor={`body-${comment.findingId}`}
                >
                  Draft for {comment.findingId}
                </FieldLabel>
                <Textarea
                  id={`body-${comment.findingId}`}
                  className="mt-2"
                  value={comment.body}
                  onChange={(event) =>
                    update({
                      ...editable,
                      comments: editable.comments.map((candidate) =>
                        candidate.findingId === comment.findingId
                          ? { ...candidate, body: event.target.value }
                          : candidate,
                      ),
                    })
                  }
                />
              </Field>
            ))}
          </FieldSet>
          <div className="rounded-lg border bg-muted p-4 text-sm">
            <p className="font-medium">Exact saved-payload preview</p>
            <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
              {editable.summaryBody}
            </p>
            <p className="mt-3">{previewed.length} included inline comments</p>
          </div>
          </FieldGroup>
        </div>
        <SheetFooter>
          <Button
            variant="outline"
            disabled={state === "saving"}
            onClick={() => changeOpen(false)}
          >
            Close
          </Button>
          <Button
            disabled={state === "saving" || state === "saved"}
            onClick={() => void save()}
          >
            <Save />
            {state === "saving" ? <Spinner /> : null}
            {state === "saving" ? "Saving…" : "Save draft"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function toEditable(draft: ReviewDraft): EditableDraft {
  return {
    summaryBody: draft.summaryBody,
    comments: draft.comments.map(({ findingId, include, body }) => ({
      findingId,
      include,
      body,
    })),
  };
}
