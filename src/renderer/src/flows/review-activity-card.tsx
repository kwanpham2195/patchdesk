import { useRef, useState } from "react";
import * as v from "valibot";
import { requestJson } from "../api-client";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

// Not `strictObject`: the redacted local-activity feed may gain fields over
// time, and this panel only ever reads this fixed set.
const activityEventSchema = v.object({
  at: v.string(),
  category: v.string(),
  phase: v.string(),
  retryable: v.boolean(),
  durationMs: v.optional(v.number()),
  detail: v.optional(v.string()),
});

type ActivityEvent = v.InferOutput<typeof activityEventSchema>;

const diagnosticsResponseSchema = v.object({
  events: v.array(v.unknown()),
});

/** Parses the local API's diagnostics response for the Review activity card; each malformed event drops itself instead of discarding the whole feed. */
function parseDiagnosticsResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): ReadonlyArray<ActivityEvent> | undefined {
  const parsed = v.safeParse(diagnosticsResponseSchema, input);
  if (!parsed.success) return undefined;
  const events: ActivityEvent[] = [];
  for (const event of parsed.output.events) {
    const item = v.safeParse(activityEventSchema, event);
    if (item.success) events.push(item.output);
  }
  return events;
}

type ActivityErrorState = {
  readonly generation: number;
  readonly message?: string;
};

/** The active profile's redacted Review and Insight lifecycle events, loaded on request. */
export function ReviewActivityCard({
  profileId,
}: {
  readonly profileId: string | undefined;
}): React.JSX.Element {
  const [activity, setActivity] = useState<ReadonlyArray<ActivityEvent>>();
  const [activityLoadState, setActivityLoadState] =
    useState<ActivityErrorState>({ generation: 0 });
  const activityLoadGeneration = useRef(0);

  const loadActivity = async (): Promise<void> => {
    if (profileId === undefined) return;
    const generation = ++activityLoadGeneration.current;
    setActivityLoadState({ generation });
    try {
      const value = await requestJson(
        `/v1/diagnostics?profileId=${encodeURIComponent(profileId)}`,
      );
      const parsed = parseDiagnosticsResponse(value);
      if (parsed === undefined) throw new Error("invalid_activity");
      const events = parsed.slice(-40).reverse();
      if (generation !== activityLoadGeneration.current) return;
      setActivity(events);
    } catch {
      if (generation !== activityLoadGeneration.current) return;
      setActivity(undefined);
      setActivityLoadState({
        generation,
        message: "Could not load local activity. Try again.",
      });
    }
  };

  return (
    <Card data-testid="review-activity-card">
      <CardHeader>
        <CardTitle>Review activity</CardTitle>
        <CardDescription>
          Local activity for review and walkthrough runs. Prompts and provider
          output are never shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button
          variant="outline"
          disabled={profileId === undefined}
          onClick={() => {
            void loadActivity();
          }}
        >
          Load activity
        </Button>
        {activityLoadState.message === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Activity unavailable</AlertTitle>
            <AlertDescription>{activityLoadState.message}</AlertDescription>
          </Alert>
        )}
        {activity === undefined ? null : activity.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">
            No local review activity yet.
          </p>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Review activity log">
            {activity.map((event) => (
              <li
                key={`${event.at}-${event.category}-${event.phase}-${event.detail ?? ""}`}
                className="rounded-md border p-3 text-sm"
              >
                <p className="font-medium">{activityLabel(event.phase)}</p>
                <p className="text-muted-foreground">
                  {event.category} ·{" "}
                  {event.retryable ? "can retry" : "completed"}
                  {event.durationMs === undefined
                    ? ""
                    : ` · ${Math.round(event.durationMs / 1_000)}s`}
                </p>
                {event.detail === undefined ? null : (
                  <p className="mt-1 text-muted-foreground">{event.detail}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function activityLabel(phase: string): string {
  return phase
    .split("-")
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
