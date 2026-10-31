import { eslintCompatPlugin } from "@oxlint/plugins";

import { noIpcChannelLiteralRule } from "./rules/no-ipc-channel-literal.ts";
import { noMethodSpyingRule } from "./rules/no-method-spying.ts";
import { noStringPathContainmentRule } from "./rules/no-string-path-containment.ts";
import { noUnownedProcessEnvRule } from "./rules/no-unowned-process-env.ts";

/** Patchdesk-owned Oxlint rules, kept outside the vendored anti-slop copy so a reinstall does not drop them. */
const patchdeskPlugin = eslintCompatPlugin({
  meta: { name: "patchdesk" },
  rules: {
    "no-ipc-channel-literal": noIpcChannelLiteralRule,
    "no-method-spying": noMethodSpyingRule,
    "no-string-path-containment": noStringPathContainmentRule,
    "no-unowned-process-env": noUnownedProcessEnvRule,
  },
});

export default patchdeskPlugin;
