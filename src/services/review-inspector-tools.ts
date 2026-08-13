import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import type { ReviewInspector } from "./review-inspector";

type InspectorTool = ToolDefinition;

/** Builds the entire model-facing inspection capability for one prepared review attempt. */
export function createReviewInspectorTools(inspector: ReviewInspector): ReadonlyArray<InspectorTool> {
  return [
    defineTool({
      name: "list_changed_files",
      description: "List the repository-relative files changed by this pull request.",
      input: v.object({}),
      output: v.object({ files: v.array(v.string()) }),
      async run() {
        const files = await inspector.listChangedFiles();
        if (files._tag === "err") return { files: [] };
        return { files: [...files.value] };
      },
    }),
    defineTool({
      name: "search_files",
      description: "Search the changed files for a literal query.",
      input: v.object({ query: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) }),
      output: v.union([v.object({ denied: v.literal(true) }), v.object({ files: v.array(v.string()) })]),
      async run({ input }) {
        const files = await inspector.searchFiles(input.query);
        return files._tag === "ok" ? { files: [...files.value] } : { denied: true as const };
      },
    }),
    defineTool({
      name: "read_file_range",
      description: "Read an inclusive line range from one repository-relative file.",
      input: v.object({ path: v.pipe(v.string(), v.minLength(1)), startLine: v.pipe(v.number(), v.integer(), v.minValue(1)), endLine: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
      output: v.union([v.object({ denied: v.literal(true) }), v.object({ content: v.string() })]),
      async run({ input }) {
        const content = await inspector.readFileRange(input.path, input.startLine, input.endLine);
        return content._tag === "ok" ? { content: content.value } : { denied: true as const };
      },
    }),
    defineTool({
      name: "git_show",
      description: "Read the immutable prepared review head or an explicitly supplied full Git revision.",
      input: v.object({ revision: v.pipe(v.string(), v.minLength(1)) }),
      output: v.union([v.object({ denied: v.literal(true) }), v.object({ content: v.string() })]),
      async run({ input }) {
        const content = await inspector.gitShow(input.revision);
        return content._tag === "ok" ? { content: content.value } : { denied: true as const };
      },
    }),
  ];
}
