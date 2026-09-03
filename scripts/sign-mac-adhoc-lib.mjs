import { join } from "node:path";

import { execute, hasExit } from "./gate-command-lib.mjs";
import { resolveMacSigningEnvironment } from "./package-mac-lib.mjs";

/**
 * Decide whether the packaged macOS app needs an ad-hoc signature, and apply
 * one when it does.
 *
 * The problem this solves is a Gatekeeper message, not a security control.
 * The unsigned build turns signing off with `CSC_IDENTITY_AUTO_DISCOVERY=false`
 * (see `package-mac-lib.mjs`), so the packaged bundle keeps the signature
 * Electron's own binary was linker-signed with:
 *
 *     Identifier=Electron
 *     CodeDirectory flags=0x20002(adhoc,linker-signed)
 *     Sealed Resources=none
 *
 * That signature covers the Electron executable alone. It does not seal the
 * app bundle's resources, and it names an identifier that no longer matches
 * the bundle it sits in, so `codesign --verify --deep --strict` reports "code
 * has no resources but signature indicates they must be present". macOS reads
 * that same broken seal on a downloaded copy as tampering and shows
 * "Patchdesk.app is damaged and can't be opened". The broken seal makes
 * macOS refuse the app even after the quarantine flag is cleared.
 *
 * Signing the whole bundle ad-hoc replaces that with a seal that is intact
 * but anonymous: the identifier becomes the app's own, every resource is
 * hashed, `--verify --deep --strict` passes, and the app runs once
 * `xattr -cr` has cleared the flag. Gatekeeper still reports the download as
 * damaged before that, because an ad-hoc signature is not a certificate and
 * proves nothing about who built the app.
 *
 * The hook stands down on the Developer ID path. electron-builder signs and
 * notarizes that build itself, after this hook runs, and an ad-hoc signature
 * applied first would either be overwritten or -- worse, if the order ever
 * changed -- destroy a notarized one.
 *
 * @param {{
 *   readonly appOutDir: string;
 *   readonly electronPlatformName: string;
 *   readonly productFilename: string;
 *   readonly environment: Record<string, string | undefined>;
 *   readonly cwd: string;
 *   readonly run: import("./gate-command-lib.mjs").RunCommand;
 *   readonly output: import("./gate-command-lib.mjs").CommandOutput;
 * }} options
 * @returns {Promise<{ readonly signed: boolean; readonly reason: string }>}
 */
export async function adhocSignPackagedApp({
  appOutDir,
  electronPlatformName,
  productFilename,
  environment,
  cwd,
  run,
  output,
}) {
  if (electronPlatformName !== "darwin")
    return {
      signed: false,
      reason: `Ad-hoc signing skipped: ${electronPlatformName} is not a macOS build.`,
    };

  const signing = resolveMacSigningEnvironment(environment);
  if (signing.mode !== "unsigned")
    return {
      signed: false,
      reason:
        "Ad-hoc signing skipped: CSC_LINK is set, so electron-builder signs this build with its Developer ID certificate.",
    };

  const bundle = join(appOutDir, `${productFilename}.app`);
  // One `--deep` pass over the bundle is enough here, and was checked against
  // this exact bundle: `codesign --verify --deep --strict` passes afterwards
  // with 18948 sealed files, covering the Electron Framework, the helper apps,
  // and the insight runtime's node binaries and `.node` addons under
  // `Contents/Resources`. Signing inside-out by hand would only be needed if
  // an inner bundle carried a signature `--deep` refused to replace, and
  // `--force` replaces them.
  //
  // No `--options runtime` and no entitlements: the hardened runtime is what
  // notarization requires, and it also restricts what the app may load. Adding
  // it to an anonymous signature buys nothing -- an ad-hoc build is never
  // notarized -- while risking a launch failure that this hook has no
  // certificate path to test against. electron-builder's own default
  // entitlements are applied on the Developer ID path, which this hook leaves
  // alone.
  const result = await execute(
    run,
    "codesign",
    ["--force", "--deep", "--sign", "-", bundle],
    cwd,
    output,
  );
  // Thrown rather than reported: a bundle whose seal did not get replaced is
  // the "damaged" download this hook exists to prevent, and it looks identical
  // to a working one until somebody tries to open it.
  if (result === undefined || !hasExit(result, 0))
    throw new Error(
      `Ad-hoc signing ${bundle} failed: ${
        result === undefined
          ? "codesign could not run"
          : `${result.stdout}${result.stderr}`.trim()
      }`,
    );

  output.stdout(
    `Ad-hoc signed ${bundle}: the build is unsigned, so the bundle carries its own seal instead of Electron's linker-signed one. Gatekeeper will ask the person installing it to confirm an unverified developer.\n`,
  );
  return { signed: true, reason: `Ad-hoc signed ${bundle}.` };
}
