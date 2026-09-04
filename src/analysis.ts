/**
 * The analysis engine, shared by the UI and the WebMCP tools.
 *
 * This module exists because of a product rule: an agent must never be able to
 * compute something the human cannot see, and the human must never see a number
 * the agent cannot read back. `explain_findings` and the guided summary screen
 * therefore call exactly the same functions — the tool layer serialises the
 * result as JSON, the UI renders it as cards, and neither owns the analysis.
 *
 * Everything here is a local join over typed arrays. No network, by design and
 * by CSP.
 */
import { mayCarry, store, zygosityOf } from "./store";
import type { Dataset, FindingCriteria, Significance } from "./types";
import {
  CHROM_LABELS,
  DEFAULT_CRITERIA,
  genotypeLabel,
  rsLabel,
  SIG_LABEL,
  SIG_RANK,
} from "./types";

const STRONG_REVIEW_STARS = 2;

const ATTENTION_SIGS: Significance[] = ["pathogenic", "likely_pathogenic"];

/**
 * What can honestly be said about carriage at one row.
 *
 * `unresolved` is not a hedge — it is the true answer for a homozygous call in
 * a file that never records the reference allele. Treating it as "carried"
 * told users they had two copies of a pathogenic variant at markers where they
 * had two copies of the reference.
 */
export type CarrierState =
  | "carried"
  | "not_carried"
  | "not_read"
  | "unresolved";

export function carrierState(ds: Dataset, row: number): CarrierState {
  const z = zygosityOf(ds, row);
  if (z === "no_call") {
    return "not_read";
  }
  if (z === "hom_ref") {
    return "not_carried";
  }
  if (z === "hom" || z === "unknown") {
    return "unresolved";
  }
  return "carried";
}

/**
 * The predicate the `carriedOnly` criterion uses. Deliberately inclusive of
 * `unresolved`: dropping those would hide real homozygous pathogenic findings,
 * which is the more dangerous of the two errors. Every surface that shows one
 * says it is unresolved rather than claiming carriage.
 */
export function mayBeCarried(ds: Dataset, row: number): boolean {
  return mayCarry(zygosityOf(ds, row));
}

export function annotatedRows(pred?: (row: number) => boolean): number[] {
  const ds = store.state.dataset;
  if (!ds) {
    return [];
  }
  const out: number[] = [];
  for (let i = 0; i < ds.n; i++) {
    if (ds.annIdx[i]! < 0) {
      continue;
    }
    if (pred && !pred(i)) {
      continue;
    }
    out.push(i);
  }
  out.sort((a, b) => {
    const ra = SIG_RANK[store.annotationFor(a)!.significance];
    const rb = SIG_RANK[store.annotationFor(b)!.significance];
    return (
      ra - rb || store.annotationFor(b)!.stars - store.annotationFor(a)!.stars
    );
  });
  return out;
}

export function findingRows(criteria: FindingCriteria): number[] {
  const ds = store.state.dataset;
  if (!ds) {
    return [];
  }
  const wanted = new Set<string>(
    criteria.includeUncertain
      ? [...ATTENTION_SIGS, "uncertain"]
      : ATTENTION_SIGS
  );
  return annotatedRows((r) => {
    const a = store.annotationFor(r)!;
    if (!wanted.has(a.significance) || a.stars < criteria.minStars) {
      return false;
    }
    return criteria.carriedOnly ? mayBeCarried(ds, r) : true;
  });
}

export interface Overview {
  annotated: number;
  attention: number;
  carried: number;
  /**
   * True only when the source file records a reference allele, i.e. a VCF.
   * When false, `carried` counts what is certain and `unresolved` counts what
   * the file cannot decide — the UI and the tools must report both.
   */
  carrierResolvable: boolean;
  criteria: FindingCriteria;
  genes: { gene: string; n: number }[];
  markers: number;
  nextStep: string;
  rows: number[];
  significance: Record<string, number>;
  strongEvidence: number;
  uncertain: number;
  unresolved: number;
}

export function computeOverview(
  criteria: FindingCriteria = DEFAULT_CRITERIA
): Overview | null {
  const ds = store.state.dataset;
  if (!ds) {
    return null;
  }

  let annotated = 0;
  let carried = 0;
  let unresolved = 0;
  let uncertain = 0;
  const significance: Record<string, number> = {};
  for (let r = 0; r < ds.n; r++) {
    if (ds.annIdx[r]! < 0) {
      continue;
    }
    annotated++;
    const sig = store.annotationFor(r)!.significance;
    significance[sig] = (significance[sig] ?? 0) + 1;
    const state = carrierState(ds, r);
    if (state === "carried") {
      carried++;
    } else if (state === "unresolved") {
      unresolved++;
    }
    if (state !== "carried" && state !== "unresolved") {
      continue;
    }
    if (sig === "uncertain") {
      uncertain++;
    }
  }

  const rows = findingRows(criteria);
  let strongEvidence = 0;
  const geneCounts = new Map<string, number>();
  for (const r of rows) {
    const ann = store.annotationFor(r)!;
    if (ann.stars >= STRONG_REVIEW_STARS) {
      strongEvidence++;
    }
    if (ann.gene) {
      geneCounts.set(ann.gene, (geneCounts.get(ann.gene) ?? 0) + 1);
    }
  }

  return {
    annotated,
    attention: rows.length,
    carried,
    carrierResolvable: ds.kind === "vcf",
    criteria,
    genes: [...geneCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([gene, n]) => ({ gene, n })),
    markers: ds.n,
    nextStep: nextStepFor(rows.length, strongEvidence, annotated),
    rows,
    significance,
    strongEvidence,
    uncertain,
    unresolved,
  };
}

function nextStepFor(
  attention: number,
  strong: number,
  annotated: number
): string {
  if (annotated === 0) {
    return "None of the markers in this file appear in the bundled ClinVar subset, so there is nothing to triage. That usually means the file covers a different set of positions, not that it is clean.";
  }
  if (attention === 0) {
    return "Nothing in this file meets the review bar for a flagged finding. That is the common result, and it is not a clean bill of health — a genotype chip reads only a small, fixed slice of the genome.";
  }
  if (strong === 0) {
    return `Open the ${attention} finding${attention === 1 ? "" : "s"} below and read the review level on each. All of them rest on a single submitter, which is the weakest tier of evidence in ClinVar.`;
  }
  return `Start with the ${strong} finding${strong === 1 ? "" : "s"} that ${strong === 1 ? "has" : "have"} two or more agreeing submitters. Shortlist anything you want to raise with a clinician, add a note about why, then export the shortlist and take it to them.`;
}

export interface VariantExplanation {
  alleles: string | null;
  carrierState: CarrierState;
  carrierText: string;
  chr: string;
  classification: Significance | null;
  classificationLabel: string;
  condition: string | null;
  gene: string | null;
  genotype: string;
  limitations: string[];
  meaning: string;
  pos: number;
  reviewText: string;
  row: number;
  rsid: string;
  stars: number;
  variationId: string | null;
  whyFlagged: string | null;
  zygosity: string;
}

const CARRIER_TEXT: Record<string, string> = {
  het: "One copy. You carry this variant on one of your two chromosomes; the other copy reads as reference.",
  hom: "Two identical copies — but of what, this file cannot say. It reports the same base twice here and never records the reference allele, so whether that means two copies of the variant or two copies of the reference is not something a consumer chip export contains.",
  hom_alt:
    "Two copies. Both of your chromosomes carry this variant at this position.",
  hom_ref:
    "No copies. Your genotype at this position matches the reference sequence.",
  no_call:
    "Not read. This file has no genotype call at this position, so nothing can be said about it either way.",
  unknown:
    "Cannot be determined. This file does not record which allele is the reference here.",
};

const MEANING: Record<Significance, string> = {
  benign:
    "ClinVar's submitters classify this variant as harmless. It is a normal piece of human variation.",
  conflicting:
    "Submitters disagree about this variant: some have classified it as disease-causing and others as harmless. A disagreement is not a diagnosis, and it is not a clean result either — it means the evidence is genuinely unsettled.",
  likely_benign:
    "ClinVar's submitters consider this variant probably harmless, with somewhat less evidence than a full benign call.",
  likely_pathogenic:
    "ClinVar's submitters consider this variant probably disease-causing, with less supporting evidence than a full pathogenic call.",
  other:
    "ClinVar holds a record for this variant that does not fit the standard classification scale.",
  pathogenic:
    "ClinVar's submitters classify this variant as disease-causing for the condition named below. That is a statement about the variant, not about you: whether it affects a particular person depends on the condition's inheritance pattern, on their other genes, and on things a genotype file cannot see.",
  uncertain:
    "There is not enough published evidence to say whether this variant causes disease. Most variants of uncertain significance are eventually reclassified as harmless.",
};

const REVIEW_TEXT = [
  "No assertion criteria — the weakest tier of evidence in ClinVar. Treat it as a lead, not a result.",
  "One submitter, with stated assertion criteria. A single laboratory's judgement.",
  "Two or more submitters agree, with no conflicts. This is the usual bar for taking a classification seriously.",
  "Reviewed by an expert panel.",
  "Backed by a practice guideline — the strongest tier in ClinVar.",
];

function limitationsFor(ds: Dataset, hasAnnotation: boolean): string[] {
  const out = [
    "A genotype file is not a diagnostic test. Nothing here has been clinically validated, and no clinician has looked at it.",
    "This file reads a small, fixed set of positions. A variant that is absent from it has not been ruled out — it was never looked for.",
  ];
  if (hasAnnotation) {
    out.push(
      "ClinVar classifications are a snapshot of submitted evidence and change over time. This page uses a bundled copy, not a live lookup.",
      "A classification describes the variant, not the person carrying it. Penetrance, inheritance pattern and family history all sit outside what this file can show."
    );
  }
  if (ds.kind !== "vcf") {
    out.push(
      "This is a consumer chip export, which does not record the reference allele. Zygosity here means homozygous or heterozygous at the position — not necessarily two copies of the variant ClinVar describes."
    );
  }
  return out;
}

function whyFlaggedText(
  sig: Significance,
  stars: number,
  carrier: CarrierState
): string {
  const label = SIG_LABEL[sig].toLowerCase();
  if (carrier === "carried") {
    return `Flagged because ClinVar classifies it as ${label} at ${stars}\u2605 review, and your genotype at this position is not the reference.`;
  }
  if (carrier === "unresolved") {
    return `Flagged because ClinVar classifies it as ${label} at ${stars}\u2605 review, and this file cannot rule you out: your call here is homozygous, but the file does not record the reference allele, so whether you carry the variant is undetermined.`;
  }
  if (carrier === "not_read") {
    return `ClinVar classifies it as ${label}, but this file has no genotype call at this position, so nothing here says whether you carry it.`;
  }
  return `ClinVar classifies it as ${label}, but your genotype here reads as reference, so it is not counted as one of your findings.`;
}

export function explainVariant(row: number): VariantExplanation | null {
  const ds = store.state.dataset;
  if (!ds || row < 0 || row >= ds.n) {
    return null;
  }
  const ann = store.annotationFor(row);
  const zyg = zygosityOf(ds, row);
  const carrier = carrierState(ds, row);

  let whyFlagged: string | null = null;
  if (ann && ATTENTION_SIGS.includes(ann.significance)) {
    whyFlagged = whyFlaggedText(ann.significance, ann.stars, carrier);
  } else if (ann?.significance === "uncertain" && carrier !== "not_carried") {
    whyFlagged =
      "Shown only when uncertain variants are included: ClinVar cannot yet classify this one either way.";
  }

  return {
    alleles: ds.alleles?.[row] ?? null,
    carrierState: carrier,
    carrierText: CARRIER_TEXT[zyg] ?? CARRIER_TEXT.unknown!,
    chr: CHROM_LABELS[ds.chrom[row]!] ?? "?",
    classification: ann?.significance ?? null,
    classificationLabel: ann
      ? SIG_LABEL[ann.significance]
      : "No ClinVar record",
    condition: ann?.condition || null,
    gene: ann?.gene || null,
    genotype: genotypeLabel(ds, row),
    limitations: limitationsFor(ds, !!ann),
    meaning: ann
      ? MEANING[ann.significance]
      : "This marker is not in the bundled ClinVar subset, so there is no clinical classification to report. The overwhelming majority of markers on a genotype chip are in this position — it means nothing has been submitted about it, not that it is harmless.",
    pos: ds.pos[row]!,
    reviewText: ann
      ? (REVIEW_TEXT[ann.stars] ?? REVIEW_TEXT[0]!)
      : "Not applicable — no ClinVar record.",
    row,
    rsid: rsLabel(ds.rsNum[row]!),
    stars: ann?.stars ?? 0,
    variationId: ann?.variationId || null,
    whyFlagged,
    zygosity: zyg,
  };
}
