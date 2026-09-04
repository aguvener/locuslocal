const out = document.getElementById("out")!;
const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};

async function probe() {
  log(`userAgent: ${navigator.userAgent}`);
  log(`crossOriginIsolated: ${crossOriginIsolated}`);
  log(
    `originAgentCluster: ${(window as unknown as { originAgentCluster?: boolean }).originAgentCluster}`
  );
  log(`'modelContext' in document: ${"modelContext" in document}`);

  if (!("modelContext" in document)) {
    log(
      "RESULT: UNAVAILABLE — enable chrome://flags/#enable-webmcp-testing and reload"
    );
    (window as any).__probe = { available: false };
    return;
  }

  const mc = (document as any).modelContext;
  log(
    `modelContext keys: ${[...new Set([...Object.keys(mc), ...Object.getOwnPropertyNames(Object.getPrototypeOf(mc))])].join(", ")}`
  );

  const controller = new AbortController();
  let executed = 0;

  await mc.registerTool(
    {
      annotations: { readOnlyHint: true },
      description:
        "Echo a string back. Used only to verify the WebMCP pipeline works.",
      execute: async ({ message }: { message: string }, ctx: unknown) => {
        executed++;
        log(
          `  execute() called, ctx keys: ${ctx ? Object.keys(ctx as object).join(",") : "none"}`
        );
        return {
          content: [
            {
              text: JSON.stringify({ at: Date.now(), echo: message }),
              type: "text",
            },
          ],
        };
      },
      inputSchema: {
        properties: {
          message: { description: "Text to echo", type: "string" },
        },
        required: ["message"],
        type: "object",
      },
      name: "probe_echo",
    },
    { signal: controller.signal }
  );

  const tools = await mc.getTools();
  log(
    `getTools() -> ${tools.length}: ${tools.map((t: any) => t.name).join(", ")}`
  );
  log(`tool object keys: ${Object.keys(tools[0] ?? {}).join(", ")}`);

  const tool = tools.find((t: any) => t.name === "probe_echo");
  const result = await mc.executeTool(
    tool,
    JSON.stringify({ message: "hello" })
  );
  log(`executeTool() -> ${typeof result}: ${JSON.stringify(result)}`);

  controller.abort();
  await new Promise((r) => setTimeout(r, 50));
  const after = await mc.getTools();
  log(`after abort, getTools() -> ${after.length}`);

  const verdict = executed === 1 && after.length === 0;
  log(verdict ? "RESULT: WEBMCP WORKS ✓" : "RESULT: partial — see above");
  (window as any).__probe = {
    available: true,
    executed,
    resultShape: result,
    toolKeys: Object.keys(tools[0] ?? {}),
    toolsAfterAbort: after.length,
  };
}

probe().catch((e) => {
  log(`ERROR: ${e?.stack ?? e}`);
  (window as any).__probe = { available: true, error: String(e) };
});
