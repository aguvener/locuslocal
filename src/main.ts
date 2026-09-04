import "./styles.css";
import {
  addFilter,
  addToShortlist,
  clearSelection,
  closeDetail,
  deleteAllLocalData,
  loadDataset,
  peekSavedSession,
  persistWorkspace,
  type ResumableSession,
  removeFilter,
  resumeSession,
  setMode,
  unloadDataset,
} from "./actions";
import { installEgressMonitor, onEgress } from "./egress";
import { activity } from "./mcp/activity";
import { modelContext, ToolRegistry, webmcpAvailable } from "./mcp/registry";
import { syncToolGroups } from "./mcp/tools/index";
import { describeAge } from "./session";
import { store } from "./store";
import { initActivityPanel, renderToolSurface } from "./ui/activity";
import { confirmAction, requestConfirmation } from "./ui/confirm";
import { bindDrawer, renderDrawer } from "./ui/drawer";
import { renderOverview } from "./ui/overview";
import {
  flashPanel,
  renderChromPanel,
  renderDatasetPanel,
  renderFiltersPanel,
  renderNextPanel,
  renderShortlistPanel,
} from "./ui/panels";
import { buildReportHtml, shortlistRow } from "./ui/report";
import {
  bindTableControls,
  initTable,
  refreshTableChrome,
  renderRows,
  scrollRowIntoView,
} from "./ui/table";

// Instrument the network surface before anything else runs, so nothing can
// slip a request in ahead of the monitor.
installEgressMonitor();

const registry = new ToolRegistry({ requestConfirmation });

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const meta = document.getElementById("empty-meta");
  if (meta) {
    meta.textContent = `Something went wrong: ${message}`;
    meta.style.color = "var(--danger)";
  }
}

/**
 * Two views, one document.
 *
 * `/about` is a real path — the Worker serves this same document for it and the
 * dev server falls back the same way — so the page is linkable and the back
 * button works. Navigation is `pushState` rather than a load, because a reload
 * would drop a parsed genome out of memory for no reason: the workbench is
 * still sitting there behind the About page, exactly as the reader left it.
 */
type Route = "about" | "workbench";

const TITLES: Record<Route, string> = {
  about: "About LocusLocal — variant triage that never leaves your tab",
  workbench: "LocusLocal — variant triage that never leaves your tab",
};

/** Top-level so it is compiled once, not on every navigation. */
const TRAILING_SLASH_RE = /\/+$/;

function routeOf(pathname: string): Route {
  return pathname.replace(TRAILING_SLASH_RE, "") === "/about"
    ? "about"
    : "workbench";
}

let route: Route = routeOf(location.pathname);

function applyRoute(): void {
  route = routeOf(location.pathname);
  document.getElementById("about-view")!.hidden = route !== "about";
  document.getElementById("grid")!.hidden = route === "about";
  document.title = TITLES[route];
  if (route === "about") {
    window.scrollTo(0, 0);
  }
  render();
}

function navigate(path: string): void {
  if (location.pathname === path) {
    return;
  }
  history.pushState({}, "", path);
  applyRoute();
}

/**
 * Intercept the in-app links. They are real anchors with real hrefs, so they
 * open in a new tab, copy as a URL and work with no JavaScript — the handler
 * only spares them a reload when the click is an ordinary one.
 */
function bindRouting(): void {
  for (const [id, path] of [
    ["brand-home", "/"],
    ["link-home", "/"],
    ["link-about", "/about"],
  ] as const) {
    document.getElementById(id)?.addEventListener("click", (e) => {
      const ev = e as MouseEvent;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) {
        return;
      }
      e.preventDefault();
      navigate(path);
    });
  }
  window.addEventListener("popstate", applyRoute);
}

let lastFocusedRow: number | null = null;
let suggestedPromptDismissed = false;
const SUGGESTED_PROMPT =
  "Tell me what in this genome deserves attention, using only strong evidence.";

/**
 * The header carries workbench controls only while there is a workbench: with
 * no file open, or on the About page, every group but the source link goes.
 */
const WORKBENCH_BARS = [
  "modebar",
  "bar-panels",
  "bar-session",
  "bar-agent",
  "bar-history",
] as const;

function syncHeaderBars(atWorkbench: boolean): void {
  for (const id of WORKBENCH_BARS) {
    document.getElementById(id)!.hidden = !atWorkbench;
  }
  document.getElementById("bar-about")!.hidden = atWorkbench;
}

function render(): void {
  const { dataset, view, selection, loading, mode } = store.state;
  const inTable = !!dataset && mode === "advanced";
  const atWork = route === "workbench";

  document.getElementById("empty-state")!.hidden = !!dataset;
  document.getElementById("rail-left")!.hidden = !dataset;
  document.getElementById("grid")!.classList.toggle("has-rails", !!dataset);
  document
    .querySelector(".statusbar")!
    .classList.toggle("is-minimal", !(dataset && atWork));
  applyRailState();
  syncHeaderBars(!!dataset && atWork);
  document.getElementById("table-wrap")!.hidden = !inTable;
  document.getElementById("tablebar")!.hidden = !inTable;
  syncSuggestedPromptVisibility(dataset !== null, atWork);

  document.getElementById("panel-filters")!.hidden = !inTable;
  document.getElementById("panel-chrom")!.hidden = !inTable;

  for (const [id, want] of [
    ["btn-mode-guided", "guided"],
    ["btn-mode-advanced", "advanced"],
  ] as const) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    btn?.classList.toggle("is-on", mode === want);
    btn?.setAttribute("aria-selected", String(mode === want));
  }
  renderDatasetPanel();
  renderFiltersPanel();
  renderChromPanel();
  renderShortlistPanel();
  renderNextPanel();
  renderOverview();
  renderDrawer();
  refreshTableChrome();
  if (inTable) {
    renderRows();
  }
  renderToolSurface();

  const foot = document.getElementById("foot-count");
  if (foot && dataset) {
    foot.textContent = `${view.length.toLocaleString()} of ${dataset.n.toLocaleString()} markers`;
  }

  const readout = document.getElementById("selection-readout");
  if (readout) {
    readout.textContent = selection.size ? `${selection.size} selected` : "";
  }
  document.getElementById("btn-clear-selection")!.hidden = selection.size === 0;
  document.getElementById("btn-shortlist-selected")!.hidden =
    selection.size === 0;

  const undo = document.getElementById("btn-undo") as HTMLButtonElement;
  const redo = document.getElementById("btn-redo") as HTMLButtonElement;
  undo.disabled = !store.canUndo;
  redo.disabled = store.redoLabel === null;
  undo.title = store.undoLabel ? `Undo: ${store.undoLabel}` : "Nothing to undo";

  const progress = document.getElementById("load-progress");
  if (progress) {
    progress.hidden = !loading.active;
    const bar = progress.querySelector("i") as HTMLElement | null;
    if (bar) {
      bar.style.width = `${Math.round(loading.progress * 100)}%`;
    }
  }

  if (
    inTable &&
    store.state.focusedRow !== null &&
    store.state.focusedRow !== lastFocusedRow
  ) {
    lastFocusedRow = store.state.focusedRow;
    scrollRowIntoView(store.state.focusedRow);
  }

  syncToolGroups(registry).then(renderToolSurface, reportError);
}

store.subscribe(render);

/**
 * Notices the user has closed. Keyed, so re-reporting the same condition never
 * stacks a second copy, and a warning somebody has already read and accepted
 * does not keep taking a strip of the screen for the rest of the visit.
 */
const dismissedBanners = new Set<string>();

function showBanner(
  key: string,
  tone: "alarm" | "warn",
  parts: (Node | string)[]
): void {
  const host = document.getElementById("banners");
  if (!host || dismissedBanners.has(key)) {
    return;
  }
  const existing = host.querySelector(`[data-banner="${key}"]`);
  if (existing) {
    existing.querySelector(".banner-text")?.replaceChildren(...parts);
    return;
  }

  const bar = document.createElement("div");
  bar.className = `banner is-${tone}`;
  bar.dataset.banner = key;

  const text = document.createElement("span");
  text.className = "banner-text";
  text.append(...parts);

  const close = document.createElement("button");
  close.className = "banner-close";
  close.type = "button";
  close.title = "Dismiss";
  close.setAttribute("aria-label", "Dismiss this notice");
  close.textContent = "\u2715";
  close.addEventListener("click", () => {
    dismissedBanners.add(key);
    bar.remove();
  });

  bar.append(text, close);
  host.append(bar);
}

function bold(text: string): HTMLElement {
  const b = document.createElement("b");
  b.textContent = text;
  return b;
}

/**
 * A real attempt to move bytes off the machine means the product's core promise
 * has been broken, and that is worth the whole width of the screen rather than
 * a gauge nobody is watching. `onEgress` also fires on subscribe and on arming,
 * so the counter has to be checked — a clean page must stay silent.
 */
onEgress((s) => {
  if (s.attempts === 0) {
    return;
  }
  showBanner("egress", "alarm", [
    bold(
      `${s.bytesOut} B left this tab in ${s.attempts} request${s.attempts === 1 ? "" : "s"}.`
    ),
    ` Last target: ${s.lastTarget ?? "unknown"}. The deployed page is served with a CSP that forbids this outright.`,
  ]);
});

function checkWebmcp(): void {
  if (webmcpAvailable()) {
    return;
  }
  const notice = document.getElementById("webmcp-alert");
  const close = document.getElementById("btn-dismiss-webmcp-alert");
  if (!(notice && close)) {
    return;
  }
  notice.hidden = false;
  close.addEventListener(
    "click",
    () => {
      notice.hidden = true;
    },
    { once: true }
  );
}

async function handleFile(file: File): Promise<void> {
  try {
    await loadDataset(file);
    reportQuality();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const meta = document.getElementById("empty-meta");
    if (meta) {
      meta.textContent = `Could not read that file: ${message}`;
      meta.style.color = "var(--danger)";
    }
    store.state.loading = { active: false, label: "", progress: 0 };
    store.emit();
  }
}

function bindFileInputs(): void {
  const input = document.getElementById("file-input") as HTMLInputElement;
  document
    .getElementById("btn-pick-file")
    ?.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) {
      handleFile(file).catch(reportError);
    }
  });

  document
    .getElementById("btn-load-demo")
    ?.addEventListener("click", async () => {
      const mod = await import("./data/demo.data.js");
      await handleFile(
        new File([mod.DEMO_TSV], mod.DEMO_FILENAME, {
          type: "text/tab-separated-values",
        })
      );
    });

  const zone = document.getElementById("dropzone")!;
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    zone.classList.add("is-active");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      zone.classList.remove("is-active");
    }
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove("is-active");
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      handleFile(file).catch(reportError);
    }
  });
}

/**
 * Quoting applies to TSV as well as CSV. A shortlist note is a multi-line
 * <textarea>, and an unquoted newline or tab in one shifts every column and row
 * after it — silently corrupting the file the user hands to a clinician.
 */
const CSV_NEEDS_QUOTING_RE = /["\n\r,]/;
const TSV_NEEDS_QUOTING_RE = /["\n\r\t]/;
const DOUBLE_QUOTE_RE = /"/g;

function shortlistRows(): string[][] {
  if (!store.state.dataset) {
    return [];
  }
  return store.state.shortlist.map((e) => shortlistRow(e.row));
}

function downloadBlob(body: string, filename: string, mime: string): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Run the export. The file is built in memory and handed to the browser's own
 * download machinery — it is never posted anywhere, and under the deployed
 * CSP (`connect-src 'none'`, `form-action 'none'`) posting it would be blocked
 * by the browser even if this code tried.
 */
function doExport(filename: string, format: string): string {
  const base = filename || "shortlist";
  if (format === "html") {
    const report = buildReportHtml();
    if (!report) {
      throw new Error(
        "No dataset is loaded, so there is nothing to report on."
      );
    }
    downloadBlob(report, `${base}.html`, "text/html;charset=utf-8");
    return `Saved a readable report of ${store.state.shortlist.length} shortlisted markers as ${base}.html. Open it and print to PDF to take it to a clinician.`;
  }

  const sep = format === "tsv" ? "\t" : ",";
  const header = [
    "rsid",
    "chromosome",
    "position",
    "genotype",
    "gene",
    "clinvar_significance",
    "review_stars",
    "condition",
    "status",
    "added_by",
    "note",
  ];
  const needsQuoting =
    sep === "," ? CSV_NEEDS_QUOTING_RE : TSV_NEEDS_QUOTING_RE;
  const quote = (v: string) =>
    needsQuoting.test(v) ? `"${v.replace(DOUBLE_QUOTE_RE, '""')}"` : v;
  const body = [header, ...shortlistRows()]
    .map((r) => r.map(quote).join(sep))
    .join("\n");

  const name = `${base}.${format}`;
  downloadBlob(body, name, "text/plain;charset=utf-8");
  return `Exported ${store.state.shortlist.length} shortlisted markers as ${name}.`;
}

/**
 * The declarative WebMCP API.
 *
 * The form itself is the tool definition, via its `toolname` /
 * `tooldescription` attributes, and Chrome derives the input schema from the
 * fields (including the csv/tsv enum, from the <option> elements). Because the
 * form is only in the DOM while the shortlist is non-empty, the tool appears
 * and disappears with it.
 *
 * Behaviour verified in Chrome 152: invoking the tool does **not** submit the
 * form. Chrome fills the fields with the agent's arguments and puts the form
 * into `:tool-form-active` (which we style with a lime glow); the form then
 * waits for a human to press Export, and only then does a submit event fire —
 * carrying `agentInvoked === true` and a `respondWith` to report back.
 *
 * That click is the human's consent, so this path deliberately does NOT raise
 * the confirmation card that the imperative `act_*` tools use. Asking twice for
 * one intent is worse than asking once: the agent proposes by filling the form,
 * the human commits by pressing the button.
 */
function bindExportForm(): void {
  document.addEventListener("submit", (e) => {
    const form = e.target as HTMLFormElement;
    if (form.id !== "export-form") {
      return;
    }
    e.preventDefault();
    const data = new FormData(form);
    const filename = String(data.get("filename") ?? "shortlist");
    const format = String(data.get("format") ?? "csv");

    const agentEvent = e as SubmitEvent & {
      agentInvoked?: boolean;
      respondWith?: (r: Promise<string>) => void;
    };

    if (agentEvent.agentInvoked && agentEvent.respondWith) {
      // Log it alongside the imperative tools, so the Tool Activity panel shows
      // the complete picture rather than silently omitting declarative calls.
      const entry = activity.start(
        "act_export_shortlist",
        "act",
        { filename, format },
        new AbortController()
      );
      let message: string;
      try {
        message = doExport(filename, format);
        activity.finish(entry, {
          effect: `${message} (you approved it by pressing Export)`,
          result: JSON.stringify({
            exported: store.state.shortlist.length,
            filename,
            format,
          }),
          status: "ok",
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
        activity.finish(entry, { error: message, status: "error" });
      }
      agentEvent.respondWith(Promise.resolve(message));
      return;
    }

    doExport(filename, format);
  });
}

function bindSessionActions(): void {
  const input = document.getElementById("file-input") as HTMLInputElement;
  document
    .getElementById("btn-open-another")
    ?.addEventListener("click", () => input.click());

  const askClose = async () => {
    const ok = await confirmAction(
      "Close this file?",
      "The genotypes are dropped from memory. Your saved session stays on this device, so you can pick it up again.",
      "Confirm"
    );
    if (ok) {
      unloadDataset();
    }
  };
  document.getElementById("btn-close-file")?.addEventListener("click", () => {
    askClose().catch(reportError);
  });

  const askWipe = async () => {
    const ok = await confirmAction(
      "Delete everything stored on this device?",
      "This erases the parsed genome, your filters, your shortlist and your notes from this browser. It cannot be undone.",
      "Confirm"
    );
    if (ok) {
      await deleteAllLocalData();
    }
  };
  document.getElementById("btn-wipe")?.addEventListener("click", () => {
    askWipe().catch(reportError);
  });
}

/**
 * The agent rail collapses to a zero-width column rather than being unmounted.
 *
 * What the model can see and what it has done are the point of this project,
 * but they are not what a person reading their own results needs on screen. It
 * used to be toggled with the `hidden` attribute, which meant it could animate
 * open and never animate shut — nothing transitions out of `display: none`.
 * Keeping all three grid tracks and interpolating the last one's width gives a
 * real close, and `inert` takes the clipped contents out of the tab order, so
 * the panel is gone for the keyboard too and not only for the eye.
 *
 * The control is in the header. A tab welded to the window edge was one more
 * thing sitting over the results, and the header is where every other view
 * control already lives. State is a module flag: a per-visit view preference,
 * not something to write to the user's disk.
 *
 * It starts collapsed. A first-time visitor is here to look at their genome,
 * not at the agent's tool surface, and the header toggle is the invitation.
 */
let railHidden = true;

function applyRailState(): void {
  const hasData = store.state.dataset !== null && route === "workbench";
  const rail = document.getElementById("rail-right")!;
  rail.hidden = !hasData;
  rail.toggleAttribute("inert", railHidden);
  document
    .getElementById("grid")!
    .classList.toggle("rail-r-collapsed", railHidden);

  const toggle = document.getElementById("btn-toggle-rail");
  toggle?.classList.toggle("is-on", !railHidden);
  toggle?.setAttribute("aria-expanded", String(!railHidden));
}

function setRail(hidden: boolean): void {
  railHidden = hidden;
  applyRailState();
}

function bindRailCollapse(): void {
  document
    .getElementById("btn-collapse-rail")
    ?.addEventListener("click", () => {
      setRail(true);
      document.getElementById("btn-toggle-rail")?.focus();
    });
  document
    .getElementById("btn-toggle-rail")
    ?.addEventListener("click", () => setRail(!railHidden));
}

/**
 * The left rail as a sheet, for screens too narrow to stand it beside the
 * table. Above 760px the button is not rendered and the class does nothing, so
 * there is one rail here rather than a phone copy of it.
 */
function setPanelSheet(open: boolean): void {
  document.body.classList.toggle("rail-l-open", open);
  document
    .getElementById("btn-panels")
    ?.setAttribute("aria-expanded", String(open));
}

function bindPanelSheet(): void {
  const btn = document.getElementById("btn-panels");
  btn?.addEventListener("click", () =>
    setPanelSheet(!document.body.classList.contains("rail-l-open"))
  );
  document.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("rail-l-open")) {
      return;
    }
    const el = e.target as HTMLElement;
    if (!(el.closest("#rail-left") || el.closest("#btn-panels"))) {
      setPanelSheet(false);
    }
  });
  // A sheet that survives the layout it exists for would sit over the rail it
  // is a copy of.
  window.matchMedia("(min-width: 761px)").addEventListener("change", (e) => {
    if (e.matches) {
      setPanelSheet(false);
    }
  });
}

function bindModeSwitch(): void {
  document
    .getElementById("btn-mode-guided")
    ?.addEventListener("click", () => setMode("guided"));
  document
    .getElementById("btn-mode-advanced")
    ?.addEventListener("click", () => setMode("advanced"));
}

/**
 * Offer to pick up where the user left off.
 *
 * Restoring is offered, never automatic. On a shared machine, silently
 * reopening somebody's genome because they once analysed it here would be a
 * privacy failure dressed up as a convenience.
 */
function renderResumeCard(saved: ResumableSession): void {
  const card = document.getElementById("resume-card");
  if (!card) {
    return;
  }
  card.hidden = false;

  const line = document.createElement("p");
  line.className = "resume-line";
  line.textContent = `You analysed ${saved.sourceName} here ${describeAge(saved.savedAt)} — ${saved.markers.toLocaleString()} markers${
    saved.shortlisted > 0
      ? `, with ${saved.shortlisted} marker${saved.shortlisted === 1 ? "" : "s"} shortlisted`
      : ""
  }. It is still on this device, in this browser.`;

  const actions = document.createElement("div");
  actions.className = "resume-actions";
  const resume = document.createElement("button");
  resume.className = "btn btn-primary";
  resume.type = "button";
  resume.textContent = "Continue where you left off";
  resume.addEventListener("click", () => {
    resumeSession().then(() => {
      card.hidden = true;
    }, reportError);
  });
  const forget = document.createElement("button");
  forget.className = "btn btn-danger";
  forget.type = "button";
  forget.textContent = "Delete it";
  const forgetSaved = async () => {
    const ok = await confirmAction(
      "Delete the saved session?",
      "This erases the stored genome, filters, shortlist and notes from this browser. It cannot be undone.",
      "Confirm"
    );
    if (ok) {
      await deleteAllLocalData();
      card.hidden = true;
    }
  };
  forget.addEventListener("click", () => {
    forgetSaved().catch(reportError);
  });
  actions.append(resume, forget);
  card.replaceChildren(line, actions);
}

async function offerResume(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.has("demo")) {
    return;
  }
  const saved = await peekSavedSession();
  if (saved) {
    renderResumeCard(saved);
  } else {
    const card = document.getElementById("resume-card");
    if (card) {
      card.hidden = true;
    }
  }
}

/**
 * Closing a file drops it from memory but leaves the copy on this device, so
 * the empty state has to offer it again — otherwise "Close file" reads as
 * "throw the analysis away", which is not what it does. After a delete-all,
 * `peekSavedSession` finds nothing and the card stays hidden.
 */
function bindResumeOnClose(): void {
  let hadDataset = false;
  store.subscribe(() => {
    const has = store.state.dataset !== null;
    if (hadDataset && !has) {
      offerResume().catch(reportError);
    }
    hadDataset = has;
  });
}

/**
 * Mirror the working state into IndexedDB. Debounced, because a keystroke in a
 * note emits like any other mutation and the workspace record should not be
 * rewritten on every one.
 */
const PERSIST_DEBOUNCE_MS = 600;

function bindPersistence(): void {
  let timer: number | undefined;
  store.subscribe(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      persistWorkspace().catch(reportError);
    }, PERSIST_DEBOUNCE_MS);
  });
}

/**
 * Where a keystroke belongs to the field the caret is in rather than the app.
 *
 * TEXTAREA was missing from this list, which meant typing the word "seems"
 * into a shortlist note silently shortlisted the current selection.
 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) {
    return false;
  }
  return (
    el.tagName === "INPUT" ||
    el.tagName === "SELECT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable
  );
}

function focusSearch(): void {
  if (store.state.mode !== "advanced") {
    setMode("advanced");
  }
  const input = document.getElementById(
    "search-input"
  ) as HTMLInputElement | null;
  input?.focus();
  input?.select();
}

/** Escape backs out one layer at a time rather than clearing everything. */
function onEscape(): void {
  if (isShortcutsOpen()) {
    toggleShortcuts(false);
    return;
  }
  if (document.body.classList.contains("rail-l-open")) {
    setPanelSheet(false);
    document.getElementById("btn-panels")?.focus();
    return;
  }
  if (store.state.detailRow === null) {
    clearSelection();
  } else {
    closeDetail();
  }
}

/**
 * Chords, which are the only shortcuts that also work from inside a field —
 * a modifier key means the caret is not what the keystroke is aimed at.
 */
function handleChord(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) {
    return false;
  }
  const key = e.key.toLowerCase();
  if (key === "k") {
    e.preventDefault();
    focusSearch();
    return true;
  }
  if (key === "z") {
    e.preventDefault();
    if (e.shiftKey) {
      store.redo();
    } else {
      store.undo();
    }
    return true;
  }
  return false;
}

/** Single keys, which only apply when nothing is being typed into. */
function handleBareKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    onEscape();
    return;
  }
  // `?` is shift-and-something on most layouts, and which key that is varies;
  // accept the shifted slash as well so the hint in the table footer is true
  // on more keyboards than a US one.
  if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
    e.preventDefault();
    toggleShortcuts(!isShortcutsOpen());
    return;
  }
  if (!store.state.dataset) {
    return;
  }
  if (e.key === "/" && !e.shiftKey) {
    e.preventDefault();
    focusSearch();
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "g") {
    setMode(store.state.mode === "guided" ? "advanced" : "guided");
    return;
  }
  if (key === "s" && store.state.selection.size > 0) {
    addToShortlist([...store.state.selection], "flagged by hand", "human");
  }
}

function bindKeyboard(): void {
  document.addEventListener("keydown", (e) => {
    if (handleChord(e)) {
      return;
    }
    if (isTyping(e.target)) {
      // Escape is the way out of a field, and the only bare key a caret does
      // not own — everything else belongs to what is being typed.
      if (e.key === "Escape") {
        (e.target as HTMLElement).blur();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    handleBareKey(e);
  });

  document
    .getElementById("btn-undo")
    ?.addEventListener("click", () => store.undo());
  document
    .getElementById("btn-redo")
    ?.addEventListener("click", () => store.redo());
  document
    .getElementById("btn-shortlist-selected")
    ?.addEventListener("click", () =>
      addToShortlist([...store.state.selection], "flagged by hand", "human")
    );

  const search = document.getElementById(
    "search-input"
  ) as HTMLInputElement | null;
  let timer: number | undefined;
  search?.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const q = search.value.trim();
      const existing = store.state.filters.find((f) => f.kind === "search");
      if (!q) {
        if (existing) {
          removeFilter(existing.id);
        }
        return;
      }
      addFilter({ kind: "search", query: q });
    }, 220);
  });
}

/**
 * The keyboard sheet. Modal, so it takes focus and gives it back — and holds
 * on to it while open, because a dialog you can tab out of behind its own
 * scrim is worse than no dialog.
 */
let shortcutsReturn: HTMLElement | null = null;

function isShortcutsOpen(): boolean {
  return document.getElementById("shortcuts-layer")?.hidden === false;
}

function toggleShortcuts(open: boolean): void {
  const layer = document.getElementById("shortcuts-layer");
  if (!layer || layer.hidden === !open) {
    return;
  }
  layer.hidden = !open;
  if (open) {
    shortcutsReturn = document.activeElement as HTMLElement | null;
    layer.querySelector<HTMLElement>("#btn-close-shortcuts")?.focus();
    return;
  }
  shortcutsReturn?.focus();
  shortcutsReturn = null;
}

function bindShortcutsSheet(): void {
  const layer = document.getElementById("shortcuts-layer");
  document
    .getElementById("btn-shortcuts")
    ?.addEventListener("click", () => toggleShortcuts(true));
  document
    .getElementById("btn-close-shortcuts")
    ?.addEventListener("click", () => toggleShortcuts(false));
  layer?.addEventListener("click", (e) => {
    if (e.target === layer) {
      toggleShortcuts(false);
    }
  });
  layer?.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      layer.querySelector<HTMLElement>("#btn-close-shortcuts")?.focus();
    }
  });
}

/**
 * One polite live region for the whole workbench.
 *
 * The agent and the mouse share a mutation path, so they should share the
 * sentence that reports it: a filter the model applied has to be as audible as
 * one the human clicked, or the table changes under a screen-reader user with
 * nothing said at all. Fed from the same emit every panel re-renders on, and
 * deduplicated, because `render()` runs far more often than the state changes.
 */
function bindAnnouncements(): void {
  const region = document.getElementById("live-region");
  if (!region) {
    return;
  }
  let last = "";
  let timer: number | undefined;

  const say = (text: string) => {
    if (text === last) {
      return;
    }
    last = text;
    window.clearTimeout(timer);
    // A beat of settle time: filters arrive as a burst of emits and only the
    // sentence at the end of it is worth reading out.
    timer = window.setTimeout(() => {
      region.textContent = text;
    }, 320);
  };

  store.subscribe(() => {
    const { dataset, view, filters, selection, shortlist, mode } = store.state;
    if (!dataset) {
      say("");
      return;
    }
    const where = mode === "guided" ? "Guided view" : "Advanced view";
    const shown =
      filters.length === 0
        ? `all ${view.length.toLocaleString()} markers`
        : `${view.length.toLocaleString()} of ${dataset.n.toLocaleString()} markers, ${filters.length} filter${filters.length === 1 ? "" : "s"}`;
    const picked = selection.size ? `, ${selection.size} selected` : "";
    const kept = shortlist.length ? `, ${shortlist.length} shortlisted` : "";
    say(`${where}: ${shown}${picked}${kept}.`);
  });
}

function bindAgentFeedback(): void {
  const PANEL_FOR: Record<string, string> = {
    act_add_to_shortlist: "panel-shortlist",
    act_clear_shortlist: "panel-shortlist",
    act_close_dataset: "panel-dataset",
    act_load_demo_dataset: "panel-dataset",
    act_update_shortlist_entry: "panel-shortlist",
    clear_filters: "panel-filters",
    focus_row: "centre",
    open_variant_details: "drawer",
    set_filter: "panel-filters",
    set_sort: "panel-chrom",
    set_view_mode: "centre",
  };
  let seen = 0;
  activity.subscribe((entries) => {
    if (entries.length === 0) {
      seen = 0;
      return;
    }
    const latest = entries[0]!;
    if (latest.status === "ok" && activity.callCount !== seen) {
      seen = activity.callCount;
      const panel = PANEL_FOR[latest.tool];
      if (panel) {
        flashPanel(panel);
      }
    }
  });
}

async function copySuggestedPrompt(): Promise<void> {
  const button = document.getElementById(
    "btn-copy-suggested-prompt"
  ) as HTMLButtonElement | null;
  if (!button) {
    return;
  }

  try {
    await navigator.clipboard.writeText(SUGGESTED_PROMPT);
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = "Copy prompt";
    }, 1400);
  } catch {
    const prompt = document.getElementById("suggested-prompt-text");
    if (!prompt) {
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(prompt);
    selection?.removeAllRanges();
    selection?.addRange(range);
    button.textContent = "Text selected";
  }
}

function syncSuggestedPromptVisibility(
  hasDataset: boolean,
  atWork: boolean
): void {
  document.getElementById("suggested-prompt")!.hidden =
    suggestedPromptDismissed || !(hasDataset && atWork);
}

function bindSuggestedPrompt(): void {
  const prompt = document.getElementById("suggested-prompt-text");
  if (prompt) {
    prompt.textContent = SUGGESTED_PROMPT;
  }
  document
    .getElementById("btn-copy-suggested-prompt")
    ?.addEventListener("click", () => {
      copySuggestedPrompt().catch(reportError);
    });
  document
    .getElementById("btn-dismiss-suggested-prompt")
    ?.addEventListener("click", () => {
      suggestedPromptDismissed = true;
      const suggestion = document.getElementById("suggested-prompt");
      if (suggestion) {
        suggestion.hidden = true;
      }
    });
}

/**
 * Surface the annotation gate's verdict.
 *
 * A file the gate ruled against produces an empty findings list, and an empty
 * findings list looks exactly like good news. It is not allowed to look like
 * good news, so it takes the full width of the screen and says why.
 */
function reportQuality(): void {
  const q = store.state.quality;
  const ds = store.state.dataset;
  // Keyed per file, and the previous file's verdict is torn down first: a
  // notice dismissed for one genome must never stand in for another's, and a
  // clean file must not inherit a warning.
  for (const el of document.querySelectorAll('[data-banner^="quality"]')) {
    el.remove();
  }
  if (!(q && ds)) {
    return;
  }
  const key = `quality:${ds.sourceName}`;
  if (!q.annotation.enabled) {
    showBanner(key, "warn", [
      bold("Clinical annotation is switched off for this file."),
      ` ${q.annotation.reason} Nothing here is a finding, and an empty findings list is not a clean result.`,
    ]);
    return;
  }
  if (!q.annotation.coordinatesComparable) {
    showBanner(key, "warn", [
      bold(`This file reports build ${q.detectedBuild}.`),
      ` The bundled ClinVar subset is ${q.annotation.clinvarBuild}. Classifications match by rs identifier, which is build-independent, but the positions shown here are not ClinVar's positions — do not quote one as the other.`,
    ]);
  }
}

/**
 * `?demo` loads the bundled genome immediately on page load.
 *
 * This exists so a link can be shared in a state that is already useful — for
 * a judge, or for the deterministic eval suite, which drives tools against a
 * live page and cannot click the confirmation card that act_load_demo_dataset
 * raises. It loads only the bundled public demo file; it cannot be pointed at
 * anything else, so it opens no path to loading data the user did not choose.
 */
async function maybeAutoLoadDemo(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (!params.has("demo")) {
    return;
  }
  const mod = await import("./data/demo.data.js");
  await handleFile(
    new File([mod.DEMO_TSV], mod.DEMO_FILENAME, {
      type: "text/tab-separated-values",
    })
  );
}

async function boot(): Promise<void> {
  initTable();
  bindTableControls();
  bindFileInputs();
  bindExportForm();
  bindKeyboard();
  bindModeSwitch();
  bindDrawer();
  bindAgentFeedback();
  bindPersistence();
  bindResumeOnClose();
  bindRouting();
  bindSessionActions();
  bindRailCollapse();
  bindPanelSheet();
  bindSuggestedPrompt();
  bindShortcutsSheet();
  bindAnnouncements();
  initActivityPanel(registry);
  checkWebmcp();

  if (webmcpAvailable()) {
    const context = modelContext();
    // Reflect the real browser-side tool count, not our own bookkeeping.
    if (
      typeof context.addEventListener === "function" &&
      typeof context.getTools === "function"
    ) {
      context.addEventListener("toolchange", () => {
        context.getTools().then((tools) => {
          const el = document.getElementById("surface-count");
          if (el) {
            el.textContent = String(tools.length);
          }
        }, reportError);
      });
    }
  }

  await syncToolGroups(registry);
  applyRoute();
  await offerResume();
  await maybeAutoLoadDemo();
  reportQuality();
}

boot().catch(reportError);
