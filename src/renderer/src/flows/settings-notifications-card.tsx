import { WATCH_INTERVAL_MINUTES } from "../../../domain/contracts";
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
  FieldGroup,
  FieldLabel,
} from "../components/ui/field";
import { InlineError } from "../components/ui/inline-error";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { useNotificationSettings } from "../hooks/use-notification-settings";

function intervalLabel(minutes: number): string {
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
}

/**
 * Settings → General → Notifications: the two toggles ADR 0044 describes and
 * the watched pull request poll interval ADR 0045 adds.
 */
export function NotificationsCard(): React.JSX.Element {
  const { state, saveFailed, update } = useNotificationSettings();
  const settings = state._tag === "ready" ? state.settings : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          When Patchdesk is in the background or on another Review.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field
            orientation="horizontal"
            data-disabled={settings === undefined}
          >
            <FieldContent>
              <FieldLabel htmlFor="notifications-enabled">
                Notifications
              </FieldLabel>
              <FieldDescription>
                Insight completion and pending GitHub writes.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="notifications-enabled"
              checked={settings?.enabled ?? false}
              disabled={settings === undefined}
              onCheckedChange={(enabled) => {
                if (settings !== undefined)
                  void update({ ...settings, enabled });
              }}
            />
          </Field>
          <Field
            orientation="horizontal"
            data-disabled={settings === undefined || !settings.enabled}
          >
            <FieldContent>
              <FieldLabel htmlFor="notifications-preparation-merge">
                Review ready and merge completed
              </FieldLabel>
            </FieldContent>
            <Switch
              id="notifications-preparation-merge"
              checked={settings?.preparationAndMerge ?? false}
              disabled={settings === undefined || !settings.enabled}
              onCheckedChange={(preparationAndMerge) => {
                if (settings !== undefined)
                  void update({ ...settings, preparationAndMerge });
              }}
            />
          </Field>
          <Field
            orientation="horizontal"
            data-disabled={settings === undefined || !settings.enabled}
          >
            <FieldContent>
              <FieldLabel htmlFor="notifications-watch-interval">
                Check watched pull requests
              </FieldLabel>
            </FieldContent>
            <Select
              value={String(settings?.intervalMinutes ?? 3)}
              items={WATCH_INTERVAL_MINUTES.map((minutes) => ({
                label: intervalLabel(minutes),
                value: String(minutes),
              }))}
              disabled={settings === undefined || !settings.enabled}
              onValueChange={(value) => {
                const intervalMinutes = WATCH_INTERVAL_MINUTES.find(
                  (minutes) => String(minutes) === value,
                );
                if (settings !== undefined && intervalMinutes !== undefined)
                  void update({ ...settings, intervalMinutes });
              }}
            >
              <SelectTrigger
                id="notifications-watch-interval"
                className="w-40"
                aria-label="Watched pull request check interval"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {WATCH_INTERVAL_MINUTES.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {intervalLabel(minutes)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        {state._tag === "unavailable" || saveFailed ? (
          <InlineError className="mt-3">
            {saveFailed
              ? "Could not save notification settings. The previous choice is kept."
              : "Could not load notification settings."}
          </InlineError>
        ) : null}
      </CardContent>
    </Card>
  );
}
