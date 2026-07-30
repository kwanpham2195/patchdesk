import { useState } from "react";
import { CheckCircle2, FileText, Play, Sparkles } from "lucide-react";

import { Badge } from "../renderer/src/components/ui/badge";
import { Button } from "../renderer/src/components/ui/button";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../renderer/src/components/ui/dialog";

export type DesignReviewJourneyVariant = "prepared" | "completed";

export function DesignReviewJourneyScenario({
  variant,
}: {
  readonly variant: DesignReviewJourneyVariant;
}): React.JSX.Element {
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewStatus, setOverviewStatus] = useState<string | undefined>();
  const [analysisStarted, setAnalysisStarted] = useState(false);
  const [publishPreviewOpen, setPublishPreviewOpen] = useState(false);

  return (
    <main
      data-testid={`design-review-${variant}`}
      className="min-h-screen bg-background text-foreground"
    >
      <header className="border-b bg-card px-6 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
          <div className="mr-auto min-w-[14rem]">
            <p className="text-sm font-medium">centraldigital/patchdesk#42</p>
            <p className="text-xs text-muted-foreground">
              Protect review writes
            </p>
          </div>
          <Badge variant="outline">Snapshot · no GitHub writes</Badge>
          <Button
            variant="outline"
            onClick={() => setOverviewOpen(true)}
          >
            Checks · Failing
          </Button>
          {variant === "prepared" ? (
            <Button variant="outline">
              <Sparkles /> Generate walkthrough
            </Button>
          ) : null}
          {variant === "prepared" ? (
            <Button onClick={() => setAnalysisStarted(true)}>
              <Play /> Run analysis
            </Button>
          ) : null}
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 p-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <DesignFilesSurface />
        {variant === "completed" ? (
          <div className="space-y-4">
            <JourneyGroup
              dataTestId="design-understand"
              title="Understand"
              description="2 findings in the stored diff."
              action="Open walkthrough"
            />
            <JourneyGroup
              dataTestId="design-decide"
              title="Decide"
              description="1 local comment is ready to review."
              action="Review local batch"
            />
            <Card data-testid="design-publish">
              <CardHeader>
                <CardTitle>Publish</CardTitle>
                <CardDescription>
                  GitHub writes require a separate confirmation.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => setPublishPreviewOpen(true)}>
                  Review publish actions
                </Button>
                {publishPreviewOpen ? (
                  <p role="status" className="mt-3 text-sm text-muted-foreground">
                    Open Submit review dialog to inspect the confirmation.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        ) : (
          <DesignStoredDiff analysisStarted={analysisStarted} />
        )}
      </div>

      <Dialog open={overviewOpen} onOpenChange={setOverviewOpen}>
        <DialogContent aria-describedby="design-pr-overview-description">
          <DialogHeader>
            <DialogTitle>PR overview</DialogTitle>
            <DialogDescription id="design-pr-overview-description">
              A local snapshot of the pull request and its current checks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p>
              The stored description and check state are safe to inspect. They
              are not a GitHub write.
            </p>
            <div className="rounded-md border p-3">
              <p className="font-medium">Required checks</p>
              <p className="mt-1 text-muted-foreground">
                2 checks passed · 1 check failing
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setOverviewStatus("GitHub state refreshed locally.")}
            >
              <CheckCircle2 /> Refresh GitHub state
            </Button>
            {overviewStatus !== undefined ? (
              <p role="status" className="text-xs text-muted-foreground">
                {overviewStatus}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverviewOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function DesignFilesSurface(): React.JSX.Element {
  return (
    <section aria-label="Files" className="space-y-3">
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">Files</h1>
      </div>
      <nav aria-label="Changed files" className="space-y-1 rounded-lg border bg-card p-2">
        <Button variant="secondary" className="h-auto w-full justify-start py-2 text-left">
          <FileText /> src/review.ts
        </Button>
        <Button variant="ghost" className="h-auto w-full justify-start py-2 text-left">
          <FileText /> src/checks.ts
        </Button>
      </nav>
    </section>
  );
}

function DesignStoredDiff({
  analysisStarted,
}: {
  readonly analysisStarted: boolean;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Stored diff</CardTitle>
        <CardDescription>
          Read the saved snapshot before starting local analysis.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <pre aria-label="Stored diff" className="overflow-x-auto rounded-md bg-muted/40 p-4 text-xs leading-5">
          <code>{`diff --git a/src/review.ts b/src/review.ts\n@@ -34,7 +34,7 @@\n-const mode = "draft";\n+const mode = "prepared";`}</code>
        </pre>
        {analysisStarted ? (
          <p role="status" className="text-sm text-muted-foreground">
            Analysis started for this snapshot.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function JourneyGroup({
  dataTestId,
  title,
  description,
  action,
}: {
  readonly dataTestId: string;
  readonly title: string;
  readonly description: string;
  readonly action: string;
}): React.JSX.Element {
  return (
    <Card data-testid={dataTestId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline">{action}</Button>
      </CardContent>
    </Card>
  );
}
