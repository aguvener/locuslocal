/**
 * The variant table — the "advanced analysis" surface.
 *
 * Windowed rendering: only the rows inside the viewport (plus a small overscan)
 * exist in the DOM, so a 250k-row view scrolls at 60fps. The visible window is
 * written back into the store on every scroll, because `read_visible_rows` and
 * `compare_groups` report on what the human can actually see — that state lives
 * nowhere but this tab.
 *
 * Selection is the interaction demo moment 2 depends on: click, shift-click for
 * a range, cmd/ctrl-click to add. It is pure DOM state, which is exactly why an
 * agent needs a tool to read it.
 *
 * Every one of those gestures also has a key. The cursor that the arrow keys
 * drive is deliberately *not* `store.state.focusedRow`: moving a cursor is not
 * a mutation, and routing it through the store would push an undo entry — and a
 * journal line the agent can read back — for every keypress of travel.
 */
import {
  clearSelection,
  openDetail,
  selectRange,
  setSort,
  toggleSelection,
} from "../actions";
import type { SortKey } from "../store";
import { store, zygosityOf } from "../store";
import { CHROM_LABELS, genotypeLabel, rsLabel, SIG_LABEL } from "../types";

const ROW_H = 30;
const OVERSCAN = 8;
const MIN_THUMB_H = 26;

const COLUMNS: { key: string; label: string; sort?: SortKey; align?: "r" }[] = [
  { key: "sev", label: "" },
  { key: "rsid", label: "rsid", sort: "rsid" },
  { key: "chr", label: "chr" },
  { align: "r", key: "pos", label: "position", sort: "position" },
  { key: "gt", label: "gt" },
  { key: "zyg", label: "zygosity" },
  { key: "gene", label: "gene", sort: "gene" },
  { key: "sig", label: "clinvar", sort: "significance" },
  { align: "r", key: "stars", label: "rev", sort: "stars" },
  { key: "cond", label: "condition" },
];

/**
 * The last track is `minmax(0, …)` on purpose. At 120px the row was wider than
 * the centre column on an ordinary laptop with both rails open, and since this
 * app hides native scrollbars the condition column simply vanished off the
 * right edge with nothing to say it was there. A floor of zero lets it shrink
 * and ellipsise — the full text is a hover away and in the detail drawer —
 * rather than pushing the table into an invisible horizontal scroll.
 */
const GRID_COLS =
  "14px 100px 36px 96px 44px 70px 86px 128px 38px minmax(0, 1fr)";

let tbody: HTMLElement;
let inner: HTMLElement;
let thead: HTMLElement;
let track: HTMLElement | null;
let thumb: HTMLElement | null;
let anchorViewIdx: number | null = null;

let cursorIdx: number | null = null;

export function initTable(): void {
  tbody = document.getElementById("tbody") as HTMLElement;
  inner = document.getElementById("tbody-inner") as HTMLElement;
  thead = document.getElementById("thead") as HTMLElement;
  track = document.getElementById("table-scroll");
  thumb = document.getElementById("table-scroll-thumb");
  thead.style.setProperty("--cols", GRID_COLS);
  thead.setAttribute("role", "row");

  renderHead();
  tbody.addEventListener("scroll", () => renderRows(), { passive: true });
  tbody.addEventListener("click", onClick);
  tbody.addEventListener("keydown", onKeyDown);
  tbody.addEventListener("focus", onFocus);
  bindScrollbar();
  window.addEventListener("resize", () => renderRows());
}

/**
 * A sortable header is a real button rather than a clickable `div`, so it is
 * reachable by tab and operable by Enter — the sort was mouse-only before —
 * and `aria-sort` puts the current order where a screen reader looks for it.
 */
function headCell(c: (typeof COLUMNS)[number], sortKey: SortKey | null) {
  const el = document.createElement("div");
  el.setAttribute("role", "columnheader");
  if (c.align === "r") {
    el.classList.add("r");
  }
  if (!c.sort) {
    el.textContent = c.label;
    return el;
  }

  const active = sortKey === c.sort;
  const { dir } = store.state.sort;
  el.setAttribute("aria-sort", active ? `${dir}ending` : "none");

  const btn = document.createElement("button");
  btn.className = "th-sort";
  btn.type = "button";
  btn.dataset.sort = c.sort;
  btn.textContent = c.label;
  btn.title = active
    ? `Sorted by ${c.label}, ${dir}ending — click to reverse`
    : `Sort by ${c.label}`;
  if (active) {
    el.classList.add("sorted");
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.className = "th-arrow";
    arrow.textContent = dir === "asc" ? "↑" : "↓";
    btn.append(arrow);
  }
  el.append(btn);
  return el;
}

function renderHead(): void {
  const { sort } = store.state;
  thead.replaceChildren(...COLUMNS.map((c) => headCell(c, sort.key)));
}

function onClick(e: MouseEvent): void {
  const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".trow");
  if (!rowEl) {
    return;
  }
  const viewIdx = Number(rowEl.dataset.viewIdx);
  const row = Number(rowEl.dataset.row);
  const additive = e.metaKey || e.ctrlKey;

  if (e.shiftKey && anchorViewIdx !== null) {
    cursorIdx = viewIdx;
    selectRange(anchorViewIdx, viewIdx, additive);
    return;
  }
  cursorIdx = viewIdx;
  toggleSelection(row, additive);
  anchorViewIdx = viewIdx;
  // A plain click is a question — "what is this?" — so it opens the detail
  // drawer as well as selecting. Modified clicks are building a selection and
  // would be interrupted by a drawer, so they only select.
  if (!additive && store.state.selection.has(row)) {
    openDetail(row);
  }
}

function onFocus(): void {
  if (cursorIdx === null && store.state.view.length > 0) {
    cursorIdx = Math.max(0, Math.floor(tbody.scrollTop / ROW_H));
    renderRows();
  }
}

function pageStep(): number {
  return Math.max(1, Math.floor(tbody.clientHeight / ROW_H) - 1);
}

function targetFor(key: string, from: number, last: number): number | null {
  switch (key) {
    case "ArrowDown":
      return Math.min(last, from + 1);
    case "ArrowUp":
      return Math.max(0, from - 1);
    case "PageDown":
      return Math.min(last, from + pageStep());
    case "PageUp":
      return Math.max(0, from - pageStep());
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

function moveCursor(to: number, extend: boolean): void {
  const from = cursorIdx ?? to;
  if (extend) {
    // Shift-travel grows a range from wherever the run started, exactly as
    // shift-click does — and it is a real mutation, so it is checkpointed.
    anchorViewIdx ??= from;
    cursorIdx = to;
    selectRange(anchorViewIdx, to, false);
    return;
  }
  cursorIdx = to;
  anchorViewIdx = to;
}

function onKeyDown(e: KeyboardEvent): void {
  const { view } = store.state;
  if (view.length === 0 || e.metaKey || e.ctrlKey || e.altKey) {
    return;
  }

  const last = view.length - 1;
  const from = cursorIdx ?? Math.floor(tbody.scrollTop / ROW_H);
  const to = targetFor(e.key, from, last);
  if (to !== null) {
    e.preventDefault();
    moveCursor(to, e.shiftKey);
    revealCursor();
    renderRows();
    return;
  }

  if (cursorIdx === null) {
    return;
  }
  const row = view[cursorIdx];
  if (row === undefined) {
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (!store.state.selection.has(row)) {
      toggleSelection(row, false);
    }
    openDetail(row);
    return;
  }
  if (e.key === " ") {
    e.preventDefault();
    toggleSelection(row, true);
  }
}

function revealCursor(): void {
  if (cursorIdx === null) {
    return;
  }
  const top = cursorIdx * ROW_H;
  const bottom = top + ROW_H;
  if (top < tbody.scrollTop) {
    tbody.scrollTop = top;
  } else if (bottom > tbody.scrollTop + tbody.clientHeight) {
    tbody.scrollTop = bottom - tbody.clientHeight;
  }
}

/**
 * The app hides native scrollbars everywhere on purpose, which is fine for a
 * panel of six rows and wrong for a list of 250,000: there was no way to tell
 * where in the file you were, and no way to get to the middle of it. This is
 * the one place that affordance is worth drawing back in.
 */
function syncScrollbar(): void {
  if (!(track && thumb)) {
    return;
  }
  const { scrollHeight, clientHeight, scrollTop } = tbody;
  const overflow = scrollHeight - clientHeight;
  track.hidden = overflow <= 1;
  if (track.hidden) {
    return;
  }
  const trackH = track.clientHeight;
  const thumbH = Math.max(
    MIN_THUMB_H,
    Math.round(trackH * (clientHeight / scrollHeight))
  );
  const y = Math.round((scrollTop / overflow) * (trackH - thumbH));
  thumb.style.height = `${thumbH}px`;
  thumb.style.transform = `translateY(${y}px)`;
}

function bindScrollbar(): void {
  if (!(track && thumb)) {
    return;
  }
  const grip = thumb;
  const rail = track;
  let startY = 0;
  let startTop = 0;

  const onMove = (e: PointerEvent) => {
    const overflow = tbody.scrollHeight - tbody.clientHeight;
    const span = rail.clientHeight - grip.offsetHeight;
    if (span <= 0) {
      return;
    }
    tbody.scrollTop = startTop + ((e.clientY - startY) / span) * overflow;
  };
  const onUp = (e: PointerEvent) => {
    grip.releasePointerCapture(e.pointerId);
    grip.removeEventListener("pointermove", onMove);
    rail.classList.remove("is-dragging");
  };

  grip.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    startY = e.clientY;
    startTop = tbody.scrollTop;
    grip.setPointerCapture(e.pointerId);
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp, { once: true });
    rail.classList.add("is-dragging");
  });

  rail.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.target !== rail) {
      return;
    }
    const above = e.clientY < grip.getBoundingClientRect().top;
    tbody.scrollBy({ top: above ? -tbody.clientHeight : tbody.clientHeight });
  });
}

function syncViewport(start: number, end: number): void {
  const vp = store.state.viewport;
  if (vp.start !== start || vp.end !== end) {
    store.state.viewport = { end, start };
  }
}

export function renderRows(): void {
  const { view, selection, focusedRow, dataset } = store.state;
  if (!dataset) {
    return;
  }
  if (cursorIdx !== null && cursorIdx > view.length - 1) {
    cursorIdx = view.length ? view.length - 1 : null;
  }
  inner.style.height = `${view.length * ROW_H}px`;
  tbody.setAttribute("aria-rowcount", String(view.length));

  const { scrollTop } = tbody;
  const visible = Math.ceil(tbody.clientHeight / ROW_H);
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(view.length, start + visible + OVERSCAN * 2);

  syncViewport(
    Math.max(0, Math.floor(scrollTop / ROW_H)),
    Math.min(view.length, Math.floor(scrollTop / ROW_H) + visible)
  );

  const shortlisted = new Set(store.state.shortlist.map((s) => s.row));
  const frag = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    frag.append(buildRow(i, view[i]!, { focusedRow, selection, shortlisted }));
  }

  inner.replaceChildren(frag);
  syncActiveDescendant(start, end);
  syncScrollbar();
  renderFootRange();
}

interface RowFlags {
  focusedRow: number | null;
  selection: Set<number>;
  shortlisted: Set<number>;
}

function buildRow(i: number, row: number, flags: RowFlags): HTMLElement {
  const dataset = store.state.dataset!;
  const selected = flags.selection.has(row);
  const el = document.createElement("div");
  el.className = "trow";
  el.id = `vrow-${i}`;
  el.setAttribute("role", "row");
  el.setAttribute("aria-rowindex", String(i + 1));
  el.setAttribute("aria-selected", String(selected));
  el.style.transform = `translateY(${i * ROW_H}px)`;
  el.style.setProperty("--cols", GRID_COLS);
  el.dataset.row = String(row);
  el.dataset.viewIdx = String(i);
  el.classList.toggle("is-selected", selected);
  el.classList.toggle("is-focused", flags.focusedRow === row);
  el.classList.toggle("is-cursor", i === cursorIdx);
  el.classList.toggle("is-shortlisted", flags.shortlisted.has(row));

  const ann = store.annotationFor(row);
  const sigVar = ann ? `var(--sev-${ann.significance})` : "var(--sev-none)";
  el.style.setProperty("--sev", sigVar);

  el.append(
    cell("c-sev", "", (d) => d.append(document.createElement("i"))),
    cell("c-rsid", rsLabel(dataset.rsNum[row]!)),
    cell("c-chr", CHROM_LABELS[dataset.chrom[row]!] ?? "?"),
    cell("c-pos r", dataset.pos[row]!.toLocaleString()),
    cell("c-gt", genotypeLabel(dataset, row)),
    cell("c-zyg", zygosityOf(dataset, row).replace("_", " ")),
    cell("c-gene", ann?.gene || "—"),
    cell("c-sig", ann ? SIG_LABEL[ann.significance] : "—"),
    cell("c-stars r", ann ? "★".repeat(ann.stars) || "—" : ""),
    cell("c-cond", ann?.condition || "")
  );
  return el;
}

/**
 * Only ever points at a row that is actually mounted — windowing unmounts the
 * cursor as soon as it scrolls out of range, and a dangling reference reads
 * worse to a screen reader than no reference at all.
 */
function syncActiveDescendant(start: number, end: number): void {
  if (cursorIdx !== null && cursorIdx >= start && cursorIdx < end) {
    tbody.setAttribute("aria-activedescendant", `vrow-${cursorIdx}`);
  } else {
    tbody.removeAttribute("aria-activedescendant");
  }
}

/**
 * Where you are in the file, in words. The row count alone answers "how many
 * matched"; this answers "how far down am I", which is the question a list of
 * a quarter of a million rows actually raises.
 */
function renderFootRange(): void {
  const el = document.getElementById("foot-range");
  if (!el) {
    return;
  }
  const { start, end } = store.state.viewport;
  const total = store.state.view.length;
  el.textContent =
    total === 0 || end <= start
      ? ""
      : `showing ${(start + 1).toLocaleString()}–${end.toLocaleString()}`;
}

function cell(
  cls: string,
  text: string,
  build?: (d: HTMLElement) => void
): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.setAttribute("role", "gridcell");
  if (text) {
    d.textContent = text;
    d.title = text;
  }
  build?.(d);
  return d;
}

export function scrollRowIntoView(row: number): void {
  const idx = store.state.view.indexOf(row);
  if (idx === -1) {
    return;
  }
  // An agent that points at a row hands the keyboard cursor to it too, so the
  // next arrow key carries on from where the model left off.
  cursorIdx = idx;
  const target = idx * ROW_H - tbody.clientHeight / 2 + ROW_H / 2;
  tbody.scrollTo({ behavior: "smooth", top: Math.max(0, target) });
}

export function refreshTableChrome(): void {
  renderHead();
}

export function bindTableControls(): void {
  document.getElementById("thead")?.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-sort]");
    if (!el?.dataset.sort) {
      return;
    }
    const key = el.dataset.sort as SortKey;
    const { sort } = store.state;
    const dir = sort.key === key && sort.dir === "asc" ? "desc" : "asc";
    setSort(key, dir);
  });

  document
    .getElementById("btn-clear-selection")
    ?.addEventListener("click", () => clearSelection());
}
