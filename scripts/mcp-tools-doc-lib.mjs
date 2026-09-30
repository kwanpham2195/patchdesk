import { toJsonSchema } from "@valibot/to-json-schema";

const START_MARKER = "<!-- START AUTOMATED TOOLS -->";
const END_MARKER = "<!-- END AUTOMATED TOOLS -->";

/**
 * @typedef {import("@valibot/to-json-schema").JsonSchema} JsonSchema
 * @typedef {{
 *   readonly description: string;
 *   readonly inputSchema: Parameters<typeof toJsonSchema>[0];
 *   readonly annotations: { readonly readOnlyHint?: boolean };
 * }} McpToolDefinition
 */

/**
 * Replace the tools reference between the markers in `docs/mcp.md` with one
 * rendered from the tool manifest, from the same JSON Schema the shim hands
 * to MCP clients.
 *
 * @param {string} document
 * @param {Readonly<Record<string, McpToolDefinition>>} manifest
 * @returns {string}
 */
export function updateMcpToolsBlock(document, manifest) {
  const start = document.indexOf(START_MARKER);
  const end = document.indexOf(END_MARKER);
  if (start === -1 || end < start)
    throw new Error(
      `The document has no ${START_MARKER} ... ${END_MARKER} block.`,
    );
  const tools = Object.entries(manifest).map(([name, tool]) =>
    renderTool(name, tool),
  );
  return `${document.slice(0, start)}${START_MARKER}\n\n${tools.join("\n\n")}\n\n${document.slice(end)}`;
}

const AGENT_START = "<!-- START AUTOMATED AGENT INSTRUCTIONS -->";
const AGENT_END = "<!-- END AUTOMATED AGENT INSTRUCTIONS -->";

/**
 * Replace the "Review in Patchdesk" block between the markers in
 * `docs/mcp.md` with the text the MCP server sends, so the docs hold no
 * hand-kept copy.
 *
 * @param {string} document
 * @param {string} block
 * @returns {string}
 */
export function updateAgentInstructionsBlock(document, block) {
  const start = document.indexOf(AGENT_START);
  const end = document.indexOf(AGENT_END);
  if (start === -1 || end < start)
    throw new Error(
      `The document has no ${AGENT_START} ... ${AGENT_END} block.`,
    );
  return `${document.slice(0, start)}${AGENT_START}\n\n\`\`\`markdown\n${block}\n\`\`\`\n\n${document.slice(end)}`;
}

const LOOP_START = "<!-- START AUTOMATED REVIEW LOOP -->";
const LOOP_END = "<!-- END AUTOMATED REVIEW LOOP -->";

/**
 * Replace the review loop between the markers in the Patchdesk agent skill
 * (`skills/patchdesk/SKILL.md`, #704) with the instructions the MCP server
 * sends, so the skill and the server cannot drift.
 *
 * @param {string} document
 * @param {string} instructions
 * @returns {string}
 */
export function updateSkillReviewLoop(document, instructions) {
  const start = document.indexOf(LOOP_START);
  const end = document.indexOf(LOOP_END);
  if (start === -1 || end < start)
    throw new Error(`The document has no ${LOOP_START} ... ${LOOP_END} block.`);
  return `${document.slice(0, start)}${LOOP_START}\n\n${instructions}\n\n${document.slice(end)}`;
}

/**
 * @param {string} name
 * @param {McpToolDefinition} tool
 * @returns {string}
 */
function renderTool(name, tool) {
  const access = tool.annotations.readOnlyHint === true ? " (read-only)" : "";
  const schema = toJsonSchema(tool.inputSchema);
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {});
  const argumentLines =
    properties.length === 0
      ? ["  - No arguments."]
      : properties.map(([argument, property]) =>
          renderArgument(
            argument,
            objectSchema(property),
            required.has(argument),
          ),
        );
  return [`- **${name}**${access}: ${tool.description}`, ...argumentLines].join(
    "\n",
  );
}

/**
 * @param {string} name
 * @param {JsonSchema} property
 * @param {boolean} required
 * @returns {string}
 */
function renderArgument(name, property, required) {
  const facts = [
    property.oneOf === undefined ? String(property.type) : "object",
    required ? "required" : "optional",
  ];
  if (property.maxLength !== undefined)
    facts.push(
      `at most ${property.maxLength.toLocaleString("en-US")} characters`,
    );
  const description =
    property.description === undefined ? "" : ` ${property.description}`;
  const line = `  - \`${name}\` (${facts.join(", ")}):${description}`;
  if (property.enum !== undefined)
    return `${line} One of ${property.enum.map((value) => `\`${String(value)}\``).join(", ")}.`;
  if (property.oneOf === undefined) return line;
  return [
    `${line} One of:`,
    ...property.oneOf.map(
      (variant) => `    - \`${renderVariant(objectSchema(variant))}\``,
    ),
  ].join("\n");
}

/**
 * One object shape of a `oneOf`, as `{ "kind": "branch", "branch": <string> }`.
 *
 * @param {JsonSchema} variant
 * @returns {string}
 */
function renderVariant(variant) {
  const fields = Object.entries(variant.properties ?? {}).map(
    ([field, value]) => `"${field}": ${renderFieldValue(objectSchema(value))}`,
  );
  return `{ ${fields.join(", ")} }`;
}

/**
 * @param {JsonSchema} value
 * @returns {string}
 */
function renderFieldValue(value) {
  return value.const === undefined
    ? `<${String(value.type)}>`
    : JSON.stringify(value.const);
}

/**
 * Valibot never converts the manifest's schemas to a `true` or `false`
 * subschema, so one means a schema shape this reference cannot describe.
 *
 * @param {JsonSchema | boolean} definition
 * @returns {JsonSchema}
 */
function objectSchema(definition) {
  if (definition === true || definition === false)
    throw new Error(
      "A tool input schema holds a boolean subschema, which the tools reference cannot render.",
    );
  return definition;
}
