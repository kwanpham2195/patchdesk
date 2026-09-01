import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import {
  runPatchdeskChild,
  type PatchdeskChildResult,
} from "./patchdesk-insight-runner";

const walkthrough = {
  citationVersion: 2,
  title: "Smoke walkthrough",
  focus: "The fixed smoke fixture proves the packaged child data channel.",
  chapters: [
    {
      title: "Smoke",
      sections: [
        {
          title: "Result",
          prose: "The child records one bounded result.",
          hunkIds: ["h1"],
        },
      ],
    },
  ],
};
const analysis = {
  changeSummary: "The child runs one bounded analysis.",
  verdict: "approve",
  summary: "No finding in the fixed fixture.",
  findings: [],
  validationPlan: [],
  assumptions: [],
};
/** The four child outcomes one package smoke run reports on stdout. */
type PackageSmokeReport = {
  readonly walkthrough: PatchdeskChildResult;
  readonly analysis: PatchdeskChildResult;
  readonly analysisCallNineDenied: boolean;
  readonly cancellation: PatchdeskChildResult;
};

/** Runs fixed faux fixtures. Production runner never imports this entry or accepts smoke selection. */
export async function runPackageSmoke(): Promise<PackageSmokeReport> {
  assertNoProviderCredentials();
  const walkthroughProvider = fauxProvider({
    provider: "patchdesk-smoke",
    models: [{ id: "fixture" }],
  });
  walkthroughProvider.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_patchdesk_result", walkthrough), {
      stopReason: "toolUse",
    }),
  ]);
  const walkthroughResult = await runPatchdeskChild(
    {
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
    },
    { providers: [walkthroughProvider.provider] },
  );

  const analysisProvider = fauxProvider({
    provider: "patchdesk-smoke",
    models: [{ id: "fixture" }],
  });
  analysisProvider.setResponses([
    fauxAssistantMessage(
      Array.from({ length: 9 }, () => fauxToolCall("list_changed_files", {})),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("submit_patchdesk_result", analysis), {
      stopReason: "toolUse",
    }),
  ]);
  let calls = 0;
  const analysisResult = await runPatchdeskChild(
    {
      type: "analysis",
      input: {
        profileId: "smoke-profile",
        sessionId: "smoke-session",
        contextPath: "/immutable/context.json",
        reviewInputPath: "/immutable/review-input.md",
        patchPath: "/immutable/patch.diff",
        worktreePath: "/immutable/worktree",
        model: "patchdesk-smoke/fixture",
        reasoning: "low",
        prompt: "Inspect and submit the fixed smoke result.",
      },
    },
    {
      providers: [analysisProvider.provider],
      skillPath: new URL(
        "./skills/patchdesk-code-review/SKILL.md",
        import.meta.url,
      ).pathname,
      inspectors: {
        async listChangedFiles() {
          calls += 1;
          return calls <= 8 ? { files: [] } : { denied: true as const };
        },
        async searchFiles() {
          return { denied: true as const };
        },
        async readFileRange() {
          return { denied: true as const };
        },
        async gitShow() {
          return { denied: true as const };
        },
      },
    },
  );
  if (calls !== 9)
    throw new Error("Smoke Analysis did not exercise nine calls");
  const controller = new AbortController();
  controller.abort();
  const cancellation = await runPatchdeskChild(
    {
      type: "walkthrough",
      input: {
        profileId: "smoke-profile",
        sessionId: "smoke-session",
        contextPath: "/immutable/context.json",
        patchPath: "/immutable/patch.diff",
        model: "patchdesk-smoke/fixture",
        reasoning: "low",
        prompt: "Cancelled smoke fixture.",
      },
    },
    { providers: [walkthroughProvider.provider], signal: controller.signal },
  );
  return {
    walkthrough: walkthroughResult,
    analysis: analysisResult,
    analysisCallNineDenied: calls === 9,
    cancellation,
  };
}

function assertNoProviderCredentials(): void {
  for (const key of [
    "ANTHROPIC_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_API_KEY",
  ]) {
    if (process.env[key] !== undefined)
      throw new Error("Package smoke child received a provider credential");
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.stdout.write(JSON.stringify(await runPackageSmoke()));
