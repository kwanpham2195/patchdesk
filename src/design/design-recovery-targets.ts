export type DesignRecoveryTarget = {
  readonly primaryLabel: string;
  readonly snapshotReadable: boolean;
};

const RECOVERY_TARGETS: Readonly<Record<string, DesignRecoveryTarget>> = {
  "workbench-reconnect": { primaryLabel: "Reconnect", snapshotReadable: true },
  "workbench-start-again": {
    primaryLabel: "Restart interrupted analysis",
    snapshotReadable: true,
  },
  "workbench-try-again": {
    primaryLabel: "Retry failed analysis",
    snapshotReadable: true,
  },
  "workbench-prepare-again": {
    primaryLabel: "Prepare again",
    snapshotReadable: false,
  },
};

export function designRecoveryTargetFor(
  scenarioId: string,
): DesignRecoveryTarget | undefined {
  return RECOVERY_TARGETS[scenarioId];
}
