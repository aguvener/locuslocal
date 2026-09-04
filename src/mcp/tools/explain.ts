/**
 * Layer 4 — explain_*  (analysis over local data)
 *
 * These do the actual analytical work, joining the user's genotypes against the
 * bundled ClinVar subset entirely in this tab. They are the reason the product
 * exists: the same analysis performed by any hosted service would require
 * uploading the genome first.
 *
 * They are read-only but marked untrustedContent, because their output contains
 * text from a file the user supplied. Per Chrome's secure-tools guidance, an
 * agent must treat that text as data and never as instructions.
 */
import {
  annotatedRows,
  computeOverview,
  explainVariant,
  findingRows,
} from "../../analysis";
import { store } from "../../store";
import { CHROM_LABELS, genotypeLabel, rsLabel } from "../../types";
import type { ToolSpec } from "../registry";
import {
  requireDataset,
  resolveRow,
  serialiseRow,
  serialiseRows,
  significanceBreakdown,
  topGenes,
  zygosityBreakdown,
} from "./shared";

export const explainTools: ToolSpec[] = [
  {
    description:
      "Return everything known locally about one marker: the user's genotype and zygosity, its position, " +
      "and the bundled ClinVar record if there is one (gene, classification, condition, review-status " +
      "stars, variation id). Accepts either a stable row id or an rs identifier. Reads state only. " +
      "This is a local database join, not a lookup against any external service.",
    layer: "explain",
    name: "explain_variant",
    readOnly: true,
    run: (args) => {
      const ds = requireDataset();
      const row = resolveRow(ds, args);
      if (row < 0) {
        return {
          found: false,
          note: "That marker is not present in the loaded dataset. Consumer genotype chips only cover a few hundred thousand of the genome’s variants.",
          rsid: args.rsid,
        };
      }

      const ann = store.annotationFor(row);
      // The same explanation the page renders in its detail drawer, so the
      // agent and the human are reading one text rather than two.
      const plain = explainVariant(row)!;
      return {
        found: true,
        ...serialiseRow(row),
        caveat:
          "Carrying a genotype is not a diagnosis. ClinVar classifications describe variants, not people, and this workbench performs no clinical interpretation.",
        interpretation: ann
          ? {
              classification: ann.significance,
              clinvarVariationId: ann.variationId,
              condition: ann.condition || null,
              gene: ann.gene || null,
              reviewStars: ann.stars,
              source: "NCBI ClinVar, bundled locally",
            }
          : null,
        plainLanguage: {
          carrierStatus: plain.carrierText,
          limitations: plain.limitations,
          meaning: plain.meaning,
          reviewConfidence: plain.reviewText,
          shownInUiAs: "the variant detail drawer",
          whyItWasFlagged: plain.whyFlagged,
        },
      };
    },
    schema: {
      properties: {
        id: {
          description: "Stable row id from any other tool.",
          minimum: 0,
          type: "integer",
        },
        rsid: {
          description: "rs identifier, e.g. rs334.",
          maxLength: 24,
          type: "string",
        },
      },
      required: [],
      type: "object",
    },
    untrustedContent: true,
  },

  {
    description:
      "Return every marker in the loaded dataset that falls in a named gene, joined against the local " +
      "ClinVar subset, with the user's genotype for each and a breakdown of classifications. Use this " +
      "when the user asks about a specific gene. Reads state only.",
    layer: "explain",
    name: "explain_gene",
    readOnly: true,
    run: (args) => {
      requireDataset();
      const gene = String(args.gene).trim().toUpperCase();
      // Uppercased on both sides: HGNC symbols such as C9orf72 are mixed case,
      // and comparing an uppercased query against the stored symbol reported
      // every one of them as an unknown gene.
      const rows = annotatedRows(
        (r) => store.annotationFor(r)?.gene.toUpperCase() === gene
      );
      if (rows.length === 0) {
        const known = store.state.annotations?.byGene.has(gene);
        return {
          gene,
          markersInDataset: 0,
          note: known
            ? `ClinVar knows ${gene}, but this dataset genotypes none of its annotated variants. That is normal for a consumer chip, which samples the genome sparsely.`
            : `No gene named ${gene} appears in the bundled ClinVar subset. Check the symbol.`,
        };
      }
      return {
        gene,
        markersInDataset: rows.length,
        significance: significanceBreakdown(rows),
        zygosity: zygosityBreakdown(rows),
        ...serialiseRows(rows),
      };
    },
    schema: {
      properties: {
        gene: {
          description: "HGNC gene symbol, e.g. BRCA2.",
          maxLength: 32,
          type: "string",
        },
      },
      required: ["gene"],
      type: "object",
    },
    untrustedContent: true,
  },

  {
    description:
      "Triage the whole dataset: return the markers where the user carries a non-reference genotype at " +
      "a variant ClinVar classifies as pathogenic or likely pathogenic, most severe first, filtered by " +
      'review quality. This is the "what should I look at" tool. Reads state only; it changes nothing, ' +
      "so follow it with set_filter if you want the user to see these rows in the table.",
    layer: "explain",
    name: "explain_findings",
    readOnly: true,
    run: (args) => {
      requireDataset();
      const criteria = {
        carriedOnly: args.carriedOnly !== false,
        includeUncertain: args.includeUncertain === true,
        minStars: (args.minStars as number | undefined) ?? 1,
      };
      const rows = findingRows(criteria);
      return {
        criteria,
        findings: rows.length,
        genes: topGenes(rows, 15),
        significance: significanceBreakdown(rows),
        ...serialiseRows(rows),
        caveat:
          "A consumer genotype chip is not a diagnostic test. Presence of a classified variant is not a diagnosis and this list is not medical advice.",
        note: "These are the same rows the guided summary screen lists. Call set_view_mode with mode 'guided' to put them in front of the user, optionally passing the same criteria.",
      };
    },
    schema: {
      properties: {
        carriedOnly: {
          description:
            "Only markers where the user actually carries the non-reference allele. Default true.",
          type: "boolean",
        },
        includeUncertain: {
          description: "Also include variants of uncertain significance.",
          type: "boolean",
        },
        minStars: {
          description:
            "Minimum ClinVar review-status stars. Default 1; use 2 for multi-submitter consensus only.",
          maximum: 4,
          minimum: 0,
          type: "integer",
        },
      },
      required: [],
      type: "object",
    },
    untrustedContent: true,
  },

  {
    description:
      'Compute and compare summary statistics for two groups of markers, so you can answer "how do these ' +
      'differ?". Each group is either the rows the user has selected by hand, the rows currently visible, ' +
      "the whole dataset, an explicit list of row ids, or every marker in one gene. Reads state only.",
    layer: "explain",
    name: "compare_groups",
    readOnly: true,
    run: (args) => {
      const ds = requireDataset();
      const resolve = (which: "A" | "B"): { label: string; rows: number[] } => {
        const kind = args[which === "A" ? "groupA" : "groupB"] as string;
        switch (kind) {
          case "selection":
            return {
              label: "manual selection",
              rows: [...store.state.selection],
            };
          case "visible": {
            const { start, end } = store.state.viewport;
            return {
              label: "visible rows",
              rows: [...store.state.view.subarray(start, end)],
            };
          }
          case "shortlist":
            return {
              label: "shortlist",
              rows: store.state.shortlist.map((e) => e.row),
            };
          case "dataset": {
            const rows: number[] = [];
            for (let i = 0; i < ds.n; i++) {
              rows.push(i);
            }
            return { label: "whole dataset", rows };
          }
          case "ids": {
            const ids =
              (args[which === "A" ? "idsA" : "idsB"] as number[] | undefined) ??
              [];
            return {
              label: `${ids.length} explicit ids`,
              rows: ids.filter((i) => i >= 0 && i < ds.n),
            };
          }
          case "gene": {
            const g = String(
              args[which === "A" ? "geneA" : "geneB"] ?? ""
            ).toUpperCase();
            if (!g) {
              throw new Error(
                `Group ${which} is 'gene' but gene${which} was not supplied.`
              );
            }
            return {
              label: `gene ${g}`,
              rows: annotatedRows(
                (r) => store.annotationFor(r)?.gene.toUpperCase() === g
              ),
            };
          }
          default:
            throw new Error(`Unknown group kind "${kind}".`);
        }
      };

      const a = resolve("A");
      const b = resolve("B");
      if (a.rows.length === 0 || b.rows.length === 0) {
        throw new Error(
          `Cannot compare: ${a.rows.length === 0 ? `group A (${a.label})` : `group B (${b.label})`} is empty.`
        );
      }

      const stats = (rows: number[]) => {
        let annotated = 0;
        const chroms = new Set<string>();
        for (const r of rows) {
          if (ds.annIdx[r]! >= 0) {
            annotated++;
          }
          chroms.add(CHROM_LABELS[ds.chrom[r]!] ?? "?");
        }
        return {
          annotated,
          annotatedPct: +((annotated / rows.length) * 100).toFixed(1),
          chromosomes: [...chroms].slice(0, 25),
          n: rows.length,
          significance: significanceBreakdown(rows),
          topGenes: topGenes(rows, 5),
          zygosity: zygosityBreakdown(rows),
        };
      };

      const sa = stats(a.rows);
      const sb = stats(b.rows);
      return {
        differences: {
          annotationRateDelta: +(sa.annotatedPct - sb.annotatedPct).toFixed(1),
          genesOnlyInA: sa.topGenes
            .filter((g) => !sb.topGenes.some((h) => h.gene === g.gene))
            .map((g) => g.gene),
          genesOnlyInB: sb.topGenes
            .filter((g) => !sa.topGenes.some((h) => h.gene === g.gene))
            .map((g) => g.gene),
          sizeRatio: +(sa.n / sb.n).toFixed(3),
        },
        groupA: { label: a.label, ...sa },
        groupB: { label: b.label, ...sb },
      };
    },
    schema: {
      properties: {
        geneA: {
          description: "Gene symbol when groupA is 'gene'.",
          maxLength: 32,
          type: "string",
        },
        geneB: {
          description: "Gene symbol when groupB is 'gene'.",
          maxLength: 32,
          type: "string",
        },
        groupA: {
          description: "What group A is.",
          enum: ["selection", "visible", "dataset", "shortlist", "ids", "gene"],
          type: "string",
        },
        groupB: {
          description: "What group B is.",
          enum: ["selection", "visible", "dataset", "shortlist", "ids", "gene"],
          type: "string",
        },
        idsA: {
          description: "Row ids when groupA is 'ids'.",
          items: { type: "integer" },
          maxItems: 50,
          type: "array",
        },
        idsB: {
          description: "Row ids when groupB is 'ids'.",
          items: { type: "integer" },
          maxItems: 50,
          type: "array",
        },
      },
      required: ["groupA", "groupB"],
      type: "object",
    },
  },

  {
    description:
      "Return the summary the user is actually looking at in guided mode: how many markers were read, " +
      "how many matched ClinVar, how many of those the user carries, how many findings meet the current " +
      "review criteria, how many rest on two or more agreeing submitters, and the suggested next step. " +
      'Call this to answer "what does my file say?" in one round trip, and to know what the human can ' +
      "already see on screen. Reads state only.",
    layer: "explain",
    name: "explain_overview",
    readOnly: true,
    run: (args) => {
      requireDataset();
      const criteria = {
        carriedOnly:
          args.carriedOnly === undefined
            ? store.state.guided.carriedOnly
            : args.carriedOnly === true,
        includeUncertain:
          args.includeUncertain === undefined
            ? store.state.guided.includeUncertain
            : args.includeUncertain === true,
        minStars:
          (args.minStars as number | undefined) ?? store.state.guided.minStars,
      };
      const ov = computeOverview(criteria)!;
      return {
        caveat:
          "A genotype file is not a diagnostic test, and an empty finding list is not a clean bill of health — the file only covers a fixed subset of positions.",
        criteria: ov.criteria,
        displayedToUser: store.state.mode === "guided",
        genes: ov.genes,
        markers: {
          // `ofThoseCarried` counts only rows where carriage is decidable.
          // `ofThoseUnresolved` counts homozygous calls in a file that never
          // records the reference allele — they are included in the findings
          // list, but nothing here or on screen claims the user carries them.
          matchedToClinVar: ov.annotated,
          ofThoseCarried: ov.carried,
          ofThoseUnresolved: ov.unresolved,
          read: ov.markers,
          uncertainCarried: ov.uncertain,
          zygosityFullyResolvable: ov.carrierResolvable,
        },
        nextStep: ov.nextStep,
        significance: ov.significance,
        topFindings: serialiseRows(ov.rows).rows,
        worthALook: {
          strongReviewEvidence: ov.strongEvidence,
          total: ov.attention,
        },
      };
    },
    schema: {
      properties: {
        carriedOnly: {
          description:
            "Count only variants the user carries. Defaults to whatever the guided screen is currently set to.",
          type: "boolean",
        },
        includeUncertain: {
          description:
            "Also count variants of uncertain significance. Defaults to the guided screen's setting.",
          type: "boolean",
        },
        minStars: {
          description:
            "Minimum ClinVar review stars. Defaults to the guided screen's setting.",
          maximum: 4,
          minimum: 0,
          type: "integer",
        },
      },
      required: [],
      type: "object",
    },
    untrustedContent: true,
  },

  {
    description:
      "Return marker density and annotated-finding counts per chromosome for the current filtered view — " +
      'the same numbers the chromosome map panel is drawing. Useful for answering "where is the coverage" ' +
      'or "which chromosome has the most flagged variants". Reads state only.',
    layer: "explain",
    name: "explain_chromosome_map",
    readOnly: true,
    run: () => {
      const ds = requireDataset();
      const { view } = store.state;
      const total = new Uint32Array(26);
      const flagged = new Uint32Array(26);
      for (const r of view) {
        const c = ds.chrom[r]!;
        total[c]!++;
        const a = store.annotationFor(r);
        if (
          a &&
          (a.significance === "pathogenic" ||
            a.significance === "likely_pathogenic")
        ) {
          flagged[c]!++;
        }
      }
      const chromosomes: {
        chr: string;
        markers: number;
        pathogenicOrLikely: number;
      }[] = [];
      for (let c = 1; c <= 25; c++) {
        if (!total[c]) {
          continue;
        }
        chromosomes.push({
          chr: CHROM_LABELS[c]!,
          markers: total[c]!,
          pathogenicOrLikely: flagged[c]!,
        });
      }
      return {
        chromosomes,
        scope: store.state.filters.length
          ? "current filtered view"
          : "whole dataset",
        totalShown: view.length,
      };
    },
    schema: { properties: {}, required: [], type: "object" },
  },
];

export function genotypeText(row: number): string {
  const ds = store.state.dataset!;
  return `${rsLabel(ds.rsNum[row]!)} ${genotypeLabel(ds, row)}`;
}
