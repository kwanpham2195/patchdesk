import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { runPatchdeskChild } from "./patchdesk-insight-runner";

const result = {
  citationVersion: 2,
  title: "Smoke walkthrough",
  focus: "The fixed smoke fixture proves the packaged child data channel.",
  chapters: [{
    title: "Smoke",
    sections: [{
      title: "Result",
      prose: "The child records one bounded result.",
      hunkIds: ["h1"],
    }],
  }],
};

/** Runs a fixed faux-provider Walkthrough fixture. Production runner code cannot select this path. */
export async function runPackageSmoke(): Promise<unknown> {
  const faux = fauxProvider({ provider: "patchdesk-smoke", models: [{ id: "fixture" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_patchdesk_result", result), { stopReason: "toolUse" }),
  ]);
  return await runPatchdeskChild({
    type: "walkthrough",
    input: {
      profileId: "smoke-profile",
      sessionId: "smoke-session",
      contextPath: "/immutable/context.json",
      patchPath: "/immutable/patch.diff",
      model: "patchdesk-smoke/fixture",
      reasoning: "low",
      prompt: "Submit the fixed smoke result.",
    },
  }, { providers: [faux.provider] });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(JSON.stringify(await runPackageSmoke()));
}
