import { contextBridge } from "electron";
import { minLength, object, pipe, safeParse, string, url } from "valibot";

import type { RendererLocalApi } from "./ipc-contract";

const preloadConfigurationSchema = object({
  baseUrl: pipe(string(), url()),
  capability: pipe(string(), minLength(1)),
});

const apiUrlArgument = "--patchdesk-api-url=";
const capabilityArgument = "--patchdesk-api-capability=";

const parsedConfiguration = safeParse(preloadConfigurationSchema, {
  baseUrl: readArgument(apiUrlArgument),
  capability: readArgument(capabilityArgument),
});

if (!parsedConfiguration.success) {
  throw new Error("Patchdesk preload received invalid local API configuration");
}

const localApi: RendererLocalApi = Object.freeze({
  baseUrl: parsedConfiguration.output.baseUrl,
  capability: parsedConfiguration.output.capability,
});

contextBridge.exposeInMainWorld("patchdesk", Object.freeze({ localApi }));

function readArgument(prefix: string): string | undefined {
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}
