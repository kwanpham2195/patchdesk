import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../components/ui/field";
import { InlineError } from "../components/ui/inline-error";
import { Switch } from "../components/ui/switch";
import { useCheckForUpdatesSetting } from "../hooks/use-check-for-updates-setting";

/** Settings → General → Updates: the release check behind the title-bar notice (#800). */
export function UpdatesCard(): React.JSX.Element {
  const { state, saveFailed, update } = useCheckForUpdatesSetting();
  const enabled = state._tag === "ready" ? state.enabled : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Updates</CardTitle>
        <CardDescription>
          A newer release appears in the title bar, next to Settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field orientation="horizontal" data-disabled={enabled === undefined}>
          <FieldContent>
            <FieldLabel htmlFor="check-for-updates">
              Check for updates
            </FieldLabel>
            <FieldDescription>
              At launch and once a day, ask GitHub for the latest release.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="check-for-updates"
            checked={enabled ?? false}
            disabled={enabled === undefined}
            onCheckedChange={(next) => void update(next)}
          />
        </Field>
        {state._tag === "unavailable" || saveFailed ? (
          <InlineError className="mt-3">
            {saveFailed
              ? "Could not save the update setting. The previous choice is kept."
              : "Could not load the update setting."}
          </InlineError>
        ) : null}
      </CardContent>
    </Card>
  );
}
