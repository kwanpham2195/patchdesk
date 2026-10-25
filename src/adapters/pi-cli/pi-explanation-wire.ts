/** Includes escaped JSON, LF and Pi's duplicated Bash output projection. */
export const PI_EXPLANATION_WIRE_BYTES = 32 * 1024;
export const PI_EXPLANATION_INPUT_BYTES = 24 * 1024;
export const PI_EXPLANATION_SOCKET_ENV = "PATCHDESK_PI_OPERATION_SOCKET";
export const PI_EXPLANATION_CAPABILITY_ENV =
  "PATCHDESK_PI_OPERATION_CAPABILITY";

/** Receipts are never truncated; conservative Bash metadata overhead is reserved. */
export function piExplanationReplyFits(text: string): boolean {
  return (
    Buffer.byteLength(text) <= PI_EXPLANATION_WIRE_BYTES &&
    Buffer.byteLength(
      JSON.stringify({
        content: [{ type: "text", text }],
        structuredContent: {
          output: text,
          truncated: false,
          exit_code: 0,
          wall_time_seconds: Number.MAX_VALUE,
        },
      }),
    ) +
      1024 <=
      PI_EXPLANATION_WIRE_BYTES
  );
}
