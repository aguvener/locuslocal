# WebMCP capability probe — empirical findings

Probed in **Google Chrome 152.0.7977.65** (macOS, arm64) on 2026-09-02 against a
Vite dev server sending `Origin-Agent-Cluster: ?1`. Source: `spike/probe.ts`.

These notes exist because the published docs and the build brief disagree with each
other and, in two places, with the browser. The browser wins.

| Question | Chrome 152 reality |
|---|---|
| `'modelContext' in document` | `true` |
| Isolation requirement | `originAgentCluster === true` is sufficient. `crossOriginIsolated` was `false` — **COOP/COEP are not needed**, only the `Origin-Agent-Cluster: ?1` header. |
| `document.modelContext` surface | `registerTool`, `getTools`, `executeTool`, `ontoolchange` |
| `unregisterTool()` | **Does not exist.** Retraction is only possible by aborting the `AbortSignal` passed as `registerTool(def, { signal })`. Verified: tool count went 1 → 0 after `controller.abort()`. |
| `execute()` signature | **Called with exactly one argument** (the parsed args object). `arguments.length === 1`; there is no second `{ signal }` context object. The brief's "honour the AbortSignal on execute" is **not implementable** in 152. |
| `execute()` return value | An MCP `CallToolResult` **object**: `{ content: [{ type: 'text', text }] }` |
| `executeTool()` return value | A **JSON string** — the serialised `CallToolResult`, not an object. Callers must `JSON.parse`. |
| Registered tool descriptor keys | `name`, `description`, `inputSchema`, `annotations`, `origin`, `title`, `window` |

## Consequences for this build

1. **Dynamic tool surface** is implemented with one `AbortController` per tool group.
   Retracting a group = `controller.abort()`. This is the only supported mechanism.
2. **Cancellation** cannot come from the platform, so it is implemented at the app
   level: every tool call runs under an app-owned `AbortController`, surfaced as a
   Cancel button on the in-flight row of the Tool Activity panel. `execute` still
   accepts an optional second context argument and will pick up `ctx.signal`
   automatically if a future Chrome starts supplying one.
3. Anything consuming `executeTool` must `JSON.parse` the returned string.
