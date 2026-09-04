// Source: NCBI ClinVar VCF, GRCh37 (public domain, U.S. Government work).
//   https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh37/clinvar.vcf.gz
// GRCh37 is used because every consumer-genomics raw export is on build 37,
// so rs/position coordinates join directly with no liftover.
// Output is a JS module (not JSON, not a fetchable asset) because the deployed
// page runs under `connect-src 'none'` and therefore cannot fetch anything at
// runtime. A lazily import()ed script chunk is governed by script-src instead.
import {
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

const SRC = "data-build/clinvar_GRCh37.vcf.gz";
const CHIP = "data-build/NA12878.chip.txt";
const OUT = "src/data/clinvar.data.js";

const STARS = new Map([
  ["practice_guideline", 4],
  ["reviewed_by_expert_panel", 3],
  ["criteria_provided,_multiple_submitters,_no_conflicts", 2],
  ["criteria_provided,_conflicting_classifications", 1],
  ["criteria_provided,_conflicting_interpretations", 1],
  ["criteria_provided,_single_submitter", 1],
]);

const SIG = [
  [/^Pathogenic\/Likely_pathogenic|^Pathogenic$/, "P"],
  [/^Likely_pathogenic/, "L"],
  [/^Conflicting/, "C"],
  [/^Uncertain_significance|^Uncertain_risk/, "U"],
  [/^Likely_benign/, "N"],
  [/^Benign\/Likely_benign|^Benign$/, "B"],
];
const SEVERITY = { B: 5, C: 2, L: 1, N: 4, O: 6, P: 0, U: 3 };

// Hoisted: sigCode() runs once per ClinVar record, ~3M times.
const LEADING_UNDERSCORE_RE = /^_/;
const UNDERSCORE_RE = /_/g;
const OTHER_SIG_RE = /drug_response|risk_factor|association|protective/;

function sigCode(clnsig) {
  const s = clnsig.split("|")[0].replace(LEADING_UNDERSCORE_RE, "");
  for (const [re, code] of SIG) {
    if (re.test(s)) {
      return code;
    }
  }
  if (OTHER_SIG_RE.test(clnsig)) {
    return "O";
  }
  return null;
}

function info(line) {
  const out = {};
  for (const kv of line.split(";")) {
    const i = kv.indexOf("=");
    if (i > 0) {
      out[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  return out;
}

const chipRs = new Set();
if (existsSync(CHIP)) {
  for (const l of readFileSync(CHIP, "utf8").split("\n")) {
    if (l.startsWith("rs")) {
      chipRs.add(+l.slice(2, l.indexOf("\t")));
    }
  }
  console.log(`chip markers available for intersection: ${chipRs.size}`);
}

const best = new Map();
let seen = 0,
  kept = 0;

const rl = createInterface({
  crlfDelay: Number.POSITIVE_INFINITY,
  input: createReadStream(SRC).pipe(createGunzip()),
});

for await (const line of rl) {
  if (line.charCodeAt(0) === 35) {
    continue;
  }
  seen++;
  const f = line.split("\t");
  const inf = info(f[7] ?? "");
  if (!inf.RS) {
    continue;
  }
  const code = sigCode(inf.CLNSIG ?? "");
  if (!code) {
    continue;
  }
  const stars = STARS.get((inf.CLNREVSTAT ?? "").trim()) ?? 0;

  for (const rsRaw of inf.RS.split("|")) {
    const rs = +rsRaw;
    if (!Number.isInteger(rs) || rs <= 0) {
      continue;
    }

    // Tier the record by how strongly it earns a place in the bundle. Every
    // byte ships to the browser, so the tier decides what fits (see below).
    const actionable = code === "P" || code === "L";
    let tier;
    if (chipRs.has(rs)) {
      tier = 0;
    } else if (actionable && stars >= 3) {
      tier = 1;
    } else if (actionable && stars >= 2) {
      tier = 2;
    } else if (actionable && stars >= 1) {
      tier = 3;
    } else if (stars >= 3) {
      tier = 4;
    } else {
      continue;
    }

    const gene = (inf.GENEINFO ?? "").split("|")[0]?.split(":")[0] ?? "";
    let condition = decodeURIComponent(
      (inf.CLNDN ?? "").split("|")[0].replace(UNDERSCORE_RE, " ")
    ).slice(0, 80);
    // Never present a ClinVar placeholder as if it were a finding.
    if (condition === "not provided" || condition === "not specified") {
      condition = "";
    }
    const rec = { code, condition, gene, id: f[2] ?? "", rs, stars, tier };

    const prev = best.get(rs);
    if (
      !prev ||
      SEVERITY[code] < SEVERITY[prev.code] ||
      (SEVERITY[code] === SEVERITY[prev.code] && stars > prev.stars)
    ) {
      best.set(rs, rec);
      if (!prev) {
        kept++;
      }
    }
  }
  if (seen % 400_000 === 0) {
    console.log(`  …${seen} records scanned, ${kept} kept`);
  }
}

const all = [...best.values()].sort((a, b) => a.rs - b.rs);

const row = (r) =>
  `${r.rs}\t${r.gene}\t${r.code}\t${r.stars}\t${r.id}\t${r.condition}`;

// Every byte here ships to the browser inside a lazily imported chunk, because
// the deployed page runs under `connect-src 'none'` and cannot fetch data at
// runtime. Pick the widest tier that stays inside the budget.
const BUDGET_BYTES = 5.5e6;
const TIER_LABEL = [
  "on the demo chip",
  "pathogenic, expert panel (3-4 star)",
  "pathogenic, multi-submitter consensus (2 star)",
  "pathogenic, single submitter (1 star)",
  "any classification, expert panel (3-4 star)",
];

let chosen = 0;
let recs = [];
for (let tier = 0; tier < TIER_LABEL.length; tier++) {
  const candidate = all.filter((r) => r.tier <= tier);
  const bytes = candidate.reduce((n, r) => n + row(r).length + 1, 0);
  const fits = bytes <= BUDGET_BYTES;
  console.log(
    `  tier ${tier} (+ ${TIER_LABEL[tier]}): ${candidate.length} records, ` +
      `${(bytes / 1e6).toFixed(2)} MB ${fits ? "" : "-> over budget"}`
  );
  if (!fits) {
    break;
  }
  chosen = tier;
  recs = candidate;
}

const tsv = recs.map(row).join("\n");
const onChip = recs.filter((r) => chipRs.has(r.rs)).length;
const byCode = {};
for (const r of recs) {
  byCode[r.code] = (byCode[r.code] ?? 0) + 1;
}

writeFileSync(
  OUT,
  `// GENERATED by scripts/build-annotations.mjs - do not edit.
// Source: NCBI ClinVar VCF (GRCh37), public domain.
// Records: ${recs.length}, tiers 0-${chosen} (${TIER_LABEL.slice(0, chosen + 1).join("; ")}).
// Columns: rs, gene, sigCode, stars, variationId, condition.
export const CLINVAR_VERSION = ${JSON.stringify(new Date().toISOString().slice(0, 10))}
export const CLINVAR_COUNT = ${recs.length}
export const CLINVAR_TSV = ${JSON.stringify(tsv)}
`
);

console.log(`\nscanned ${seen} ClinVar records`);
console.log(`kept    ${recs.length} unique rs ids through tier ${chosen}`);
console.log(`        ${onChip} of them are genotyped by the demo chip`);
console.log("by significance:", byCode);
console.log(`raw TSV ${(tsv.length / 1e6).toFixed(2)} MB -> ${OUT}`);
