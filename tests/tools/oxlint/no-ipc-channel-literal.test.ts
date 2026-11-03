import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";

import { noIpcChannelLiteralRule } from "#tools/oxlint/patchdesk/rules/no-ipc-channel-literal";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({
  languageOptions: { sourceType: "module" },
}).run("no-ipc-channel-literal", noIpcChannelLiteralRule, {
  valid: [
    'import { CHANNEL } from "./x-channel"; ipcMain.handle(CHANNEL, () => 1);',
    'import { CHANNEL } from "./x-channel"; ipcRenderer.invoke(CHANNEL, input);',
    "event.sender.send(CHANNEL, value); window.webContents.send(CHANNEL);",
    'socket.send("ping"); emitter.on("data", handler);',
  ],
  invalid: [
    {
      code: 'ipcMain.handle("desktop:request", () => 1);',
      errors: [{ messageId: "channelLiteral" }],
    },
    {
      code: 'ipcRenderer.on("desktop:event", listener); ipcRenderer.send("desktop:ping");',
      errors: [
        { messageId: "channelLiteral" },
        { messageId: "channelLiteral" },
      ],
    },
    {
      code: "ipcRenderer.invoke(`desktop:${name}`, input);",
      errors: [{ messageId: "channelLiteral" }],
    },
    {
      code: 'window.webContents.send("desktop:event"); event.sender.send("desktop:event");',
      errors: [
        { messageId: "channelLiteral" },
        { messageId: "channelLiteral" },
      ],
    },
  ],
});
