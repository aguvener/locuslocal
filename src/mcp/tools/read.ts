/**
 * Layer 1 — read_*  (state readers, no side effects)
 *
 * These exist because the information they return has no other route to an
 * agent. `read_current_selection` in particular reports rows the human
 * highlighted with the mouse: that state lives only in this tab's memory and
 * DOM, so no server-side API could ever expose it.
 */

import { computeOverview, findingRows } from "../../analysis";
import { clinvarVersion } from "../../data/annotations";
import { egressStats } from "../../egress";
import { store } from "../../store";
import { CHROM_LABELS } from "../../types";
import { MAX_ROWS_RETURNED, type ToolSpec } from "../registry";
import {
  filterOut,
  requireDataset,
  serialiseRows,
  significanceBreakdown,
  topGenes,
  zygosityBreakdown,
} from "./shared";

export const readTools: ToolSpec[] = [
  {
    description:
      "Return a summary of the genetics file currently loaded in this tab: file type, marker count, " +
      "reference build, per-chromosome coverage, how many markers matched the bundled ClinVar subset, " +
      "and the distribution of clinical significance. Reads state only; changes nothing in the UI.",
    layer: "read",
    name: "read_dataset_summary",
    readOnly: true,
    run: () => {
      const ds = requireDataset();
      const all = new Uint32Array(ds.n);
      for (let i = 0; i < ds.n; i++) {
        all[i] = i;
      }
      const chromosomes: Record<string, number> = {};
      for (let c = 1; c <= 25; c++) {
        const n = ds.chromCounts[c]!;
        if (n) {
          chromosomes[CHROM_LABELS[c]!] = n;
        }
      }
      let annotated = 0;
      for (let i = 0; i < ds.n; i++) {
        if (ds.annIdx[i]! >= 0) {
          annotated++;
        }
      }
      const q = store.state.quality;
      return {
        annotation: {
          enabled: q?.annotation.enabled ?? true,
          markersAnnotated: annotated,
          reason: q?.annotation.reason,
          significance: significanceBreakdown(all),
          source:
            "NCBI ClinVar (GRCh37), bundled locally, joined by rs identifier",
          version: clinvarVersion,
        },
        buildConfidence: q?.buildConfidence,
        chromosomes,
        fileType:
          ds.kind === "vcf" ? "VCF" : "consumer-genomics raw export (TSV)",
        malformedRowsSkipped: ds.skipped,
        markers: ds.n,
        privacy: {
          bytesSentOffDevice: egressStats().bytesOut,
          networkRequestsSinceLoad: egressStats().attempts,
        },
        referenceBuild: ds.build ?? "unknown",
        sizeBytes: ds.sourceBytes,
        source: ds.sourceName,
        syntheticData: ds.synthetic,
        zygosity: zygosityBreakdown(all),
      };
    },
    schema: { properties: {}, required: [], type: "object" },
  },

  {
    description:
      "Return the filter stack currently applied to the table, in the order it was applied, plus how " +
      "many markers survive it. Use this before changing filters so you know what the user is already " +
      "looking at. Reads state only.",
    layer: "read",
    name: "read_active_filters",
    readOnly: true,
    run: () => {
      const ds = requireDataset();
      return {
        filters: store.state.filters.map(filterOut),
        matching: store.state.view.length,
        sort: store.state.sort,
        totalMarkers: ds.n,
      };
    },
    schema: { properties: {}, required: [], type: "object" },
  },

  {
    description:
      "Return what the user can see on screen right now, which no API can tell you. In the advanced " +
      "table that is the rows scrolled into view; in guided mode it is the findings the summary screen " +
      "is listing. Reads state only.",
    layer: "read",
    name: "read_visible_rows",
    readOnly: true,
    run: (args) => {
      requireDataset();
      const limit = (args.limit as number | undefined) ?? MAX_ROWS_RETURNED;
      if (store.state.mode === "guided") {
        const rows = findingRows(store.state.guided);
        return {
          criteria: store.state.guided,
          showing: "the guided summary screen, not the table",
          ...serialiseRows(rows, limit),
        };
      }
      const { start, end } = store.state.viewport;
      const { view } = store.state;
      const slice = view.subarray(start, Math.min(end, view.length));
      return {
        showing: "the advanced variant table",
        viewportRange: {
          firstRowIndex: start,
          lastRowIndex: Math.min(end, view.length) - 1,
        },
        ...serialiseRows(slice, limit),
      };
    },
    schema: {
      properties: {
        limit: {
          description:
            "Maximum rows to return. Capped at 10, and cut shorter still if the rows do not fit the result's character budget — the response says when that happened.",
          maximum: MAX_ROWS_RETURNED,
          minimum: 1,
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
      "Return the rows the user has selected by hand in the table (click, shift-click for a range, " +
      "cmd/ctrl-click to add). This selection exists only in this tab — it was made with the mouse and " +
      "was never sent anywhere — so this tool is the only way to know what the user is pointing at. " +
      "Includes a summary of the selection. Reads state only. This tool is only registered while a " +
      "selection actually exists.",
    layer: "read",
    name: "read_current_selection",
    readOnly: true,
    run: () => {
      requireDataset();
      const rows = [...store.state.selection];
      if (rows.length === 0) {
        return {
          note: "The user has no rows selected right now.",
          selected: 0,
        };
      }
      rows.sort((a, b) => a - b);
      return {
        selected: rows.length,
        ...serialiseRows(rows),
        summary: {
          genes: topGenes(rows),
          significance: significanceBreakdown(rows),
          zygosity: zygosityBreakdown(rows),
        },
      };
    },
    schema: { properties: {}, required: [], type: "object" },
    untrustedContent: true,
  },

  {
    description:
      "Return a data-quality report for the loaded file and, crucially, whether clinical annotation was " +
      "applied to it at all. Covers the detected reference build and how confident that detection is, " +
      "genotype call rate, duplicate rs identifiers, rows rejected as malformed, and the ClinVar " +
      "annotation gate's verdict with its reasoning. Call this before reporting any finding: if " +
      "`annotationSafe` is false there are no classifications in this dataset, and an empty findings " +
      "list means the file could not be annotated rather than that it is clean. Reads state only.",
    layer: "read",
    name: "read_data_quality",
    readOnly: true,
    run: () => {
      requireDataset();
      const q = store.state.quality;
      if (!q) {
        throw new Error(
          "No quality report is available for the loaded dataset."
        );
      }
      return q;
    },
    schema: { properties: {}, required: [], type: "object" },
  },

  {
    description:
      "Return the current triage shortlist: the markers the user or the agent has flagged for follow-up, " +
      "with the note attached to each, what the user decided to do about it, and whether a human or the " +
      "agent added it. Reads state only.",
    layer: "read",
    name: "read_shortlist",
    readOnly: true,
    run: () => {
      requireDataset();
      const entries = store.state.shortlist;
      const page = serialiseRows(entries.map((e) => e.row));
      const byRow = new Map(entries.map((e) => [e.row, e]));
      return {
        count: entries.length,
        entries: page.rows.map((row) => {
          const e = byRow.get(row.id)!;
          return { ...row, addedBy: e.addedBy, note: e.note, status: e.status };
        }),
        statusVocabulary: {
          ask_doctor: "the user wants to raise it with a clinician",
          new: "not triaged yet",
          not_important: "the user has dismissed it",
          research: "the user wants to read up on it",
        },
        ...(page.nextSuggestedAction
          ? { nextSuggestedAction: page.nextSuggestedAction }
          : {}),
        returned: page.returned,
        truncated: page.truncated,
      };
    },
    schema: { properties: {}, required: [], type: "object" },
    untrustedContent: true,
  },
];

export const coreTools: ToolSpec[] = [
  {
    description:
      "Return what this workbench currently holds and which tools are therefore available. Call this " +
      "first. When no genetics file is loaded most analysis tools are not registered at all; this tool " +
      "explains what to do about that. Reads state only.",
    layer: "meta",
    name: "read_app_state",
    readOnly: true,
    run: () => {
      const ds = store.state.dataset;
      const eg = egressStats();
      const ov = ds ? computeOverview(store.state.guided) : null;
      return {
        activeFilters: store.state.filters.length,
        dataset: ds
          ? {
              build: ds.build,
              markers: ds.n,
              source: ds.sourceName,
              type: ds.kind,
            }
          : null,
        datasetLoaded: !!ds,
        nextStep: ds
          ? "A dataset is loaded. Analysis tools are registered — try explain_overview for the summary the user is looking at, or read_dataset_summary for file-level detail."
          : "No dataset. Call act_load_demo_dataset to load the bundled real demo genome, or ask the " +
            "user to drop their own VCF or 23andMe/AncestryDNA export onto the page.",
        onScreen: ds
          ? {
              detailPanelOpenFor: store.state.detailRow,
              findingsUnderCurrentCriteria: ov?.attention ?? 0,
              mode: store.state.mode,
              showing:
                store.state.mode === "guided"
                  ? "the guided plain-language summary — the default for somebody reading their own DNA"
                  : "the advanced variant table",
            }
          : null,
        privacy: {
          bytesSentOffDevice: eg.bytesOut,
          model:
            "All genotype data stays in this browser tab. The page is served with " +
            "Content-Security-Policy: connect-src 'none', so it is incapable of opening a network " +
            "connection of any kind. No tool can transmit the dataset.",
          networkRequestsSinceDatasetLoad: eg.attempts,
        },
        product: "LocusLocal — a browser-local variant triage workbench",
        selectionSize: store.state.selection.size,
        shortlistSize: store.state.shortlist.length,
      };
    },
    schema: { properties: {}, required: [], type: "object" },
  },
];
