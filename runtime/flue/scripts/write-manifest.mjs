import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { generateModelCatalog } from "./generate-model-catalog.mjs";

const lock = await readFile(new URL("../pnpm-lock.yaml", import.meta.url));
const catalog = generateModelCatalog();
await writeFile(
  new URL("../runtime-manifest.json", import.meta.url),
  `${JSON.stringify(
    {
      flueVersion: "2.0.3",
      piVersion: "0.84.4",
      catalogDigest: catalog.digest,
      nodeFloor: ">=22.19.0",
      lockDigest: createHash("sha256").update(lock).digest("hex"),
    },
    null,
    2,
  )}\n`,
);
