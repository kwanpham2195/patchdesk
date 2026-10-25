import {
  insightCleanupFailureDetail,
  insightOriginalInvocationDetail,
} from "#src/domain/insight-failure-diagnostic";
import { constants } from "node:fs";
import {
  open,
  realpath,
  mkdtemp,
  chmod,
  writeFile,
  lstat,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import * as v from "valibot";
import { err, ok, type Result } from "#src/domain/result";
import { InsightProcessCleanupError } from "#src/adapters/process/insight-process-cleanup";
import { isDeepStrictEqual } from "node:util";
import { resolveCodexInsightProvider } from "./codex-insight-provider";
import type {
  JsonObject,
  CodexInsightRpc,
  CodexAppServerFailure,
} from "./codex-app-server-client";
import {
  codexInsightIsolationArgs,
  parseCodexInsightResources,
  codexInsightIsolationConfirmed,
} from "./codex-insight-policy";

const authSchema = v.looseObject({
  auth_mode: v.literal("chatgpt"),
  tokens: v.looseObject({
    access_token: v.pipe(v.string(), v.nonEmpty()),
    account_id: v.pipe(v.string(), v.nonEmpty()),
  }),
});
const expirySchema = v.looseObject({ exp: v.number() });
/** An owned home and externally supplied access token never carry a refresh token. */
export type CodexInsightHome = {
  readonly original: string;
  readonly directory: string;
  readonly login: JsonObject;
  unchanged(requiredMs?: number): Promise<boolean>;
  cleanup(): Promise<void>;
};
export type CodexInsightHomeFactory = (
  requiredMs: number,
) => Promise<Result<CodexInsightHome, "native_auth_unsupported" | "cleanup">>;
const fingerprint = (bytes: Buffer | null): string | null =>
  bytes === null ? null : createHash("sha256").update(bytes).digest("hex");

async function readAccountFile(
  path: string,
  maximum: number,
  optional = false,
): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    // Codex user configuration can be a managed symlink; authentication material cannot.
    const target = optional ? await realpath(path) : path;
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (optional && v.is(v.looseObject({ code: v.literal("ENOENT") }), cause))
      return null;
    throw new Error("native_auth_unsupported");
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > maximum ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error("native_auth_unsupported");
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    if (count > maximum) throw new Error("native_auth_unsupported");
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}

/** File-backed account material stays private; unsupported stores are checked before authentication. */
export const createCodexInsightHome: CodexInsightHomeFactory = async (
  requiredMs,
) => {
  let remove: (() => Promise<void>) | undefined;
  let created: string | undefined;
  try {
    const original = await realpath(
      join(process.env.HOME ?? homedir(), ".codex"),
    );
    const source = join(original, "auth.json");
    const bytes = await readAccountFile(source, 131_072);
    if (bytes === null) return err("native_auth_unsupported");
    const auth = v.safeParse(authSchema, JSON.parse(bytes.toString("utf8")));
    if (!auth.success) return err("native_auth_unsupported");
    const token = auth.output.tokens;
    const claims = v.safeParse(
      expirySchema,
      JSON.parse(
        Buffer.from(
          token.access_token.split(".")[1] ?? "",
          "base64url",
        ).toString("utf8"),
      ),
    );
    if (
      !claims.success ||
      claims.output.exp * 1000 <= Date.now() + requiredMs + 180_000
    )
      return err("native_auth_unsupported");
    const configPath = join(original, "config.toml");
    const configBytes = await readAccountFile(configPath, 1_048_576, true);
    const authHash = fingerprint(bytes),
      configHash = fingerprint(configBytes);
    const parent = await realpath(tmpdir());
    const owned = await mkdtemp(join(parent, "patchdesk-codex-insight-"));
    created = owned;
    const identity = await lstat(owned);
    remove = async () => {
      const current = await lstat(owned);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.ino !== identity.ino ||
        current.dev !== identity.dev ||
        dirname(owned) !== parent ||
        (await realpath(owned)) !== owned
      )
        throw new Error("native_home_cleanup_failed");
      await rm(owned, { recursive: true });
      try {
        await lstat(owned);
      } catch (cause) {
        if (v.is(v.looseObject({ code: v.literal("ENOENT") }), cause)) return;
        throw new Error("native_home_cleanup_failed");
      }
      throw new Error("native_home_cleanup_failed");
    };
    await chmod(owned, 0o700);
    const login = {
      type: "chatgptAuthTokens",
      accessToken: token.access_token,
      chatgptAccountId: token.account_id,
    };
    const credential = join(owned, "account-material.json");
    await writeFile(credential, JSON.stringify(login), {
      mode: 0o600,
      flag: "wx",
    });
    if (
      (identity.mode & 0o777) !== 0o700 ||
      ((await lstat(credential)).mode & 0o777) !== 0o600
    )
      throw new Error("native_auth_unsupported");
    return ok({
      original,
      directory: owned,
      login,
      cleanup: remove,
      unchanged: async (remainingMs = 0) => {
        const [currentAuth, currentConfig] = await Promise.all([
          readAccountFile(source, 131_072),
          readAccountFile(configPath, 1_048_576, true),
        ]);
        return (
          fingerprint(currentAuth) === authHash &&
          fingerprint(currentConfig) === configHash &&
          claims.output.exp * 1000 > Date.now() + remainingMs
        );
      },
    });
  } catch {
    // No credential is written before the directory identity guard exists; uncertainty must not remove a replacement.
    if (created !== undefined && remove === undefined) return err("cleanup");
    if (remove !== undefined) {
      try {
        await remove();
      } catch {
        return err("cleanup");
      }
    }
    return err("native_auth_unsupported");
  }
};

class CodexInsightProcessCleanupError extends InsightProcessCleanupError {
  readonly _tag = "CodexInsightProcessCleanupError" as const;
  constructor(readonly detail: string) {
    super();
  }
}

/** Failed process cessation retains the private home and the safe preceding outcome. */
export async function withCodexInsightProcessCleanup(
  action: () => Promise<Result<unknown, CodexAppServerFailure>>,
  stop: () => Promise<void>,
): Promise<Result<unknown, CodexAppServerFailure>> {
  let result: Result<unknown, CodexAppServerFailure>;
  try {
    result = await action();
  } catch (cause) {
    await stopCodexInsightProcess(stop);
    throw cause;
  }
  await stopCodexInsightProcess(stop, result);
  return result;
}

async function stopCodexInsightProcess(
  stop: () => Promise<void>,
  result?: Result<unknown, CodexAppServerFailure>,
): Promise<void> {
  const original = insightOriginalInvocationDetail(result);
  try {
    await stop();
  } catch {
    throw new CodexInsightProcessCleanupError(
      insightCleanupFailureDetail("process", original),
    );
  }
}

export async function withCodexInsightHome(
  factory: CodexInsightHomeFactory,
  requiredMs: number,
  action: (
    home: CodexInsightHome,
  ) => Promise<Result<unknown, CodexAppServerFailure>>,
  signal?: AbortSignal,
): Promise<Result<unknown, CodexAppServerFailure>> {
  let home: CodexInsightHome | undefined;
  let invocationDetail: string | undefined;
  let result: Result<unknown, CodexAppServerFailure>;
  try {
    const prepared = await factory(requiredMs);
    if (prepared._tag === "err")
      return err({ reason: "runtime_unavailable", phase: prepared.error });
    home = prepared.value;
    result = await action(home);
    invocationDetail = insightOriginalInvocationDetail(result);
    if (!(await home.unchanged()))
      result = err({
        reason: "runtime_unavailable",
        phase: "native_auth_unsupported",
      });
  } catch (cause) {
    // Retain the private home when native processes cannot be confirmed stopped.
    if (cause instanceof InsightProcessCleanupError)
      return err({
        reason: signal?.aborted ? "cancelled" : "runtime_unavailable",
        phase: "cleanup",
        detail:
          cause instanceof CodexInsightProcessCleanupError
            ? cause.detail
            : insightCleanupFailureDetail("process"),
      });
    result = err({
      reason: "runtime_unavailable",
      phase: "native_auth_unsupported",
    });
  }
  try {
    if (home !== undefined) await home.cleanup();
  } catch {
    return err({
      reason: signal?.aborted ? "cancelled" : "runtime_unavailable",
      phase: "cleanup",
      detail: insightCleanupFailureDetail("home", invocationDetail),
    });
  }
  return signal?.aborted ? err({ reason: "cancelled", phase: "turn" }) : result;
}

export type CodexInsightSession = {
  readonly args: ReadonlyArray<string>;
  readonly requirements: JsonObject;
  readonly account: JsonObject;
  readonly provider: string;
  readonly providerSettings: JsonObject;
};
const accountSchema = v.looseObject({
  account: v.looseObject({
    type: v.literal("chatgpt"),
    email: v.nullable(v.string()),
    planType: v.string(),
  }),
});
const requirementsSchema = v.looseObject({
  requirements: v.nullable(v.looseObject({})),
});

/** Native resources are discovered inside the private home, not transplanted from user selectors. */
export async function discoverCodexInsightSession(
  create: () => CodexInsightRpc,
  executable: string,
  cwd: string,
  home: CodexInsightHome,
  signal?: AbortSignal,
): Promise<Result<CodexInsightSession, CodexAppServerFailure>> {
  const discovery = create();
  try {
    const started = await discovery.start(
      executable,
      cwd,
      signal,
      codexInsightIsolationArgs(),
      home.original,
    );
    if (started._tag === "err") return started;
    const config = await discovery.request(
      "config/read",
      { cwd, includeLayers: true },
      signal,
    );
    if (signal?.aborted)
      return err({ reason: "cancelled", phase: "initialize" });
    if (config._tag === "err")
      return err({
        reason: "runtime_unavailable",
        phase: "native_isolation_unsupported",
      });
    const layers = v.safeParse(
      v.looseObject({
        layers: v.array(
          v.looseObject({
            name: v.looseObject({ type: v.string() }),
            config: v.looseObject({
              cli_auth_credentials_store: v.optional(v.string()),
            }),
          }),
        ),
      }),
      config.value,
    );
    if (
      !layers.success ||
      layers.output.layers.some(
        (layer) =>
          layer.name.type !== "sessionFlags" &&
          layer.config.cli_auth_credentials_store !== undefined &&
          layer.config.cli_auth_credentials_store !== "file",
      )
    )
      return err({
        reason: "runtime_unavailable",
        phase: "native_auth_unsupported",
      });
    if (
      (await discovery.request("account/login/start", home.login, signal))
        ._tag === "err"
    )
      return err({
        reason: "runtime_unavailable",
        phase: "native_auth_unsupported",
      });
    const [requirements, account] = await Promise.all([
      discovery.request("configRequirements/read", {}, signal),
      discovery.request("account/read", { refreshToken: false }, signal),
    ]);
    if (
      requirements._tag === "err" ||
      account._tag === "err" ||
      !v.is(accountSchema, account.value) ||
      !v.is(requirementsSchema, requirements.value)
    )
      return err({
        reason: "runtime_unavailable",
        phase: "native_policy_unsupported",
      });
    const privateDiscovery = create();
    try {
      const opened = await privateDiscovery.start(
        executable,
        cwd,
        signal,
        codexInsightIsolationArgs(),
        home.directory,
      );
      if (opened._tag === "err") return opened;
      const [privateConfig, privateSkills] = await Promise.all([
        privateDiscovery.request(
          "config/read",
          { cwd, includeLayers: false },
          signal,
        ),
        privateDiscovery.request(
          "skills/list",
          { cwds: [cwd], forceReload: true },
          signal,
        ),
      ]);
      if (privateConfig._tag === "err" || privateSkills._tag === "err")
        return err({
          reason: "runtime_unavailable",
          phase: "native_isolation_unsupported",
        });
      const resources = parseCodexInsightResources(
        privateConfig.value,
        privateSkills.value,
      );
      const provider = resolveCodexInsightProvider(
        config.value,
        requirements.value,
      );
      if (provider._tag === "err")
        return err({ reason: "runtime_unavailable", phase: provider.error });
      return resources._tag === "ok"
        ? ok({
            args: resources.value,
            requirements: requirements.value,
            account: account.value,
            provider: provider.value.id,
            providerSettings: provider.value.settings,
          })
        : err({
            reason: "runtime_unavailable",
            phase: "native_isolation_unsupported",
          });
    } finally {
      await privateDiscovery.stop();
    }
  } finally {
    await discovery.stop();
  }
}

/** Effective managed restrictions and account identity must match before any generating turn. */
export async function validateCodexInsightSession(
  child: CodexInsightRpc,
  cwd: string,
  home: CodexInsightHome,
  expected: CodexInsightSession,
  signal?: AbortSignal,
): Promise<Result<void, CodexAppServerFailure>> {
  const [config, skills] = await Promise.all([
    child.request("config/read", { cwd, includeLayers: false }, signal),
    child.request("skills/list", { cwds: [cwd], forceReload: true }, signal),
  ]);
  if (signal?.aborted) return err({ reason: "cancelled", phase: "initialize" });
  if (
    config._tag === "err" ||
    skills._tag === "err" ||
    !codexInsightIsolationConfirmed(config.value, skills.value)
  )
    return err({
      reason: "runtime_unavailable",
      phase: "native_isolation_unsupported",
    });
  if (
    (await child.request("account/login/start", home.login, signal))._tag ===
    "err"
  )
    return err({
      reason: "runtime_unavailable",
      phase: "native_auth_unsupported",
    });
  const [requirements, account] = await Promise.all([
    child.request("configRequirements/read", {}, signal),
    child.request("account/read", { refreshToken: false }, signal),
  ]);
  if (requirements._tag === "err" || account._tag === "err")
    return err({
      reason: "runtime_unavailable",
      phase: "native_policy_unsupported",
    });
  const provider = resolveCodexInsightProvider(
    config.value,
    requirements.value,
  );
  if (
    provider._tag === "err" ||
    !v.is(accountSchema, account.value) ||
    !v.is(requirementsSchema, requirements.value) ||
    !isDeepStrictEqual(requirements.value, expected.requirements) ||
    !isDeepStrictEqual(account.value, expected.account) ||
    provider.value.id !== expected.provider ||
    !isDeepStrictEqual(provider.value.settings, expected.providerSettings) ||
    !(await home.unchanged())
  )
    return err({
      reason: "runtime_unavailable",
      phase: "native_policy_unsupported",
    });
  return ok(undefined);
}
