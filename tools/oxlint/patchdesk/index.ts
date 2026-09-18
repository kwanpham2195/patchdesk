import { eslintCompatPlugin } from "@oxlint/plugins";

import { noMethodSpyingRule } from "./rules/no-method-spying.ts";

/** Patchdesk-owned Oxlint rules, kept outside the vendored anti-slop copy so a reinstall does not drop them. */
const patchdeskPlugin = eslintCompatPlugin({
  meta: { name: "patchdesk" },
  rules: {
    "no-method-spying": noMethodSpyingRule,
  },
});

export default patchdeskPlugin;
