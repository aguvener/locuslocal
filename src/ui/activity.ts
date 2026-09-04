/**
 * The Tool Activity panel.
 *
 * Every incoming tool call is logged here with its arguments, return payload,
 * duration and the UI change it caused. This is the safety net the brief asks
 * for: a judge who cannot enable WebMCP still sees exactly what the agent
 * interface does, and during a demo it makes the agent's work legible instead
 * of magical.
 *
 * Running calls get a Cancel button. Chrome 152 does not hand `execute` an
 * AbortSignal, so cancellation is owned by the app — see docs/webmcp-probe-findings.md.
 */
import { type ActivityEntry, activity } from "../mcp/activity";
import type { ToolRegistry } from "../mcp/registry";
import { desiredGroups, GROUP_REASON, GROUPS } from "../mcp/tools/index";

let registry: ToolRegistry | null = null;

export function initActivityPanel(reg: ToolRegistry): void {
  registry = reg;
  document
    .getElementById("btn-clear-activity")
    ?.addEventListener("click", () => {
      activity.clear();
    });
  activity.subscribe(renderActivity);
  renderActivity(activity.entries);
}

const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}…` : s;

function callHead(entry: ActivityEntry): HTMLElement {
  const head = document.createElement("div");
  head.className = "call-head";
  if (entry.status === "running") {
    const spin = document.createElement("span");
    spin.className = "spinner";
    head.append(spin);
  }
  const name = document.createElement("span");
  name.className = "call-name";
  name.textContent = entry.tool;
  const layer = document.createElement("span");
  layer.className = "call-layer";
  layer.dataset.layer = entry.layer;
  layer.textContent = entry.layer;
  const ms = document.createElement("span");
  ms.className = "call-ms";
  ms.textContent =
    entry.durationMs === null ? "…" : `${entry.durationMs.toFixed(0)} ms`;
  head.append(name, layer, ms);

  if (entry.status === "running" && entry.controller) {
    const cancel = document.createElement("button");
    cancel.className = "btn btn-sm btn-danger";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => registry?.cancel(entry.id));
    head.append(cancel);
  }
  return head;
}

function line(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  return el;
}

function callCard(entry: ActivityEntry): HTMLElement {
  const card = document.createElement("div");
  card.className = `call is-${entry.status}`;
  card.append(callHead(entry));

  const args = entry.args as Record<string, unknown> | undefined;
  if (args && Object.keys(args).length > 0) {
    card.append(line("call-args", truncate(JSON.stringify(args), 220)));
  }
  for (const note of entry.notes) {
    card.append(line("call-note", `⚠ ${note}`));
  }
  if (entry.effect) {
    card.append(line("call-effect", entry.effect));
  }
  if (entry.error) {
    card.append(line("call-error", entry.error));
  } else if (entry.result) {
    card.append(line("call-result", truncate(entry.result, 420)));
  }
  return card;
}

function renderActivity(entries: ActivityEntry[]): void {
  const el = document.getElementById("activity-body");
  const count = document.getElementById("activity-count");
  if (!el) {
    return;
  }
  if (count) {
    count.textContent = entries.length ? String(entries.length) : "";
  }
  if (entries.length === 0) {
    el.innerHTML =
      '<p class="empty-note" style="padding: 4px 13px">No tool calls yet. Ask the agent something.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    frag.append(callCard(entry));
  }
  el.replaceChildren(frag);
}

/**
 * The live tool surface: which groups are registered right now and why. This is
 * demo moment 3 made visible inside the page, for anyone who cannot open the
 * DevTools WebMCP panel.
 */
export function renderToolSurface(): void {
  const el = document.getElementById("surface-body");
  const count = document.getElementById("surface-count");
  if (!el) {
    return;
  }
  const groups = desiredGroups();
  const names = groups.flatMap((g) => GROUPS[g]().map((s) => s.name));
  // The declarative export tool is defined by the <form> being in the DOM, not
  // by the registry, so count it here too — otherwise this panel disagrees with
  // the browser's own getTools() total.
  const declarative = document.querySelectorAll("form[toolname]").length;
  if (count) {
    count.textContent = String(names.length + declarative);
  }

  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const head = document.createElement("div");
    head.className = "tool-group-head";
    const label = document.createElement("span");
    label.textContent = g;
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = `— ${GROUP_REASON[g]}`;
    head.append(label, why);
    frag.append(head);
    for (const spec of GROUPS[g]()) {
      const row = document.createElement("div");
      row.className = "tool-name-row";
      row.textContent = spec.name;
      row.title = spec.description;
      frag.append(row);
    }
    if (g === "shortlist") {
      for (const form of document.querySelectorAll("form[toolname]")) {
        const row = document.createElement("div");
        row.className = "tool-name-row";
        row.textContent = form.getAttribute("toolname") ?? "";
        row.title = form.getAttribute("tooldescription") ?? "";
        frag.append(row);
      }
    }
  }
  el.replaceChildren(frag);
}
