import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";

import { noUnownedProcessEnvRule } from "#tools/oxlint/patchdesk/rules/no-unowned-process-env";

RuleTester.describe = describe;
RuleTester.it = it;

const options = [{ owners: ["src/adapters/process/login-shell-import.ts"] }];

new RuleTester({
  languageOptions: { sourceType: "module" },
}).run("no-unowned-process-env", noUnownedProcessEnvRule, {
  valid: [
    {
      code: "export const path = process.env.PATH;",
      filename: "/repo/src/adapters/process/login-shell-import.ts",
      options,
    },
    {
      code: "export const home = settings.env.HOME; export const cwd = process.cwd();",
      filename: "/repo/src/services/other.ts",
      options,
    },
  ],
  invalid: [
    {
      code: "export const path = process.env.PATH;",
      filename: "/repo/src/services/other.ts",
      options,
      errors: [{ messageId: "unownedEnv" }],
    },
    {
      code: "export function read(environment = process.env) { return environment; }",
      filename: "/repo/src/adapters/process/login-shell-import-extra.ts",
      options,
      errors: [{ messageId: "unownedEnv" }],
    },
  ],
});
