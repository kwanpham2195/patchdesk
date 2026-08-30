/**
 * The Apple credentials the macOS package build reads, under the exact names
 * electron-builder reads them under. `CSC_LINK` and `CSC_KEY_PASSWORD` are the
 * Developer ID certificate and its password; the three `APPLE_` variables are
 * what notarization submits with.
 */
const APPLE_CREDENTIALS = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

/**
 * Decide how `pnpm package:mac` signs, and hand back the environment
 * electron-builder should run under.
 *
 * The build has two shapes. With a Developer ID certificate in `CSC_LINK` it
 * signs, and notarizes as well when the three `APPLE_` variables are set.
 * With no certificate it builds the same unsigned app a local build has
 * always produced.
 *
 * Two details force this to be computed rather than written down in
 * `package.json`:
 *
 * - The unsigned build used to be spelled `"identity": null`, which turns
 *   signing off for every build, including one that has a certificate. The
 *   switch is instead `CSC_IDENTITY_AUTO_DISCOVERY=false`, set here only when
 *   there is no certificate. Without it, a build on a machine whose keychain
 *   holds a Developer ID would start signing on its own and prompt for the
 *   keychain password.
 * - A GitHub Actions secret that was never configured arrives as an empty
 *   string, not as an absent variable, and electron-builder deliberately
 *   accepts an empty `CSC_LINK` as "sign with this". Empty values are removed
 *   here so an unconfigured secret means unsigned rather than a failed build.
 *
 * @param {Record<string, string | undefined>} environment
 * @returns {{
 *   readonly mode: "developer-id" | "unsigned";
 *   readonly notarized: boolean;
 *   readonly summary: string;
 *   readonly environment: Record<string, string | undefined>;
 * }}
 */
export function resolveMacSigningEnvironment(environment) {
  /** @type {Record<string, string | undefined>} */
  const resolved = { ...environment };
  for (const name of APPLE_CREDENTIALS)
    if (isBlank(resolved[name])) delete resolved[name];

  if (isBlank(resolved.CSC_LINK)) {
    resolved.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    return {
      mode: "unsigned",
      notarized: false,
      summary:
        "Packaging unsigned: no CSC_LINK certificate, so code signing and notarization are skipped. The app needs `xattr -cr` on the machine it is installed on.",
      environment: resolved,
    };
  }

  const notarized =
    !isBlank(resolved.APPLE_ID) &&
    !isBlank(resolved.APPLE_APP_SPECIFIC_PASSWORD) &&
    !isBlank(resolved.APPLE_TEAM_ID);
  return {
    mode: "developer-id",
    notarized,
    summary: notarized
      ? "Packaging signed: Developer ID certificate from CSC_LINK, then notarization with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID."
      : "Packaging signed: Developer ID certificate from CSC_LINK. Notarization is skipped because APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are not all set.",
    environment: resolved,
  };
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isBlank(value) {
  return value === undefined || value.trim().length === 0;
}
