/**
 * The variant detail drawer.
 *
 * Clicking a row used to do nothing but select it. Selection is meaningful to
 * an agent — it is what `read_current_selection` reports — but it answers
 * nothing for the person who clicked. This drawer is the answer: the same
 * explanation `explain_variant` returns to a model, rendered for a human, with
 * the shortlist controls attached so a finding can be captured where it is read.
 */

import {
  addToShortlist,
  closeDetail,
  focusRow,
  removeFromShortlist,
  setMode,
  setShortlistNote,
} from "../actions";
import { explainVariant, type VariantExplanation } from "../analysis";
import { store } from "../store";

const fmt = (n: number) => n.toLocaleString();

function section(
  title: string,
  ...body: (HTMLElement | string)[]
): HTMLElement {
  const el = document.createElement("section");
  el.className = "dr-section";
  const h = document.createElement("h3");
  h.textContent = title;
  el.append(h);
  for (const part of body) {
    if (typeof part === "string") {
      const p = document.createElement("p");
      p.textContent = part;
      el.append(p);
    } else {
      el.append(part);
    }
  }
  return el;
}

function factRow(k: string, v: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "dr-fact";
  const kk = document.createElement("span");
  kk.textContent = k;
  const vv = document.createElement("span");
  vv.textContent = v;
  row.append(kk, vv);
  return row;
}

function facts(x: VariantExplanation): HTMLElement {
  const box = document.createElement("div");
  box.className = "dr-facts";
  box.append(
    factRow("Yours", x.genotype === "--" ? "not read" : x.genotype),
    factRow("Position", `chr ${x.chr}, ${fmt(x.pos)}`)
  );
  if (x.alleles) {
    box.append(factRow("Reference > variant", x.alleles));
  }
  if (x.gene) {
    box.append(factRow("Gene", x.gene));
  }
  if (x.variationId) {
    box.append(factRow("ClinVar variation id", x.variationId));
  }
  return box;
}

function classificationBlock(x: VariantExplanation): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dr-class";
  const chip = document.createElement("span");
  chip.className = "dr-class-chip";
  chip.style.setProperty(
    "--sev",
    x.classification ? `var(--sev-${x.classification})` : "var(--sev-none)"
  );
  chip.textContent = x.classificationLabel;
  const stars = document.createElement("span");
  stars.className = "dr-class-stars";
  stars.textContent = `${"★".repeat(x.stars)}${"☆".repeat(4 - x.stars)}`;
  wrap.append(chip, stars);
  return wrap;
}

function limitations(x: VariantExplanation): HTMLElement {
  const ul = document.createElement("ul");
  ul.className = "dr-limits";
  for (const line of x.limitations) {
    const li = document.createElement("li");
    li.textContent = line;
    ul.append(li);
  }
  return ul;
}

function shortlistBlock(row: number): HTMLElement {
  const box = document.createElement("div");
  box.className = "dr-shortlist";
  const entry = store.state.shortlist.find((e) => e.row === row);

  if (entry) {
    const status = document.createElement("p");
    status.className = "dr-shortlist-on";
    status.textContent = `On your shortlist — added by ${entry.addedBy}.`;
    const note = document.createElement("textarea");
    note.className = "dr-note";
    note.rows = 3;
    note.value = entry.note;
    note.placeholder = "Why does this matter to you? What do you want to ask?";
    note.setAttribute("aria-label", "Note for this shortlisted variant");
    note.addEventListener("change", () =>
      setShortlistNote(row, note.value.trim())
    );
    const remove = document.createElement("button");
    remove.className = "btn btn-sm btn-danger";
    remove.type = "button";
    remove.textContent = "Remove from shortlist";
    remove.addEventListener("click", () => removeFromShortlist(row));
    box.append(status, note, remove);
    return box;
  }

  const note = document.createElement("textarea");
  note.className = "dr-note";
  note.rows = 2;
  note.placeholder = "Optional note — why are you flagging this?";
  note.setAttribute("aria-label", "Note for this variant");
  const add = document.createElement("button");
  add.className = "btn btn-sm btn-primary";
  add.type = "button";
  add.textContent = "Add to shortlist";
  add.addEventListener("click", () =>
    addToShortlist(
      [row],
      note.value.trim() || "flagged from the detail view",
      "human"
    )
  );
  box.append(note, add);
  return box;
}

let shownRow: number | null = null;

export function renderDrawer(): void {
  const el = document.getElementById("drawer");
  const body = document.getElementById("drawer-body");
  const title = document.getElementById("drawer-title-text");
  if (!(el && body && title)) {
    return;
  }
  const row = store.state.detailRow;
  const x = row === null ? null : explainVariant(row);
  el.hidden = x === null;
  if (!x) {
    shownRow = null;
    return;
  }

  title.textContent = x.gene ? `${x.gene} · ${x.rsid}` : x.rsid;
  if (shownRow !== x.row) {
    shownRow = x.row;
    body.scrollTop = 0;
  }

  const parts: HTMLElement[] = [
    section("What this means", classificationBlock(x), x.meaning),
    section("Your genotype here", x.carrierText, facts(x)),
    section("How confident is the evidence?", x.reviewText),
  ];
  if (x.condition) {
    parts.push(section("Condition named in the record", x.condition));
  }
  if (x.whyFlagged) {
    parts.push(section("Why it showed up", x.whyFlagged));
  }
  parts.push(
    section("What this cannot tell you", limitations(x)),
    section("Keep it for follow-up", shortlistBlock(x.row))
  );

  const jump = document.createElement("button");
  jump.className = "btn btn-sm btn-ghost";
  jump.type = "button";
  jump.textContent = "Show this row in the table";
  jump.addEventListener("click", () => {
    setMode("advanced");
    focusRow(x.row);
  });
  parts.push(jump);

  body.replaceChildren(...parts);
}

export function bindDrawer(): void {
  document
    .getElementById("btn-close-drawer")
    ?.addEventListener("click", () => closeDetail());
  document.addEventListener("keydown", (e) => {
    // Escape belongs to whatever is on top. A confirmation card or the
    // keyboard sheet is above the drawer, so neither should take the drawer
    // down with it.
    const overlay =
      document.querySelector(".confirm-layer") !== null ||
      document.getElementById("shortcuts-layer")?.hidden === false;
    if (e.key === "Escape" && !overlay && store.state.detailRow !== null) {
      closeDetail();
    }
  });
}
