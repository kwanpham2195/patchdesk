import type { IsoTimestamp } from "../../domain/ids";

/**
 * Reads the process wall clock as the branded instant every service's
 * injected `now: () => IsoTimestamp` callback expects.
 *
 * Services take their clock as a constructor dependency so a test can pin a
 * fixed instant. Two composition roots hand them this implementation:
 * `startLocalApiServer` (`src/main/local-api.ts`, 14 wiring sites) and
 * `DashboardController`'s constructor (`src/services/dashboard-controller.ts`,
 * wiring `MaintainerInboxService`). For those sites the brand is established
 * once here instead of at every wiring site.
 *
 * This is not the only wall clock in the repository. `currentIsoTimestamp()`
 * (`src/services/insight-run-coordinator.ts`) is a second one and is the
 * default value of `InsightRunCoordinator`'s `now` parameter, which every
 * timestamp an Insight run writes goes through. `electron-main.ts` builds
 * that coordinator without passing a clock, so `currentIsoTimestamp` — not
 * this function — is the live production clock for Insight runs.
 */
export function systemNow(): IsoTimestamp {
  // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601
  // instant in the `YYYY-MM-DDTHH:mm:ss.sssZ` form `parseIsoTimestamp`
  // accepts, satisfying the branded IsoTimestamp contract.
  return new Date().toISOString() as IsoTimestamp;
}
