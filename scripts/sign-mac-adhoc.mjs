import { resolve } from "node:path";

import { processOutput, spawnCommand } from "./gate-command-lib.mjs";
import { adhocSignPackagedApp } from "./sign-mac-adhoc-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

/**
 * electron-builder's `afterPack` hook, named by path in `package.json` under
 * `build.afterPack`.
 *
 * electron-builder 26.15.3 loads a hook path with `require()` and falls back
 * to `import()` (`app-builder-lib/helpers/dynamic-import.js`), so this `.mjs`
 * file loads either way, and it takes the module's `default` export because
 * nothing here is named `afterPack` (`app-builder-lib/out/util/resolve.js`).
 * The hook runs once per packed app, after the bundle is complete and before
 * electron-builder signs it and builds the `.dmg` and `.zip`, so an ad-hoc
 * signature applied here is the one that ships inside both downloads.
 *
 * @param {{
 *   readonly appOutDir: string;
 *   readonly electronPlatformName: string;
 *   readonly packager: { readonly appInfo: { readonly productFilename: string } };
 * }} context
 * @returns {Promise<void>}
 */
export default async function signMacAdhoc(context) {
  const outcome = await adhocSignPackagedApp({
    appOutDir: context.appOutDir,
    electronPlatformName: context.electronPlatformName,
    productFilename: context.packager.appInfo.productFilename,
    environment: process.env,
    cwd: projectRoot,
    run: spawnCommand,
    output: processOutput,
  });
  if (!outcome.signed) processOutput.stdout(`${outcome.reason}\n`);
}
