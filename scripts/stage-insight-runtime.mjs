import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { stageInsightRuntime } from "./stage-insight-runtime-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = join(projectRoot, "out", "workflow-runtime");

await stageInsightRuntime({ projectRoot, runtimeRoot, run });

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveRun(output)
        : reject(new Error(`${command} exited with ${code ?? 1}`)),
    );
  });
}
