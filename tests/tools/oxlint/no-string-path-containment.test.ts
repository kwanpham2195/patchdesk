import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";

import { noStringPathContainmentRule } from "#tools/oxlint/patchdesk/rules/no-string-path-containment";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({
  languageOptions: { sourceType: "module" },
}).run("no-string-path-containment", noStringPathContainmentRule, {
  valid: [
    'import { join } from "node:path"; export const ok = join(a, b).endsWith(".ts");',
    'import { isAbsolute } from "node:path"; export const ok = repoPath.startsWith("src/");',
    'export const ok = workspaceRoot.startsWith("/tmp");',
    'import { isPathContained } from "./containment"; export const ok = isPathContained(root, file);',
  ],
  invalid: [
    {
      code: 'import { join } from "node:path"; export const bad = file.startsWith(join(root, "out"));',
      errors: [{ messageId: "stringContainment" }],
    },
    {
      code: 'import path from "node:path"; export const bad = path.resolve(input).startsWith(prefix);',
      errors: [{ messageId: "stringContainment" }],
    },
    {
      code: 'import { isAbsolute } from "path"; export const bad = candidate.startsWith(rendererRoot);',
      errors: [{ messageId: "stringContainment" }],
    },
    {
      code: 'import * as nodePath from "node:path"; export const bad = candidate.startsWith(`${cacheDir}${nodePath.sep}`);',
      errors: [{ messageId: "stringContainment" }],
    },
    {
      code: 'import { relative } from "node:path"; export const bad = relative(a, b).startsWith("..");',
      errors: [{ messageId: "stringContainment" }],
    },
  ],
});
