import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function RendererRecovery({
  onReload,
}: {
  readonly onReload: () => void;
}): React.JSX.Element {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardDescription>Patchdesk recovery</CardDescription>
          <CardTitle>
            <h1>The workbench could not render safely.</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert variant="warning">
            <AlertDescription>
              Your persisted review state was not changed. Reload Patchdesk to
              reopen the last saved destination; no GitHub write will be
              retried.
            </AlertDescription>
          </Alert>
          <Button className="w-fit" onClick={onReload}>
            Reload Patchdesk
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
