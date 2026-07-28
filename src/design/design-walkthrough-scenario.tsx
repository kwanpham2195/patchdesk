import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowLeft, BookOpen, CheckCircle2, CircleAlert, FileText, RefreshCw, ShieldAlert, Sparkles, Square, Star } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../renderer/src/components/ui/alert";
import { Badge } from "../renderer/src/components/ui/badge";
import { Button } from "../renderer/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../renderer/src/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../renderer/src/components/ui/dialog";
import { Label } from "../renderer/src/components/ui/label";
import { ScrollArea } from "../renderer/src/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../renderer/src/components/ui/select";
import { Separator } from "../renderer/src/components/ui/separator";
import { walkthroughCopy, type WalkthroughLifecycleKey } from "../renderer/src/review-copy";

type WalkthroughSectionFixture = {
  readonly id: string;
  readonly chapter: string;
  readonly title: string;
  readonly prose: string;
  readonly hunkIds: ReadonlyArray<string>;
  readonly highlight: string;
};

const WALKTHROUGH_SECTIONS: ReadonlyArray<WalkthroughSectionFixture> = [
  {
    id: "section-1",
    chapter: "Context",
    title: "Why this snapshot matters",
    prose:
      "The stored patch changes how the recovery path picks its single next action. This section explains what the user sees first.",
    hunkIds: ["h-1"],
    highlight: "src/recovery/projection.ts:42",
  },
  {
    id: "section-2",
    chapter: "Behavior",
    title: "How reads stay read-only",
    prose:
      "Patchdesk only reads from the local cached review patch. The walkthrough is a reading surface, not a starting point for a new run.",
    hunkIds: ["h-2"],
    highlight: "src/services/review-workbench-projection.ts:18",
  },
  {
    id: "section-3",
    chapter: "Consequences",
    title: "What changes for the maintainer",
    prose:
      "Marking a section reviewed and writing an inline comment use the same batch action as Files mode, so Back to files preserves the work.",
    hunkIds: ["h-3"],
    highlight: "src/renderer/src/flows/completed-review-flow.tsx:96",
  },
  {
    id: "section-4",
    chapter: "Validation",
    title: "How reviewers verify the change",
    prose:
      "Read the changed code path, confirm the recovery decision is bounded to a single action, and use the existing batch actions for inline comments.",
    hunkIds: ["h-4"],
    highlight: "tests/services/review-recovery-service.test.ts:54",
  },
];

const SUPPORT_HUNKS: ReadonlyArray<{ readonly id: string; readonly path: string; readonly summary: string }> = [
  { id: "support-1", path: "src/services/recovery/storage-management-service.ts", summary: "Cleanup handler for the local cache action." },
  { id: "support-2", path: "src/renderer/src/flows/inbox-flow.tsx", summary: "Renders the recovery chip from the projection." },
  { id: "support-3", path: "tests/browser/milestone-9.spec.ts", summary: "Browser proof for the recovery surface." },
];

type WalkthroughScenarioVariant =
  | "walkthrough-generate-dialog"
  | "walkthrough-generating"
  | "walkthrough-ready"
  | "walkthrough-failed"
  | "walkthrough-stale";

/**
 * Browser-only walkthrough scenario. Deterministic fixture; no bridge call,
 * filesystem access, GitHub, Electron, or model invocation. The permanent
 * scenarios use the chapter rail with continuous reading surface. The
 * temporary `walkthrough-ready-rail` and `walkthrough-ready-linear` comparison
 * scenarios were used to record the layout choice; only the rail is retained.
 */
export function DesignWalkthroughScenario({
  variant,
  layout,
  onBackToFiles,
}: {
  readonly variant: WalkthroughScenarioVariant;
  readonly layout: "rail" | "linear";
  readonly onBackToFiles?: () => void;
}): React.JSX.Element {
  const [lifecycle, setLifecycle] = useState<WalkthroughLifecycleKey>(initialLifecycle(variant));
  const [dialogOpen, setDialogOpen] = useState(variant === "walkthrough-generate-dialog");
  const [reasoning, setReasoning] = useState<"low" | "medium" | "high">("medium");
  const [model, setModel] = useState("pi-design");
  const [reviewed, setReviewed] = useState<ReadonlyArray<string>>([]);
  const [current, setCurrent] = useState(WALKTHROUGH_SECTIONS[0]?.id ?? "");
  const [supportReviewed, setSupportReviewed] = useState(false);
  const [generationSteps, setGenerationSteps] = useState<ReadonlyArray<string>>([]);
  const [filesView, setFilesView] = useState<"patchdesk" | "storybook">("patchdesk");

  useEffect(() => {
    setLifecycle(initialLifecycle(variant));
    setDialogOpen(variant === "walkthrough-generate-dialog");
    setReviewed([]);
    setCurrent(WALKTHROUGH_SECTIONS[0]?.id ?? "");
    setSupportReviewed(false);
    setGenerationSteps([]);
  }, [variant]);

  // Deterministic, browser-safe generating → ready completion. The setTimeout
  // runs in the renderer; the test harness advances time by interacting with
  // visible controls (clicking Generate) and the scenario never performs any
  // out-of-band I/O.
  useEffect(() => {
    if (lifecycle !== "generating") return;
    const steps = [
      "Reading the stored patch",
      "Grouping stored hunks by file",
      "Mapping sections to hunks",
      "Verifying every hunk is covered",
    ];
    setGenerationSteps([steps[0] ?? ""]);
    const timeouts: Array<ReturnType<typeof setTimeout>> = [];
    steps.forEach((step, index) => {
      if (index === 0) return;
      timeouts.push(setTimeout(() => setGenerationSteps((current) => [...current, step]), 80 * index));
    });
    timeouts.push(setTimeout(() => {
      setLifecycle("ready");
      setGenerationSteps([]);
    }, 80 * (steps.length + 1)));
    return () => {
      for (const id of timeouts) clearTimeout(id);
    };
  }, [lifecycle]);

  const sections = WALKTHROUGH_SECTIONS;
  const currentIndex = useMemo(
    () => Math.max(0, sections.findIndex((section) => section.id === current)),
    [current, sections],
  );
  const fallbackSection = sections[0] as WalkthroughSectionFixture;
  const currentSection: WalkthroughSectionFixture = sections[currentIndex] ?? fallbackSection;
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < sections.length - 1;

  const headline = walkthroughCopy(lifecycle).headline;
  const reassurance = walkthroughCopy(lifecycle).reassurance;

  const startGeneration = (): void => {
    setDialogOpen(false);
    setLifecycle("generating");
  };

  const retryGeneration = (): void => {
    setLifecycle("generating");
  };

  const handleBackToFiles = (): void => {
    setFilesView("storybook");
    onBackToFiles?.();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLElement && /^(input|textarea|select)$/i.test(event.target.tagName)) return;
    if (lifecycle !== "ready") return;
    if (event.key === "ArrowLeft" || event.key === "j") {
      event.preventDefault();
      if (canGoPrev) setCurrent(sections[currentIndex - 1]?.id ?? current);
    }
    if (event.key === "ArrowRight" || event.key === "k") {
      event.preventDefault();
      if (canGoNext) setCurrent(sections[currentIndex + 1]?.id ?? current);
    }
  };

  const isFailed = lifecycle === "failed";
  const isStale = lifecycle === "stale";
  const isGenerating = lifecycle === "generating";

  if (filesView === "storybook") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6" data-testid="files-mode-stage">
        <FileText className="size-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Files mode (fixture)</h1>
        <p className="max-w-xl text-center text-sm text-muted-foreground">
          Back to files restored the file selection, inspector, and diff controls. The walkthrough takeover is closed.
        </p>
        <Button onClick={() => setFilesView("patchdesk")} variant="outline">Reopen walkthrough</Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background" onKeyDown={handleKeyDown} tabIndex={-1}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" data-testid="back-to-files" aria-label="Back to files" onClick={handleBackToFiles}>
            <ArrowLeft /> Back to files
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Protect review writes · read-only walkthrough</p>
            <h1 className="truncate text-base font-semibold">{headline}</h1>
            <p className="text-xs text-muted-foreground">{reassurance}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={isFailed || isStale ? "destructive" : "secondary"}>
            {lifecycle === "ready" ? <BookOpen /> : isFailed || isStale ? <CircleAlert /> : <Sparkles />}
            {lifecycle}
          </Badge>
          {isFailed ? <Button size="sm" onClick={retryGeneration} data-testid="retry-generation"><RefreshCw /> Retry generation</Button> : null}
          {isStale ? <Button size="sm" onClick={() => setDialogOpen(true)} data-testid="regenerate-stale"><Sparkles /> Generate walkthrough</Button> : null}
          {lifecycle === "ready" ? <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>Show generate dialog</Button> : null}
        </div>
      </header>
      {isGenerating ? (
        <Alert className="m-4" aria-busy="true" data-testid="walkthrough-generating-alert">
          <Sparkles />
          <AlertTitle>{headline}</AlertTitle>
          <AlertDescription>
            {reassurance}
            <ul className="mt-2 space-y-1 text-xs" data-testid="walkthrough-generating-steps">
              {generationSteps.map((step) => (
                <li key={step} className="flex items-center gap-2"><CheckCircle2 className="size-3 text-primary" /> {step}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {isFailed ? (
        <Alert variant="destructive" className="m-4" data-testid="walkthrough-failed">
          <CircleAlert />
          <AlertTitle>{headline}</AlertTitle>
          <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
            {reassurance}
            <Button size="sm" variant="outline" onClick={retryGeneration}><RefreshCw /> Retry generation</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {isStale ? (
        <Alert variant="destructive" className="m-4" data-testid="walkthrough-stale">
          <ShieldAlert />
          <AlertTitle>{headline}</AlertTitle>
          <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
            {reassurance}
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}><Sparkles /> Generate walkthrough</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid min-h-0 min-w-0 flex-1 gap-4 px-4 pb-4" data-layout={layout}>
        {layout === "rail" ? (
          <>
            <aside role="region" aria-label="Walkthrough chapters" className="rounded-lg border bg-card p-3">
              <h2 className="px-1 text-sm font-semibold">Chapters</h2>
              <p className="mt-1 px-1 text-xs text-muted-foreground">Persistent rail; arrow keys move sections.</p>
              <Separator className="my-3" />
              <ChapterList
                sections={sections}
                currentId={current}
                reviewed={reviewed}
                onSelect={setCurrent}
              />
              <Separator className="my-3" />
              <SupportList reviewed={supportReviewed} onToggle={() => setSupportReviewed((value) => !value)} />
            </aside>
            <SectionPane
              section={currentSection}
              reviewed={reviewed.includes(currentSection.id)}
              onToggleReviewed={() =>
                setReviewed((currentList) =>
                  currentList.includes(currentSection.id)
                    ? currentList.filter((entry) => entry !== currentSection.id)
                    : [...currentList, currentSection.id],
                )
              }
              canGoPrev={canGoPrev}
              canGoNext={canGoNext}
              onPrev={() => { if (canGoPrev) setCurrent(sections[currentIndex - 1]?.id ?? current); }}
              onNext={() => { if (canGoNext) setCurrent(sections[currentIndex + 1]?.id ?? current); }}
            />
          </>
        ) : (
          <>
            <SectionPicker
              sections={sections}
              currentId={current}
              reviewed={reviewed}
              onSelect={setCurrent}
            />
            <SectionPane
              section={currentSection}
              reviewed={reviewed.includes(currentSection.id)}
              onToggleReviewed={() =>
                setReviewed((currentList) =>
                  currentList.includes(currentSection.id)
                    ? currentList.filter((entry) => entry !== currentSection.id)
                    : [...currentList, currentSection.id],
                )
              }
              canGoPrev={canGoPrev}
              canGoNext={canGoNext}
              onPrev={() => { if (canGoPrev) setCurrent(sections[currentIndex - 1]?.id ?? current); }}
              onNext={() => { if (canGoNext) setCurrent(sections[currentIndex + 1]?.id ?? current); }}
            />
          </>
        )}
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-testid="walkthrough-generate-dialog">
          <DialogHeader>
            <DialogTitle>Generate a read-only walkthrough</DialogTitle>
            <DialogDescription>Patchdesk reads the stored patch, never writes to GitHub, and never restarts the run.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Label className="grid gap-1.5">Model
              <Select value={model} onValueChange={(value) => { if (value !== null) setModel(value); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pi-design">Design review model</SelectItem>
                  <SelectItem value="pi-balanced">Balanced reasoning model</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            <Label className="grid gap-1.5">Reasoning
              <Select value={reasoning} onValueChange={(value) => { if (value === "low" || value === "medium" || value === "high") setReasoning(value); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            <p className="text-xs text-muted-foreground">The dialog requires a model and reasoning before any generation request can be made.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={startGeneration} data-testid="generate-walkthrough-confirm"><Sparkles /> Generate read-only walkthrough</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function initialLifecycle(variant: string): WalkthroughLifecycleKey {
  if (variant === "walkthrough-generating") return "generating";
  if (variant === "walkthrough-failed") return "failed";
  if (variant === "walkthrough-stale") return "stale";
  return "ready";
}

function ChapterList({
  sections,
  currentId,
  reviewed,
  onSelect,
}: {
  readonly sections: ReadonlyArray<WalkthroughSectionFixture>;
  readonly currentId: string;
  readonly reviewed: ReadonlyArray<string>;
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <ol className="flex flex-col gap-1" aria-label="Walkthrough sections">
      {sections.map((section) => {
        const active = section.id === currentId;
        const isReviewed = reviewed.includes(section.id);
        return (
          <li key={section.id}>
            <Button
              variant={active ? "secondary" : "ghost"}
              size="sm"
              className="h-auto w-full justify-between whitespace-normal px-2 py-2 text-left"
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(section.id)}
            >
              <span className="min-w-0">
                <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{section.chapter}</span>
                <span className="block text-sm font-medium leading-5">{section.title}</span>
              </span>
              {isReviewed ? <Badge variant="outline" aria-label="Reviewed">reviewed</Badge> : null}
            </Button>
          </li>
        );
      })}
    </ol>
  );
}

function SectionPicker({
  sections,
  currentId,
  reviewed,
  onSelect,
}: {
  readonly sections: ReadonlyArray<WalkthroughSectionFixture>;
  readonly currentId: string;
  readonly reviewed: ReadonlyArray<string>;
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <Card className="gap-2 p-3" aria-label="Walkthrough section picker">
      <CardHeader className="p-0">
        <CardTitle className="text-sm">Linear section picker</CardTitle>
        <CardDescription>One drop-down per section; the comparison view is removed in the retained layout.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 p-0">
        {sections.map((section, index) => (
          <div key={section.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{section.chapter}</p>
              <p className="truncate font-medium">{section.title}</p>
            </div>
            <Select value={currentId === section.id ? "current" : "idle"} onValueChange={(value) => { if (value === "select") onSelect(section.id); }}>
              <SelectTrigger size="sm" aria-label={`Section ${index + 1} controls`}><SelectValue placeholder="Open" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="select">Open section</SelectItem>
                {reviewed.includes(section.id) ? <SelectItem value="reviewed">Reviewed</SelectItem> : null}
              </SelectContent>
            </Select>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SectionPane({
  section,
  reviewed,
  onToggleReviewed,
  canGoPrev,
  canGoNext,
  onPrev,
  onNext,
}: {
  readonly section: WalkthroughSectionFixture;
  readonly reviewed: boolean;
  readonly onToggleReviewed: () => void;
  readonly canGoPrev: boolean;
  readonly canGoNext: boolean;
  readonly onPrev: () => void;
  readonly onNext: () => void;
}): React.JSX.Element {
  return (
    <ScrollArea className="rounded-lg border bg-card">
      <article className="flex min-h-full flex-col gap-4 p-4" aria-label="Walkthrough reading surface">
        <header className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{section.chapter}</Badge>
          <h2 className="text-lg font-semibold" tabIndex={-1}>{section.title}</h2>
        </header>
        <p className="text-sm leading-6 text-muted-foreground">{section.prose}</p>
        <Card className="gap-2 p-3" aria-label="Hunk surface">
          <CardHeader className="p-0">
            <CardTitle className="text-sm">Stored patch hunk</CardTitle>
            <CardDescription className="text-xs">Bounded read of the saved review patch only.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <pre className="rounded-md bg-muted/40 p-3 text-xs leading-5">
              <code>{`diff --git a/${section.highlight.split(":")[0]} b/${section.highlight.split(":")[0]}\n--- a/${section.highlight.split(":")[0]}\n+++ b/${section.highlight.split(":")[0]}\n@@ -1 +1 @@\n-old\n+new\n`}</code>
            </pre>
          </CardContent>
        </Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onToggleReviewed} aria-pressed={reviewed} data-testid="mark-section-reviewed">
            <Star /> {reviewed ? "Reviewed" : "Mark section reviewed"}
          </Button>
          <Button size="sm" variant="outline" onClick={onPrev} disabled={!canGoPrev} aria-label="Previous section" data-testid="section-prev"><ArrowLeft /> Previous</Button>
          <Button size="sm" variant="outline" onClick={onNext} disabled={!canGoNext} aria-label="Next section" data-testid="section-next">Next <ArrowLeft className="rotate-180" /></Button>
          <Button size="sm" variant="ghost" aria-label="Add inline draft comment"><Square /> Add inline comment</Button>
        </div>
        <Separator />
        <p className="text-xs text-muted-foreground">Inline comments use the existing batch action. Back to files preserves file selection, inspector, and diff controls.</p>
      </article>
    </ScrollArea>
  );
}

function SupportList({ reviewed, onToggle }: { readonly reviewed: boolean; readonly onToggle: () => void }): React.JSX.Element {
  return (
    <section role="region" aria-label="Support coverage" className="space-y-2">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Support</h3>
        <Button size="xs" variant="outline" onClick={onToggle} aria-pressed={reviewed} data-testid="mark-support-reviewed">
          {reviewed ? "Reviewed" : "Mark Support reviewed"}
        </Button>
      </header>
      <p className="text-xs text-muted-foreground">Mechanical and low-signal changes stay here; every hunk is shown exactly once.</p>
      <ul className="space-y-1.5">
        {SUPPORT_HUNKS.map((hunk) => (
          <li key={hunk.id} className="rounded-md border bg-muted/40 p-2 text-xs">
            <p className="font-mono text-[11px] text-muted-foreground">{hunk.path}</p>
            <p className="mt-0.5">{hunk.summary}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
