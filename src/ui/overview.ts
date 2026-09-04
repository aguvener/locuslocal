/**
 * Guided mode — the screen a person who is not a geneticist actually needs.
 *
 * Dropping a genome file used to land the user in a 250,000-row table, which
 * answers no question anybody arrives with. This screen answers the six they do
 * arrive with — how much was read, how much is known, what needs a look, how
 * good the evidence is, what they actually carry, and what to do next — and
 * only then offers the table.
 *
 * Every number here comes from src/analysis.ts, the same module behind
 * `explain_findings`. The agent and the human are reading one analysis.
 */

import { addToShortlist, openDetail, setGuidedCriteria } from "../actions";
import { computeOverview, type Overview } from "../analysis";
import { store, zygosityOf } from "../store";
import type { Zygosity } from "../types";
import { CHROM_LABELS, genotypeLabel, rsLabel, SIG_LABEL } from "../types";

const fmt = (n: number) => n.toLocaleString();

const MAX_FINDINGS_SHOWN = 40;
const STRONG_REVIEW_STARS = 2;

function tile(
  label: string,
  value: string,
  note: string,
  tone?: "attention" | "good"
): HTMLElement {
  const el = document.createElement("div");
  el.className = tone ? `ov-tile is-${tone}` : "ov-tile";
  const v = document.createElement("span");
  v.className = "ov-tile-v";
  v.textContent = value;
  const l = document.createElement("span");
  l.className = "ov-tile-l";
  l.textContent = label;
  const n = document.createElement("span");
  n.className = "ov-tile-n";
  n.textContent = note;
  el.append(v, l, n);
  return el;
}

function statGrid(ov: Overview): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "ov-tiles";
  grid.append(
    tile(
      "Markers read",
      fmt(ov.markers),
      "positions your file reports a genotype for"
    ),
    tile(
      "Matched to ClinVar",
      fmt(ov.annotated),
      `${((ov.annotated / Math.max(1, ov.markers)) * 100).toFixed(1)}% of the file has a clinical record`
    ),
    tile(
      "Of those, you carry",
      fmt(ov.carried),
      ov.carrierResolvable
        ? "your genotype is not the reference"
        : `heterozygous calls; ${fmt(ov.unresolved)} more are homozygous`
    ),
    tile(
      "Worth a look",
      fmt(ov.attention),
      ov.criteria.includeUncertain
        ? "pathogenic, likely pathogenic or uncertain"
        : "classified pathogenic or likely pathogenic",
      ov.attention > 0 ? "attention" : "good"
    ),
    tile(
      "Strong review evidence",
      fmt(ov.strongEvidence),
      "two or more submitters agree (2★ or better)",
      ov.strongEvidence > 0 ? "attention" : undefined
    )
  );
  return grid;
}

/**
 * The guided equivalent of the filter stack: the three knobs that actually
 * change what counts as a finding. Same three arguments `explain_findings`
 * takes, so a user and an agent can describe their triage the same way.
 */
function criteriaBar(ov: Overview): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ov-criteria";

  const carried = toggle("only what I carry", ov.criteria.carriedOnly, (on) =>
    setGuidedCriteria({ carriedOnly: on })
  );
  const uncertain = toggle(
    "include uncertain",
    ov.criteria.includeUncertain,
    (on) => setGuidedCriteria({ includeUncertain: on })
  );
  bar.append(carried, uncertain);

  const starsWrap = document.createElement("label");
  starsWrap.className = "ov-select";
  starsWrap.textContent = "review at least ";
  const stars = document.createElement("select");
  stars.setAttribute("aria-label", "Minimum ClinVar review stars");
  for (const n of [0, 1, 2, 3, 4]) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = `${n}★`;
    opt.selected = ov.criteria.minStars === n;
    stars.append(opt);
  }
  stars.addEventListener("change", () =>
    setGuidedCriteria({ minStars: Number(stars.value) })
  );
  starsWrap.append(stars);
  bar.append(starsWrap);
  return bar;
}

function toggle(
  text: string,
  on: boolean,
  onChange: (on: boolean) => void
): HTMLElement {
  const el = document.createElement("button");
  el.className = on ? "ov-toggle is-on" : "ov-toggle";
  el.type = "button";
  el.setAttribute("aria-pressed", String(on));
  el.textContent = text;
  el.addEventListener("click", () => onChange(!on));
  return el;
}

const REVIEW_STARS_MAX = 4;

/**
 * The ClinVar review status, as four segments rather than a `★★☆☆` string.
 *
 * At 11px the glyph pair is two shades of the same grey speck, which is not a
 * reading of anything. Separate elements let the earned segments carry the
 * foreground colour and the rest stay hairlines, and put the count somewhere a
 * screen reader can reach — the old `title` sat under a `pointer-events: none`
 * head, so it could never open at all.
 */
function reviewMeter(stars: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className =
    stars >= STRONG_REVIEW_STARS ? "ov-review is-strong" : "ov-review";

  const meter = document.createElement("span");
  meter.className = "ov-stars";
  meter.setAttribute("role", "img");
  meter.setAttribute(
    "aria-label",
    `Review status: ${stars} of ${REVIEW_STARS_MAX} stars`
  );
  for (let i = 0; i < REVIEW_STARS_MAX; i++) {
    const seg = document.createElement("i");
    if (i < stars) {
      seg.className = "is-on";
    }
    meter.append(seg);
  }

  // Four anonymous dashes are not a reading. The count carries the same
  // vocabulary the tiles and the criteria bar already use — "2★ or better",
  // "review at least 1★" — so the card is saying it in the reader's units.
  const count = document.createElement("span");
  count.className = "ov-review-n";
  count.setAttribute("aria-hidden", "true");
  count.textContent = `${stars}★`;

  wrap.append(meter, count);
  return wrap;
}

function shortlistButton(row: number): HTMLButtonElement {
  const already = store.state.shortlist.some((entry) => entry.row === row);
  const btn = document.createElement("button");
  btn.className = already ? "ov-add is-added" : "ov-add";
  btn.type = "button";
  // A lime `+` at reduced opacity read as "still addable". A star reads as
  // "kept", which is what the state actually is.
  btn.textContent = already ? "★" : "+";
  btn.disabled = already;
  const label = already ? "Already on your shortlist" : "Add to shortlist";
  btn.setAttribute("aria-label", label);
  btn.dataset.tooltip = label;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    addToShortlist([row], "flagged from the guided summary", "human");
  });
  return btn;
}

function findingCard(row: number): HTMLElement {
  const ds = store.state.dataset!;
  const ann = store.annotationFor(row)!;
  const card = document.createElement("article");
  card.className = "ov-finding";
  // Colour is data. Without this every card on the screen a person opens to
  // ask "how bad is this?" was the same grey as every other one.
  card.style.setProperty("--sev", `var(--sev-${ann.significance})`);

  const open = document.createElement("button");
  open.className = "ov-finding-open";
  open.type = "button";

  const head = document.createElement("div");
  head.className = "ov-finding-head";
  const name = document.createElement("span");
  name.className = "ov-finding-name";
  name.textContent = ann.gene
    ? `${ann.gene} · ${rsLabel(ds.rsNum[row]!)}`
    : rsLabel(ds.rsNum[row]!);
  head.append(name, shortlistButton(row));

  // How serious, and how sure — the two questions the card exists to answer,
  // on one line. The classification was not written anywhere on the card at
  // all before, only implied by the order the list happened to be in.
  const meta = document.createElement("div");
  meta.className = "ov-finding-meta";
  const chip = document.createElement("span");
  chip.className = "sev-chip";
  chip.textContent = SIG_LABEL[ann.significance];
  meta.append(chip, reviewMeter(ann.stars));

  const cond = document.createElement("p");
  cond.className = "ov-finding-cond";
  cond.textContent =
    ann.condition || "No condition named in the ClinVar record";

  const facts = document.createElement("p");
  facts.className = "ov-finding-facts";
  facts.textContent = `Yours ${genotypeLabel(ds, row)} · ${zygosityWord(row)} · chr ${CHROM_LABELS[ds.chrom[row]!]}, pos ${fmt(ds.pos[row]!)}`;

  const cardLabel = name.textContent ?? rsLabel(ds.rsNum[row]!);
  open.setAttribute("aria-label", `Open details for ${cardLabel}`);
  open.addEventListener("click", () => openDetail(row));

  card.append(open, head, meta, cond, facts);
  return card;
}

const ZYG_WORD: Record<Zygosity, string> = {
  het: "one copy",
  // Not "two copies": the file says the same base twice and never says which
  // base is the reference, so this is not evidence of two copies of anything
  // in particular.
  hom: "two identical calls, reference allele not recorded",
  hom_alt: "two copies",
  hom_ref: "reference at this position",
  no_call: "not read in this file",
  unknown: "cannot be determined from this file",
};

function zygosityWord(row: number): string {
  const ds = store.state.dataset!;
  return ZYG_WORD[zygosityOf(ds, row)];
}

export function renderOverview(): void {
  const el = document.getElementById("overview");
  if (!el) {
    return;
  }
  const inGuided =
    store.state.mode === "guided" && store.state.dataset !== null;
  el.hidden = !inGuided;
  if (!inGuided) {
    return;
  }

  const ov = computeOverview(store.state.guided);
  if (!ov) {
    return;
  }

  const ds = store.state.dataset!;
  const header = document.createElement("header");
  header.className = "ov-head";
  const h1 = document.createElement("h1");
  h1.textContent = "Here is what is in your file";
  const sub = document.createElement("p");
  sub.textContent = `${ds.sourceName} — read, annotated and triaged inside this browser tab.`;
  header.append(h1, sub);

  const findings = document.createElement("section");
  findings.className = "ov-findings";
  const fh = document.createElement("div");
  fh.className = "ov-findings-head";
  const ft = document.createElement("h2");
  ft.textContent =
    ov.attention === 0
      ? "No findings under these criteria"
      : `${ov.attention} finding${ov.attention === 1 ? "" : "s"} to look at`;
  fh.append(ft, criteriaBar(ov));
  findings.append(fh);

  if (ov.attention === 0) {
    const none = document.createElement("p");
    none.className = "ov-none";
    none.textContent =
      "Nothing in this file matches the criteria above. Loosen them — include uncertain variants, or drop the review bar — to see what sits just below the line. Remember that a genotype chip reads a small fixed slice of the genome, so an empty list is not a clean bill of health.";
    findings.append(none);
  } else {
    const list = document.createElement("div");
    list.className = "ov-finding-list";
    for (const row of ov.rows.slice(0, MAX_FINDINGS_SHOWN)) {
      list.append(findingCard(row));
    }
    findings.append(list);
    if (ov.rows.length > MAX_FINDINGS_SHOWN) {
      const more = document.createElement("p");
      more.className = "ov-none";
      more.textContent = `Showing the ${MAX_FINDINGS_SHOWN} most severe. The full list is in the advanced table.`;
      findings.append(more);
    }
  }

  const caveat = document.createElement("p");
  caveat.className = "ov-caveat";
  caveat.textContent =
    "This is not a diagnosis and not medical advice. ClinVar classifications describe variants, not people; a consumer genotype file is not a diagnostic test. Take anything that worries you to a clinician or a genetic counsellor.";

  el.replaceChildren(header, statGrid(ov), findings, caveat);
}
