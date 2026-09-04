/**
 * Left-rail panels: the dataset readout, the filter builder, the chromosome
 * map, and the shortlist worklist. File and session controls live in the
 * header, so they stay reachable from every view.
 *
 * Every panel is a pure function of store state, so a mutation made by an agent
 * and one made by the mouse repaint through exactly the same path. Panels that
 * an agent just changed get a decaying lime outline (`.agent-touched`) so the
 * human can see which one the model touched.
 *
 * The filter builder exists to close a product hole: the agent could filter by
 * significance, zygosity, review stars, gene, region and carrier status, while
 * the human could only search and click a chromosome. A page that claims to
 * work fully without an agent has to hand the human the same controls.
 */
import {
  addFilter,
  addToShortlist,
  clearShortlist,
  describeFilter,
  openDetail,
  removeFilter,
  removeFromShortlist,
  setMode,
  setShortlistNote,
  setShortlistStatus,
} from "../actions";
import { computeOverview } from "../analysis";
import { clinvarVersion } from "../data/annotations";
import type { DataQuality } from "../quality";
import {
  SHORTLIST_STATUSES,
  type ShortlistStatus,
  STATUS_LABEL,
  store,
} from "../store";
import { CHROM_LABELS, rsLabel, SIG_LABEL, type Significance } from "../types";

const SEV_ORDER: Significance[] = [
  "pathogenic",
  "likely_pathogenic",
  "conflicting",
  "uncertain",
  "likely_benign",
  "benign",
  "other",
];

/** Short chip labels — the rail is 288px wide. */
const SEV_SHORT: Record<Significance, string> = {
  benign: "Benign",
  conflicting: "Conflict",
  likely_benign: "Lk benign",
  likely_pathogenic: "Lk path",
  other: "Other",
  pathogenic: "Path",
  uncertain: "Uncertain",
};

/**
 * `hom` only ever appears for a consumer chip export, which reports two
 * identical bases without ever naming the reference allele; `hom_ref` and
 * `hom_alt` only ever appear for a VCF, which does. Offering all of them is
 * harmless — a filter that matches nothing for the loaded file returns nothing
 * rather than lying about it.
 */
const ZYGOSITIES = ["het", "hom", "hom_alt", "hom_ref", "no_call"] as const;
const ZYG_LABEL: Record<string, string> = {
  het: "One copy (het)",
  hom: "Two identical (ref unknown)",
  hom_alt: "Two copies of the variant",
  hom_ref: "Reference (hom ref)",
  no_call: "Not read",
};

const MAX_POSITION = 0xff_ff_ff_ff;

const fmt = (n: number) => n.toLocaleString();

function factCell(k: string, v: string, tone?: "warn"): HTMLElement {
  const cell = document.createElement("div");
  cell.className = tone ? `fact is-${tone}` : "fact";
  const kk = document.createElement("span");
  kk.className = "fact-k";
  kk.textContent = k;
  const vv = document.createElement("span");
  vv.className = "fact-v";
  vv.textContent = v;
  vv.title = v;
  cell.append(kk, vv);
  return cell;
}

/**
 * The quality notes, collapsed.
 *
 * These matter — a build mismatch or a switched-off ClinVar join changes what
 * every number on the screen means — but they are not what somebody reads on
 * the way to their results, so they sit behind one line that says how many
 * there are. When annotation is off, that line is not optional.
 */
function qualityNotes(q: DataQuality): HTMLElement {
  const box = document.createElement("details");
  box.className = q.annotation.enabled ? "quality" : "quality is-blocked";
  box.open = !q.annotation.enabled;

  const head = document.createElement("summary");
  head.textContent = q.annotation.enabled
    ? `${q.warnings.length} note${q.warnings.length === 1 ? "" : "s"} about this file`
    : "ClinVar annotation is off for this file";
  box.append(head);

  const reason = document.createElement("p");
  reason.className = "quality-reason";
  reason.textContent = q.annotation.reason;
  box.append(reason);

  if (q.warnings.length > 0) {
    const list = document.createElement("ul");
    list.className = "quality-list";
    for (const w of q.warnings) {
      const li = document.createElement("li");
      li.textContent = w;
      list.append(li);
    }
    box.append(list);
  }
  return box;
}

export function renderDatasetPanel(): void {
  const el = document.getElementById("dataset-body");
  const count = document.getElementById("dataset-count");
  if (!el) {
    return;
  }
  const ds = store.state.dataset;
  if (!ds) {
    el.innerHTML = '<p class="empty-note">No file loaded.</p>';
    if (count) {
      count.textContent = "";
    }
    return;
  }

  let annotated = 0;
  for (let i = 0; i < ds.n; i++) {
    if (ds.annIdx[i]! >= 0) {
      annotated++;
    }
  }
  if (count) {
    count.textContent = `${fmt(ds.n)} markers`;
  }

  const source = document.createElement("p");
  source.className = "fact-source";
  source.textContent = ds.sourceName;
  source.title = ds.sourceName;

  const q = store.state.quality;
  const grid = document.createElement("div");
  grid.className = "fact-grid";
  grid.append(
    factCell("Type", ds.kind === "vcf" ? "VCF" : "chip export"),
    factCell("Size", `${(ds.sourceBytes / 1e6).toFixed(1)} MB`),
    factCell(
      "Build",
      ds.build ?? "unknown",
      q && q.buildConfidence !== "high" ? "warn" : undefined
    ),
    factCell(
      "Call rate",
      q ? `${((1 - q.noCallRate) * 100).toFixed(1)}%` : "—"
    ),
    factCell(
      "ClinVar hits",
      q?.annotation.enabled === false ? "off" : fmt(annotated),
      q?.annotation.enabled === false ? "warn" : undefined
    ),
    factCell("ClinVar set", clinvarVersion || "bundled")
  );

  const parts: HTMLElement[] = [source, grid];
  if (q && (q.warnings.length > 0 || !q.annotation.enabled)) {
    parts.push(qualityNotes(q));
  }
  el.replaceChildren(...parts);
}

interface FilterBuilder {
  el: HTMLElement;
  update: () => void;
}

let builder: FilterBuilder | null = null;

function activeSignificances(): Set<Significance> {
  const f = store.state.filters.find((x) => x.kind === "significance");
  return new Set(f?.kind === "significance" ? f.values : []);
}

function toggleSignificance(sig: Significance): void {
  const current = activeSignificances();
  if (current.has(sig)) {
    current.delete(sig);
  } else {
    current.add(sig);
  }
  const existing = store.state.filters.find((x) => x.kind === "significance");
  if (current.size === 0) {
    if (existing) {
      removeFilter(existing.id);
    }
    return;
  }
  addFilter({ kind: "significance", values: [...current] });
}

function toggleFlagFilter(kind: "annotated_only" | "carried_only"): void {
  const existing = store.state.filters.find((f) => f.kind === kind);
  if (existing) {
    removeFilter(existing.id);
  } else {
    addFilter({ kind });
  }
}

function fieldRow(
  label: string,
  control: HTMLElement,
  wide = false
): HTMLElement {
  const row = document.createElement("label");
  row.className = wide ? "fb-row fb-row-wide" : "fb-row";
  const span = document.createElement("span");
  span.textContent = label;
  row.append(span, control);
  return row;
}

function chromOptions(select: HTMLSelectElement, anyLabel: string): void {
  const any = document.createElement("option");
  any.value = "";
  any.textContent = anyLabel;
  select.append(any);
  for (let c = 1; c <= 25; c++) {
    const opt = document.createElement("option");
    opt.value = String(c);
    opt.textContent = CHROM_LABELS[c]!;
    select.append(opt);
  }
}

/**
 * Built once and kept in the DOM, so typing a gene symbol survives a repaint
 * caused by an agent touching something else. Only the active-state marks are
 * rewritten on each render.
 */
function createFilterBuilder(): FilterBuilder {
  const el = document.createElement("div");
  el.className = "filter-builder";

  const head = document.createElement("div");
  head.className = "fb-head";
  head.textContent = "Build a filter";
  el.append(head);

  const chips = document.createElement("div");
  chips.className = "fb-chips";
  const chipEls = new Map<Significance, HTMLButtonElement>();
  for (const sig of SEV_ORDER) {
    const chip = document.createElement("button");
    chip.className = "fb-chip";
    chip.type = "button";
    chip.dataset.sig = sig;
    chip.title = SIG_LABEL[sig];
    chip.style.setProperty("--sev", `var(--sev-${sig})`);
    chip.textContent = SEV_SHORT[sig];
    chip.addEventListener("click", () => toggleSignificance(sig));
    chips.append(chip);
    chipEls.set(sig, chip);
  }
  el.append(fieldRow("Classification", chips, true));

  const flags = document.createElement("div");
  flags.className = "fb-flags";
  const annotatedBtn = document.createElement("button");
  annotatedBtn.className = "fb-flag";
  annotatedBtn.type = "button";
  annotatedBtn.textContent = "ClinVar record";
  annotatedBtn.title = "Has a ClinVar record";
  annotatedBtn.setAttribute("aria-label", "Has a ClinVar record");
  annotatedBtn.addEventListener("click", () =>
    toggleFlagFilter("annotated_only")
  );
  const carriedBtn = document.createElement("button");
  carriedBtn.className = "fb-flag";
  carriedBtn.type = "button";
  carriedBtn.textContent = "I carry";
  carriedBtn.title = "Variants I carry";
  carriedBtn.setAttribute("aria-label", "Variants I carry");
  carriedBtn.addEventListener("click", () => toggleFlagFilter("carried_only"));
  flags.append(annotatedBtn, carriedBtn);
  el.append(flags);

  const zyg = document.createElement("select");
  zyg.setAttribute("aria-label", "Zygosity filter");
  const zygAny = document.createElement("option");
  zygAny.value = "";
  zygAny.textContent = "any";
  zyg.append(zygAny);
  for (const z of ZYGOSITIES) {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = ZYG_LABEL[z]!;
    zyg.append(opt);
  }
  zyg.addEventListener("change", () => {
    const existing = store.state.filters.find((f) => f.kind === "zygosity");
    if (!zyg.value) {
      if (existing) {
        removeFilter(existing.id);
      }
      return;
    }
    addFilter({ kind: "zygosity", value: zyg.value as never });
  });
  el.append(fieldRow("Zygosity", zyg));

  const stars = document.createElement("select");
  stars.setAttribute("aria-label", "Minimum review stars");
  const starsAny = document.createElement("option");
  starsAny.value = "";
  starsAny.textContent = "any";
  stars.append(starsAny);
  for (let n = 0; n <= 4; n++) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = `${n}★ and up`;
    stars.append(opt);
  }
  stars.addEventListener("change", () => {
    const existing = store.state.filters.find((f) => f.kind === "min_stars");
    if (stars.value === "") {
      if (existing) {
        removeFilter(existing.id);
      }
      return;
    }
    addFilter({ kind: "min_stars", stars: Number(stars.value) });
  });
  el.append(fieldRow("Review status", stars));

  const geneWrap = document.createElement("div");
  geneWrap.className = "fb-inline";
  const gene = document.createElement("input");
  gene.type = "text";
  gene.placeholder = "e.g. BRCA2…";
  gene.setAttribute("aria-label", "Gene symbol filter");
  const geneGo = document.createElement("button");
  geneGo.className = "btn btn-sm";
  geneGo.type = "button";
  geneGo.textContent = "Apply";
  const applyGene = () => {
    const value = gene.value.trim().toUpperCase();
    const existing = store.state.filters.find((f) => f.kind === "gene");
    if (!value) {
      if (existing) {
        removeFilter(existing.id);
      }
      return;
    }
    addFilter({ gene: value, kind: "gene" });
  };
  geneGo.addEventListener("click", applyGene);
  gene.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applyGene();
    }
  });
  geneWrap.append(gene, geneGo);
  el.append(fieldRow("Gene", geneWrap, true));

  const regionWrap = document.createElement("div");
  regionWrap.className = "fb-region";
  const chrom = document.createElement("select");
  chrom.setAttribute("aria-label", "Chromosome for the region filter");
  chromOptions(chrom, "chr");
  const start = document.createElement("input");
  start.type = "number";
  start.min = "0";
  start.placeholder = "Start…";
  start.setAttribute("aria-label", "Region start position");
  const end = document.createElement("input");
  end.type = "number";
  end.min = "0";
  end.placeholder = "End…";
  end.setAttribute("aria-label", "Region end position");
  const regionGo = document.createElement("button");
  regionGo.className = "btn btn-sm";
  regionGo.type = "button";
  regionGo.textContent = "Apply";
  regionGo.addEventListener("click", () => {
    if (!chrom.value) {
      return;
    }
    const c = Number(chrom.value);
    if (start.value === "" && end.value === "") {
      addFilter({ chrom: c, kind: "chromosome" });
      return;
    }
    addFilter({
      chrom: c,
      end: end.value === "" ? MAX_POSITION : Number(end.value),
      kind: "region",
      start: start.value === "" ? 0 : Number(start.value),
    });
  });
  regionWrap.append(chrom, start, end, regionGo);
  el.append(fieldRow("Chromosome / region", regionWrap, true));

  const update = () => {
    const sigs = activeSignificances();
    for (const [sig, chip] of chipEls) {
      chip.classList.toggle("is-on", sigs.has(sig));
      chip.setAttribute("aria-pressed", String(sigs.has(sig)));
    }
    const { filters } = store.state;
    const annotatedOn = filters.some((f) => f.kind === "annotated_only");
    const carriedOn = filters.some((f) => f.kind === "carried_only");
    annotatedBtn.classList.toggle("is-on", annotatedOn);
    annotatedBtn.setAttribute("aria-pressed", String(annotatedOn));
    carriedBtn.classList.toggle("is-on", carriedOn);
    carriedBtn.setAttribute("aria-pressed", String(carriedOn));

    const zygFilter = filters.find((f) => f.kind === "zygosity");
    zyg.value = zygFilter?.kind === "zygosity" ? zygFilter.value : "";
    const starFilter = filters.find((f) => f.kind === "min_stars");
    stars.value =
      starFilter?.kind === "min_stars" ? String(starFilter.stars) : "";
    const geneFilter = filters.find((f) => f.kind === "gene");
    if (document.activeElement !== gene) {
      gene.value = geneFilter?.kind === "gene" ? geneFilter.gene : "";
    }
    const chromFilter = filters.find(
      (f) => f.kind === "chromosome" || f.kind === "region"
    );
    if (document.activeElement !== chrom) {
      chrom.value =
        chromFilter && "chrom" in chromFilter ? String(chromFilter.chrom) : "";
    }
  };

  return { el, update };
}

export function renderFiltersPanel(): void {
  const el = document.getElementById("filters-body");
  const count = document.getElementById("filters-count");
  if (!el) {
    return;
  }
  const { filters, view, dataset } = store.state;
  if (count) {
    count.textContent = dataset
      ? `${fmt(view.length)} / ${fmt(dataset.n)}`
      : "";
  }

  if (!dataset) {
    el.innerHTML = '<p class="empty-note">Load a file to filter it.</p>';
    builder = null;
    return;
  }

  builder ??= createFilterBuilder();

  const stack = document.createElement("div");
  stack.className = "filter-stack";
  if (filters.length === 0) {
    const none = document.createElement("p");
    none.className = "empty-note";
    none.textContent = "No filters. Showing everything.";
    stack.append(none);
  } else {
    for (const f of filters) {
      const pill = document.createElement("div");
      pill.className = "filter-pill";
      const label = document.createElement("span");
      label.textContent = describeFilter(f);
      const x = document.createElement("button");
      x.className = "x";
      x.type = "button";
      x.textContent = "✕";
      x.title = "Remove this filter";
      x.addEventListener("click", () => removeFilter(f.id));
      pill.append(label, x);
      stack.append(pill);
    }
  }

  el.replaceChildren(stack, builder.el);
  builder.update();
}

export function renderChromPanel(): void {
  const el = document.getElementById("chrom-body");
  if (!el) {
    return;
  }
  const ds = store.state.dataset;
  if (!ds) {
    el.innerHTML = '<p class="empty-note">—</p>';
    return;
  }

  const total = new Uint32Array(26);
  const flagged = new Uint32Array(26);
  for (const r of store.state.view) {
    const c = ds.chrom[r]!;
    total[c]!++;
    const a = store.annotationFor(r);
    if (
      a?.significance === "pathogenic" ||
      a?.significance === "likely_pathogenic"
    ) {
      flagged[c]!++;
    }
  }
  const max = Math.max(1, ...total);
  const activeChrom = store.state.filters.find((f) => f.kind === "chromosome");

  const map = document.createElement("div");
  map.className = "chrom-map";
  for (let c = 1; c <= 25; c++) {
    if (!ds.chromCounts[c]) {
      continue;
    }
    const rowEl = document.createElement("button");
    rowEl.type = "button";
    rowEl.className = "chrom-row";
    if (activeChrom?.kind === "chromosome" && activeChrom.chrom === c) {
      rowEl.classList.add("is-active");
    }
    const name = document.createElement("span");
    name.textContent = CHROM_LABELS[c]!;
    const track = document.createElement("span");
    track.className = "chrom-track";
    const fill = document.createElement("span");
    fill.className = "chrom-fill";
    fill.style.width = `${(total[c]! / max) * 100}%`;
    track.append(fill);
    if (flagged[c]! > 0) {
      const flag = document.createElement("span");
      flag.className = "chrom-flag";
      flag.style.left = `${Math.min(97, (total[c]! / max) * 100)}%`;
      flag.title = `${flagged[c]} pathogenic / likely pathogenic`;
      track.append(flag);
    }
    const n = document.createElement("span");
    n.className = "chrom-n";
    n.textContent = fmt(total[c]!);
    rowEl.append(name, track, n);
    rowEl.title = `Chromosome ${CHROM_LABELS[c]} — ${fmt(total[c]!)} shown, ${flagged[c]} flagged`;
    rowEl.addEventListener("click", () => {
      if (activeChrom?.kind === "chromosome" && activeChrom.chrom === c) {
        removeFilter(activeChrom.id);
      } else {
        addFilter({ chrom: c, kind: "chromosome" });
      }
    });
    map.append(rowEl);
  }
  el.replaceChildren(map);
}

export function renderSeverityLegend(
  container: HTMLElement,
  counts: Record<string, number>
): void {
  const bar = document.createElement("div");
  bar.className = "sev-bar";
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  for (const sig of SEV_ORDER) {
    const n = counts[sig] ?? 0;
    if (!n) {
      continue;
    }
    const seg = document.createElement("span");
    seg.style.width = `${(n / total) * 100}%`;
    seg.style.background = `var(--sev-${sig})`;
    seg.title = `${SIG_LABEL[sig]}: ${fmt(n)}`;
    bar.append(seg);
  }
  container.append(bar);
}

function shortlistItem(row: number): HTMLElement {
  const ds = store.state.dataset!;
  const entry = store.state.shortlist.find((e) => e.row === row)!;
  const ann = store.annotationFor(row);

  const item = document.createElement("div");
  item.className = "shortlist-item";

  const head = document.createElement("div");
  head.className = "sl-head";
  const open = document.createElement("button");
  open.className = "sl-rsid";
  open.type = "button";
  open.title = "Open the details for this variant";
  open.textContent = `${rsLabel(ds.rsNum[row]!)}${ann?.gene ? ` · ${ann.gene}` : ""}`;
  open.addEventListener("click", () => openDetail(row));
  const by = document.createElement("span");
  by.className = entry.addedBy === "agent" ? "sl-by agent" : "sl-by";
  by.textContent = entry.addedBy;
  const remove = document.createElement("button");
  remove.className = "sl-remove";
  remove.type = "button";
  remove.title = "Remove this one from the shortlist";
  remove.setAttribute("aria-label", `Remove ${rsLabel(ds.rsNum[row]!)}`);
  remove.textContent = "✕";
  remove.addEventListener("click", () => removeFromShortlist(row));
  head.append(open, by, remove);

  const status = document.createElement("select");
  status.className = "sl-status";
  status.setAttribute("aria-label", "What to do about this variant");
  for (const s of SHORTLIST_STATUSES) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = STATUS_LABEL[s];
    opt.selected = entry.status === s;
    status.append(opt);
  }
  status.dataset.status = entry.status;
  status.addEventListener("change", () =>
    setShortlistStatus(row, status.value as ShortlistStatus)
  );

  const note = document.createElement("input");
  note.className = "sl-note-input";
  note.type = "text";
  note.value = entry.note;
  note.placeholder = "Add a note…";
  note.setAttribute("aria-label", "Note");
  note.addEventListener("change", () =>
    setShortlistNote(row, note.value.trim())
  );

  item.append(head, status, note);
  return item;
}

let exportForm: HTMLFormElement | null = null;

/**
 * Declarative-API export form. Registered as a WebMCP tool by its presence in
 * the DOM, so it appears and disappears with the shortlist itself. Built once
 * and reused, so a repaint never re-registers the tool mid-conversation.
 */
function createExportForm(): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "export-form";
  form.id = "export-form";
  form.setAttribute("toolname", "act_export_shortlist");
  form.setAttribute(
    "tooldescription",
    "Export the current variant shortlist as a file saved to the user's own disk: CSV or TSV for " +
      "a spreadsheet, or a readable HTML report they can print or take to a clinician. " +
      "The file is generated in the page and never uploaded. Only available while the shortlist has entries."
  );
  form.innerHTML = `
    <div class="export-row">
      <input type="text" name="filename" value="shortlist" aria-label="File name"
             toolparamdescription="Base name for the exported file, without extension." />
      <select name="format" aria-label="Format"
              toolparamdescription="Output format: csv or tsv for a spreadsheet, html for a readable printable report.">
        <option value="csv">CSV</option>
        <option value="tsv">TSV</option>
        <option value="html">Report</option>
      </select>
    </div>
    <div class="export-row">
      <button class="btn btn-sm" type="submit">Export</button>
      <button class="btn btn-sm btn-danger" type="button" id="btn-clear-shortlist">Clear all</button>
    </div>`;
  form
    .querySelector("#btn-clear-shortlist")
    ?.addEventListener("click", () => clearShortlist());
  return form;
}

function shortlistSignature(): string {
  return store.state.shortlist
    .map((e) => `${e.row}:${e.status}:${e.note}:${e.addedBy}`)
    .join("|");
}

let lastShortlistSignature: string | null = null;

export function renderShortlistPanel(): void {
  const el = document.getElementById("shortlist-body");
  const count = document.getElementById("shortlist-count");
  if (!el) {
    return;
  }
  const { shortlist, dataset } = store.state;
  if (count) {
    count.textContent = shortlist.length ? String(shortlist.length) : "";
  }

  if (!dataset || shortlist.length === 0) {
    el.innerHTML =
      '<p class="empty-note">Nothing shortlisted yet. Open a finding and add it, select rows and press S, or ask the agent.</p>';
    lastShortlistSignature = null;
    return;
  }

  const signature = shortlistSignature();
  if (
    signature === lastShortlistSignature &&
    el.querySelector("#export-form")
  ) {
    return;
  }
  lastShortlistSignature = signature;

  const list = document.createElement("div");
  list.className = "shortlist-list";
  for (const entry of shortlist) {
    list.append(shortlistItem(entry.row));
  }

  exportForm ??= createExportForm();
  el.replaceChildren(list, exportForm);
}

export function flashPanel(id: string): void {
  const el = document.getElementById(id);
  if (!el) {
    return;
  }
  // Drop the class, then re-add it on the next frame so the animation
  // restarts cleanly on repeated calls without a forced-reflow hack.
  el.classList.remove("agent-touched");
  requestAnimationFrame(() => el.classList.add("agent-touched"));
}

// Reuse Overview.nextStep so the UI and agent receive the same guidance.
export function renderNextPanel(): void {
  const panel = document.getElementById("panel-next");
  const el = document.getElementById("next-body");
  if (!(panel && el)) {
    return;
  }
  // Guided only. In the advanced table the user is running their own query,
  // and being told what to do next while they do it is noise.
  const inGuided = !!store.state.dataset && store.state.mode === "guided";
  const ov = inGuided ? computeOverview(store.state.guided) : null;
  panel.hidden = !ov;
  if (!ov) {
    return;
  }

  const body = document.createElement("p");
  body.className = "next-text";
  body.textContent = ov.nextStep;

  const actions = document.createElement("div");
  actions.className = "next-actions";

  const advanced = document.createElement("button");
  advanced.className = "btn btn-sm";
  advanced.type = "button";
  advanced.textContent = "Open the full table";
  advanced.addEventListener("click", () => setMode("advanced"));
  actions.append(advanced);

  if (ov.rows.length > 0) {
    const shortlistAll = document.createElement("button");
    shortlistAll.className = "btn btn-sm";
    shortlistAll.type = "button";
    shortlistAll.textContent = `Shortlist all ${ov.rows.length}`;
    shortlistAll.addEventListener("click", () =>
      addToShortlist(ov.rows, "from the guided findings list", "human")
    );
    actions.append(shortlistAll);
  }

  el.replaceChildren(body, actions);
}
