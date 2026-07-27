import { useEffect } from "react";

import { App } from "../renderer/src/app";
import { BrandMark } from "../renderer/src/components/brand-mark";
import { Badge } from "../renderer/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../renderer/src/components/ui/card";
import { scenarioFromLocation, scenarioUrl, designScenarios } from "./scenarios";

export function DesignApp(): React.JSX.Element {
  const scenario = scenarioFromLocation();
  useEffect(() => { document.title = scenario === undefined ? "Patchdesk Design" : `Patchdesk Design · ${scenario.title}`; }, [scenario]);
  if (scenario === undefined) return <DesignIndex />;
  return <App />;
}

function DesignIndex(): React.JSX.Element {
  const groups = ["Inbox", "Review workbench", "Settings and dialogs"] as const;
  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-start gap-3">
          <BrandMark size={36} />
          <div>
            <p className="text-sm font-medium text-primary">Patchdesk Design</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Interactive visual prototype</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Open a stable design scenario to review the real Patchdesk renderer with deterministic mock data. Product surfaces do not connect to GitHub, the filesystem, or Electron.</p>
          </div>
        </header>
        <div className="mt-10 space-y-8">
          {groups.map((group) => (
            <section key={group} aria-labelledby={`design-group-${group}`}>
              <div className="mb-3 flex items-center gap-2"><h2 id={`design-group-${group}`} className="text-sm font-semibold">{group}</h2><Badge variant="outline">{designScenarios.filter((scenario) => scenario.group === group).length} scenarios</Badge></div>
              <div className="grid gap-3 md:grid-cols-2">
                {designScenarios.filter((scenario) => scenario.group === group).map((item) => (
                  <a key={item.id} href={scenarioUrl(item.id)} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Card className="h-full transition-colors hover:border-primary/50">
                      <CardHeader><CardTitle className="text-base">{item.title}</CardTitle><CardDescription>{item.id}</CardDescription></CardHeader>
                      <CardContent className="pt-0 text-sm text-muted-foreground">{item.description}</CardContent>
                    </Card>
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
