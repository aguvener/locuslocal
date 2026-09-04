/**
 * The readable shortlist report.
 *
 * A CSV is what you hand to a spreadsheet. This is what you hand to a person:
 * a self-contained HTML page, generated in the tab, that states what was
 * analysed, what was flagged, what the user decided about each finding, and
 * what the analysis cannot tell anybody. Open it and print to PDF.
 *
 * It is built as a Blob and saved to the user's own disk. Like every other
 * output here it never touches the network, and under the deployed CSP it could
 * not if it tried.
 */
import { computeOverview, explainVariant } from "../analysis";
import { clinvarVersion } from "../data/annotations";
import { STATUS_LABEL, store } from "../store";
import { CHROM_LABELS, genotypeLabel, rsLabel } from "../types";

const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const QUOT_RE = /"/g;

function esc(s: string): string {
  return s
    .replace(AMP_RE, "&amp;")
    .replace(LT_RE, "&lt;")
    .replace(GT_RE, "&gt;")
    .replace(QUOT_RE, "&quot;");
}

const REPORT_CSS = `
  :root { color-scheme: light; }
  body { font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
         color: #16191d; background: #fff; margin: 0; padding: 40px 32px; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 32px 0 10px; padding-bottom: 6px;
       border-bottom: 1px solid #d8dce2; }
  .sub { color: #5c6570; margin: 0 0 24px; }
  .meta { display: grid; grid-template-columns: 180px 1fr; gap: 4px 16px;
          font-size: 13px; margin: 0; }
  .meta dt { color: #5c6570; }
  .meta dd { margin: 0; }
  .stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 0; padding: 0; list-style: none; }
  .stats li { border: 1px solid #d8dce2; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
  .stats b { display: block; font-size: 20px; font-weight: 600; }
  .stats span { color: #5c6570; font-size: 12px; }
  .entry { border: 1px solid #d8dce2; border-radius: 8px; padding: 14px 16px;
           margin: 0 0 12px; break-inside: avoid; }
  .entry-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .entry-head strong { font-size: 15px; }
  .tag { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
         border: 1px solid #c3c9d1; border-radius: 999px; padding: 2px 8px; color: #4a525c; }
  .entry p { margin: 8px 0 0; }
  .entry .facts { color: #5c6570; font-size: 13px; font-variant-numeric: tabular-nums; }
  .note { background: #f5f6f8; border-left: 3px solid #9aa3ad; padding: 8px 12px;
          margin-top: 10px; border-radius: 0 4px 4px 0; }
  .limits { color: #4a525c; font-size: 13px; }
  footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid #d8dce2;
           color: #5c6570; font-size: 12px; }
  @media print { body { padding: 0; } .entry { break-inside: avoid; } }
`;

const LIMITATIONS = [
  "This is not a diagnosis, not a clinical report and not medical advice. No clinician has reviewed it.",
  "A consumer genotype file reads a small, fixed set of positions. A variant missing from this report has not been ruled out — it was never tested for.",
  "ClinVar classifications describe variants, not people. Whether a variant affects a particular person depends on inheritance pattern, penetrance, family history and other genes.",
  "ClinVar is a snapshot of submitted evidence and is revised over time. This report used a copy bundled with the page, not a live lookup.",
  "Anything here that concerns you should be taken to a clinician or a genetic counsellor, who can order a validated diagnostic test.",
];

export function buildReportHtml(): string {
  const ds = store.state.dataset;
  if (!ds) {
    return "";
  }
  const ov = computeOverview(store.state.guided);
  const generated = new Date().toLocaleString();

  const entries = store.state.shortlist
    .map((entry) => {
      const x = explainVariant(entry.row);
      if (!x) {
        return "";
      }
      return `
      <article class="entry">
        <div class="entry-head">
          <strong>${esc(x.gene ? `${x.gene} · ${x.rsid}` : x.rsid)}</strong>
          <span class="tag">${esc(x.classificationLabel)}</span>
          <span class="tag">${x.stars}★ review</span>
          <span class="tag">${esc(STATUS_LABEL[entry.status])}</span>
          <span class="tag">flagged by ${esc(entry.addedBy)}</span>
        </div>
        <p class="facts">Genotype ${esc(genotypeLabel(ds, entry.row))} · ${esc(x.carrierText)}</p>
        <p class="facts">Chromosome ${esc(x.chr)}, position ${ds.pos[entry.row]!.toLocaleString()}${
          x.variationId ? ` · ClinVar variation ${esc(x.variationId)}` : ""
        }</p>
        ${x.condition ? `<p><b>Condition in the record:</b> ${esc(x.condition)}</p>` : ""}
        <p>${esc(x.meaning)}</p>
        <p class="facts">Evidence: ${esc(x.reviewText)}</p>
        ${entry.note ? `<p class="note"><b>Your note:</b> ${esc(entry.note)}</p>` : ""}
      </article>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1" name="viewport">
<title>Variant shortlist — ${esc(ds.sourceName)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
  <h1>Variant shortlist</h1>
  <p class="sub">Generated ${esc(generated)} by LocusLocal, entirely inside a browser tab. This file was produced on your own device and has not been uploaded anywhere.</p>

  <h2>What was analysed</h2>
  <dl class="meta">
    <dt>Source file</dt><dd>${esc(ds.sourceName)}</dd>
    <dt>File type</dt><dd>${ds.kind === "vcf" ? "VCF" : "consumer genotype export"}</dd>
    <dt>Reference build</dt><dd>${esc(ds.build ?? "unknown")}</dd>
    <dt>Markers read</dt><dd>${ds.n.toLocaleString()}</dd>
    <dt>Annotation source</dt><dd>NCBI ClinVar${clinvarVersion ? ` (${esc(clinvarVersion)})` : ""}, bundled locally</dd>
  </dl>

  <h2>Summary</h2>
  <ul class="stats">
    <li><b>${(ov?.annotated ?? 0).toLocaleString()}</b><span>matched to ClinVar</span></li>
    <li><b>${(ov?.carried ?? 0).toLocaleString()}</b><span>of those, carried</span></li>
    ${ov && !ov.carrierResolvable ? `<li><b>${ov.unresolved.toLocaleString()}</b><span>homozygous, reference allele not recorded by this file</span></li>` : ""}
    <li><b>${(ov?.attention ?? 0).toLocaleString()}</b><span>worth a look</span></li>
    <li><b>${(ov?.strongEvidence ?? 0).toLocaleString()}</b><span>2★ or better</span></li>
    <li><b>${store.state.shortlist.length.toLocaleString()}</b><span>on this shortlist</span></li>
  </ul>

  <h2>Shortlisted variants</h2>
  ${entries || "<p>Nothing was shortlisted.</p>"}

  <h2>What this report cannot tell you</h2>
  <ul class="limits">${LIMITATIONS.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>

  <footer>
    LocusLocal — browser-local variant triage. The genotype file was parsed, annotated
    and triaged in the browser; the page that produced this report is served with a
    Content-Security-Policy of <code>connect-src 'none'</code>, so it is incapable of
    transmitting anything.
  </footer>
</main>
</body>
</html>`;
}

export function shortlistRow(row: number): string[] {
  const ds = store.state.dataset!;
  const entry = store.state.shortlist.find((e) => e.row === row)!;
  const ann = store.annotationFor(row);
  return [
    rsLabel(ds.rsNum[row]!),
    CHROM_LABELS[ds.chrom[row]!] ?? "?",
    String(ds.pos[row]!),
    genotypeLabel(ds, row),
    ann?.gene ?? "",
    ann?.significance ?? "",
    String(ann?.stars ?? ""),
    ann?.condition ?? "",
    entry.status,
    entry.addedBy,
    entry.note,
  ];
}
