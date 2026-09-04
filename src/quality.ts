/**
 * Data-quality assessment and the ClinVar annotation gate.
 *
 * The reason this module exists: the bundled ClinVar subset is GRCh37, and the
 * README used to wave that away with "every consumer-genomics export is on
 * build 37". That is true of chip exports and false of VCFs, which this page
 * also accepts — a GRCh38 VCF is a completely ordinary thing to be handed.
 *
 * What actually breaks across builds, though, is narrower than it first looks.
 * The join in `data/annotations.ts` is keyed on **rs identifier**, and an rsID
 * names a variant, not a coordinate — it is build-independent. So a GRCh38 file
 * with dbSNP identifiers joins correctly; what goes wrong is that the positions
 * shown next to a ClinVar record are then in a different coordinate system to
 * ClinVar's own, and nobody should be reading them as comparable.
 *
 * The gate therefore keys on both facts:
 *
 *   - rsID coverage is what the join actually needs. Below the floor there is
 *     nothing build-independent to match on, and the only remaining option
 *     would be a coordinate join — which across builds is simply wrong.
 *   - a build that is not GRCh37 (or not stated at all) has to clear a much
 *     higher rsID bar before annotation runs, because that is the only
 *     evidence that the join is standing on identifiers rather than luck.
 *
 * Everything here is one pass (plus one typed-array sort) over columns already
 * in memory. No network, by design and by CSP.
 */
import type { Dataset } from "./types";

const MIN_RSID_COVERAGE = 0.05;

/**
 * What a file has to reach before we annotate it against a GRCh37 subset while
 * declaring a different build — or no build at all.
 */
const OFF_BUILD_RSID_COVERAGE = 0.9;

const CLINVAR_BUILD = "GRCh37";

export type BuildConfidence = "high" | "medium" | "low";

export interface DataQuality {
  annotation: {
    clinvarBuild: string;
    /**
     * False when this file's positions and ClinVar's cannot be compared, so
     * neither the UI nor an agent should present one as the other.
     */
    coordinatesComparable: boolean;
    enabled: boolean;
    joinKey: "rsid";
    reason: string;
    rsidCoverage: number;
  };
  annotationSafe: boolean;
  buildConfidence: BuildConfidence;
  calledMarkers: number;
  detectedBuild: string;
  duplicateRsids: number;
  invalidRows: number;
  markers: number;
  noCallRate: number;
  warnings: string[];
}

interface Counts {
  called: number;
  duplicateRsids: number;
  withRsid: number;
}

function scan(ds: Dataset): Counts {
  let called = 0;
  let withRsid = 0;
  for (let i = 0; i < ds.n; i++) {
    if (ds.gt[i] !== 0) {
      called++;
    }
    if (ds.rsNum[i] !== 0) {
      withRsid++;
    }
  }

  // Sort a copy and count adjacent equals: O(n log n) in a typed sort, with no
  // per-row objects and no 250k-entry Set to garbage-collect afterwards.
  const ids = ds.rsNum.slice();
  ids.sort();
  let duplicateRsids = 0;
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] !== 0 && ids[i] === ids[i - 1]) {
      duplicateRsids++;
    }
  }

  return { called, duplicateRsids, withRsid };
}

function confidenceOf(ds: Dataset): BuildConfidence {
  if (ds.buildDeclared) {
    return "high";
  }
  // A consumer chip export never states its build, and every such product has
  // been on 37; that is a strong convention but still an inference.
  return ds.kind === "consumer-tsv" ? "medium" : "low";
}

interface Gate {
  coordinatesComparable: boolean;
  enabled: boolean;
  reason: string;
}

function gate(build: string, coverage: number): Gate {
  const pct = `${(coverage * 100).toFixed(1)}%`;
  const onBuild = build === CLINVAR_BUILD;

  if (coverage < MIN_RSID_COVERAGE) {
    return {
      coordinatesComparable: onBuild,
      enabled: false,
      reason:
        `Only ${pct} of the markers in this file carry an rs identifier. The ClinVar join matches on ` +
        "rsID, so there is nothing here to match on, and matching by coordinate instead would be " +
        "unsound. No clinical annotation has been applied — the file is still parsed and browsable.",
    };
  }

  if (!onBuild && coverage < OFF_BUILD_RSID_COVERAGE) {
    return {
      coordinatesComparable: false,
      enabled: false,
      reason:
        `This file reports build ${build}, while the bundled ClinVar subset is ${CLINVAR_BUILD}, and only ` +
        `${pct} of its markers carry an rs identifier. rsIDs are build-independent, so a fully ` +
        "identified file would still be safe to annotate — this one is not identified enough to " +
        "stand on that alone, so annotation is switched off rather than guessed at.",
    };
  }

  if (onBuild) {
    return {
      coordinatesComparable: true,
      enabled: true,
      reason:
        `Annotated against the bundled ${CLINVAR_BUILD} ClinVar subset by rs identifier, with ${pct} of ` +
        "markers identified. The file and ClinVar are on the same build, so positions are comparable.",
    };
  }

  return {
    coordinatesComparable: false,
    enabled: true,
    reason:
      "Annotated by rs identifier, which names a variant rather than a position and is therefore " +
      `build-independent — ${pct} of markers are identified. Note that this file's coordinates are ` +
      `${build} while ClinVar's are ${CLINVAR_BUILD}: the classifications line up, the positions do not.`,
  };
}

function warningsFor(ds: Dataset, q: Omit<DataQuality, "warnings">): string[] {
  const out: string[] = [];

  if (q.buildConfidence === "low") {
    out.push(
      "This file does not state which reference build it uses, so the build shown is a guess. Check it against whatever produced the file before trusting any coordinate."
    );
  } else if (q.buildConfidence === "medium") {
    out.push(
      `No build is declared in the file. ${q.detectedBuild} is assumed because every consumer genotyping product has used it, which is a convention rather than a statement by this file.`
    );
  }

  if (q.detectedBuild !== CLINVAR_BUILD) {
    out.push(
      `Build mismatch: this file is ${q.detectedBuild} and the bundled ClinVar subset is ${CLINVAR_BUILD}. Positions shown here are not ClinVar's positions and must not be quoted as such.`
    );
  }

  if (!q.annotation.enabled) {
    out.push(
      "Clinical annotation is switched off for this file, so there are no findings to triage. That is a statement about the file, not a clean result."
    );
  }

  if (q.noCallRate > 0.05) {
    out.push(
      `${(q.noCallRate * 100).toFixed(1)}% of markers have no genotype call. A position that was not read has not been ruled out.`
    );
  }

  if (q.duplicateRsids > 0) {
    out.push(
      `${q.duplicateRsids} rows repeat an rs identifier used by another row. Counts per variant may be inflated.`
    );
  }

  if (q.invalidRows > 0) {
    out.push(
      `${q.invalidRows} rows were rejected as malformed during parsing and are absent from every number on this page.`
    );
  }

  if (ds.synthetic) {
    out.push(
      "This file declares itself as synthetic data. Nothing derived from it is a real result."
    );
  }

  return out;
}

/**
 * Assess a freshly parsed dataset. Called before the ClinVar join, because its
 * verdict is what decides whether that join runs at all.
 */
export function assessDataset(ds: Dataset): DataQuality {
  const { called, duplicateRsids, withRsid } = scan(ds);
  const rsidCoverage = ds.n === 0 ? 0 : withRsid / ds.n;
  const detectedBuild = ds.build ?? "unknown";
  const g = gate(detectedBuild, rsidCoverage);

  const base: Omit<DataQuality, "warnings"> = {
    annotation: {
      clinvarBuild: CLINVAR_BUILD,
      coordinatesComparable: g.coordinatesComparable,
      enabled: g.enabled,
      joinKey: "rsid",
      reason: g.reason,
      rsidCoverage: Number(rsidCoverage.toFixed(4)),
    },
    annotationSafe: g.enabled,
    buildConfidence: confidenceOf(ds),
    calledMarkers: called,
    detectedBuild,
    duplicateRsids,
    invalidRows: ds.skipped,
    markers: ds.n,
    noCallRate: ds.n === 0 ? 0 : Number((1 - called / ds.n).toFixed(4)),
  };

  return { ...base, warnings: warningsFor(ds, base) };
}
