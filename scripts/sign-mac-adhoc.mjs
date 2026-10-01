import { resolve } from "node:path";

import { FuseV1Options, FuseVersion } from "@electron/fuses";

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
 * Fuses are flipped here, before the ad-hoc seal, because electron-builder
 * applies `build.electronFuses` after this hook (`platformPackager.js`), which
 * would break the seal. `RunAsNode` stays enabled: the `patchdesk` CLI shim
 * and the Pi Insight child start the app binary with `ELECTRON_RUN_AS_NODE`.
 *
 * @param {{
 *   readonly appOutDir: string;
 *   readonly electronPlatformName: string;
 *   readonly packager: {
 *     readonly appInfo: { readonly productFilename: string };
 *     addElectronFuses(
 *       context: unknown,
 *       fuses: import("@electron/fuses").FuseConfig,
 *     ): Promise<number>;
 *   };
 * }} context
 * @returns {Promise<void>}
 */
export default async function signMacAdhoc(context) {
  await context.packager.addElectronFuses(context, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
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
