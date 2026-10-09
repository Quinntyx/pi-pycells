# Native custom tools

Put JavaScript tools in the extension's `tools/` directory. Export a normal Pi
tool definition (`name`, `description`, `parameters`, `execute`). CommonJS and
ESM default exports are supported. Tools register directly with Pi, never with
Python cells.

```js
module.exports = {
  name: "echo_text",
  description: "Echo text",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute(_id, params) {
    return { content: [{ type: "text", text: params.text }] };
  },
};
```

The loader scans on session startup and watches for changes. Renamed or deleted
files deactivate old names. Invalid exports, duplicate names, and collisions
with builtin/kernel tools are rejected. Watcher failures trigger re-watching.

Legacy `ptc` options are unsupported and rejected. Remove them to register a
normal native tool. There are no Python wrappers or code-execution caller rules.
