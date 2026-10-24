/** Scan top-level method strings without parsing or copying oversized argument bodies. */
export function dynamicToolLine(bytes: Buffer): boolean {
  let depth = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 123 || byte === 91) depth++;
    else if (byte === 125 || byte === 93) depth--;
    else if (byte === 34) {
      const start = i++;
      while (i < bytes.length && bytes[i] !== 34) {
        if (bytes[i] === 92) i++;
        i++;
      }
      if (depth !== 1 || i - start > 128) continue;
      let token: unknown;
      try {
        token = JSON.parse(bytes.subarray(start, i + 1).toString("utf8"));
      } catch {
        return false;
      }
      if (token !== "method") continue;
      let cursor = i + 1;
      while (
        bytes[cursor] === 32 ||
        bytes[cursor] === 9 ||
        bytes[cursor] === 13
      )
        cursor++;
      if (bytes[cursor++] !== 58) continue;
      while (
        bytes[cursor] === 32 ||
        bytes[cursor] === 9 ||
        bytes[cursor] === 13
      )
        cursor++;
      if (bytes[cursor] !== 34) continue;
      const valueStart = cursor++;
      while (
        cursor < bytes.length &&
        bytes[cursor] !== 34 &&
        cursor - valueStart <= 128
      ) {
        if (bytes[cursor] === 92) cursor++;
        cursor++;
      }
      if (cursor - valueStart > 128) continue;
      try {
        if (
          JSON.parse(
            bytes.subarray(valueStart, cursor + 1).toString("utf8"),
          ) === "item/tool/call"
        )
          return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}
