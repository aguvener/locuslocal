/**
 * Layer 2 — set_*  (visible, undoable mutations)
 *
 * Every tool here changes what the human sees. Each one routes through
 * src/actions.ts, the same code the mouse-driven UI uses, so an agent's change
 * lands in the same undo stack as a human's and can be reverted with Cmd/Ctrl+Z
 * or the Undo button. Each description states its UI effect so the agent knows
 * the change is visible and reversible.
 */

import {
  addFilter,
  clearFilters,
  describeFilter,
  focusRow,
  openDetail,
  removeFilter,
  setGuidedCriteria,
  setMode,
  setSort,
} from "../../actions";
import { explainVariant } from "../../analysis";
import { type Filter, type SortKey, store, type ViewMode } from "../../store";
import { chromCode, SIGNIFICANCES } from "../../types";
import type { ToolSpec } from "../registry";
import {
  filterOut,
  requireDataset,
  resolveRow,
  serialiseRows,
  significanceBreakdown,
} from "./shared";

const SORT_KEYS: SortKey[] = [
  "position",
  "significance",
  "gene",
  "rsid",
  "stars",
];

export const setTools: ToolSpec[] = [
  {
    description:
      "Apply a filter to the variant table. The table, the summary panel and the chromosome map all " +
      "update immediately and the user sees the change; it is pushed onto the undo stack so they can " +
      "revert it. Passing several arguments applies them together. Applying a filter of a kind that is " +
      "already active replaces it rather than stacking a second copy. Returns the resulting counts and " +
      "a first page of matching rows within the result's character budget.",
    layer: "set",
    name: "set_filter",
    run: (args, ctx) => {
      requireDataset();
      const applied: Filter[] = [];

      if (typeof args.gene === "string" && args.gene.trim()) {
        applied.push(
          addFilter({ gene: args.gene.trim().toUpperCase(), kind: "gene" })
        );
      }
      if (typeof args.chromosome === "string") {
        const c = chromCode(args.chromosome);
        if (!c) {
          throw new Error(
            `Unrecognised chromosome "${args.chromosome}". Use 1-22, X, Y or MT.`
          );
        }
        if (
          typeof args.regionStart === "number" ||
          typeof args.regionEnd === "number"
        ) {
          applied.push(
            addFilter({
              chrom: c,
              end: (args.regionEnd as number | undefined) ?? 0xff_ff_ff_ff,
              kind: "region",
              start: (args.regionStart as number | undefined) ?? 0,
            })
          );
        } else {
          applied.push(addFilter({ chrom: c, kind: "chromosome" }));
        }
      }
      if (Array.isArray(args.significance) && args.significance.length) {
        applied.push(
          addFilter({
            kind: "significance",
            values: args.significance as never,
          })
        );
      }
      if (args.annotatedOnly === true) {
        applied.push(addFilter({ kind: "annotated_only" }));
      }
      if (args.carriedOnly === true) {
        applied.push(addFilter({ kind: "carried_only" }));
      }
      if (typeof args.zygosity === "string") {
        applied.push(
          addFilter({ kind: "zygosity", value: args.zygosity as never })
        );
      }
      if (typeof args.minStars === "number") {
        applied.push(addFilter({ kind: "min_stars", stars: args.minStars }));
      }
      if (typeof args.search === "string" && args.search.trim()) {
        applied.push(addFilter({ kind: "search", query: args.search.trim() }));
      }

      if (applied.length === 0) {
        throw new Error(
          "No filter arguments were supplied. Pass at least one of: gene, chromosome, significance, annotatedOnly, carriedOnly, zygosity, minStars, search."
        );
      }

      const { view } = store.state;
      ctx.effect(
        `Applied ${applied.map(describeFilter).join(" + ")} — ${view.length.toLocaleString()} markers now shown`
      );
      return {
        activeFilters: store.state.filters.map(filterOut),
        appliedFilters: applied.map(filterOut),
        matching: view.length,
        significance: significanceBreakdown(view),
        ...serialiseRows(view),
        undo: "The user can revert this with the Undo button or Cmd/Ctrl+Z.",
      };
    },
    schema: {
      properties: {
        annotatedOnly: {
          description: "Keep only markers that have a ClinVar annotation.",
          type: "boolean",
        },
        carriedOnly: {
          description:
            "Keep only markers the user actually carries — anything that is not homozygous reference and not a no-call.",
          type: "boolean",
        },
        chromosome: {
          description: "Chromosome: 1-22, X, Y or MT.",
          maxLength: 4,
          type: "string",
        },
        gene: {
          description: "HGNC gene symbol, e.g. BRCA1 or MYH7.",
          maxLength: 32,
          type: "string",
        },
        minStars: {
          description:
            "Minimum ClinVar review-status star rating, 0-4. Use 2+ for well-reviewed assertions.",
          maximum: 4,
          minimum: 0,
          type: "integer",
        },
        regionEnd: {
          description: "Region end coordinate; requires chromosome.",
          minimum: 0,
          type: "integer",
        },
        regionStart: {
          description: "Region start coordinate; requires chromosome.",
          minimum: 0,
          type: "integer",
        },
        search: {
          description: "Free-text match against rsid, gene or condition.",
          maxLength: 64,
          type: "string",
        },
        significance: {
          description:
            "Keep only markers with one of these ClinVar classifications.",
          items: { enum: SIGNIFICANCES, type: "string" },
          maxItems: 7,
          type: "array",
        },
        zygosity: {
          description:
            "Keep only markers with this zygosity in the user's genotype. hom_ref and hom_alt are " +
            "only decidable for a VCF; a consumer chip export never records the reference allele, so " +
            "its homozygous calls are reported as hom instead.",
          enum: ["het", "hom", "hom_alt", "hom_ref", "no_call"],
          type: "string",
        },
      },
      required: [],
      type: "object",
    },
  },

  {
    description:
      "Remove all active filters, or one specific filter by its id, so the full dataset is shown again. " +
      "The table updates visibly and the change is undoable.",
    layer: "set",
    name: "clear_filters",
    run: (args, ctx) => {
      requireDataset();
      if (typeof args.filterId === "string") {
        const target = store.state.filters.find((f) => f.id === args.filterId);
        if (!target) {
          throw new Error(`No active filter with id "${args.filterId}".`);
        }
        removeFilter(args.filterId);
        ctx.effect(`Removed filter: ${describeFilter(target)}`);
        return {
          activeFilters: store.state.filters.map(filterOut),
          removed: 1,
        };
      }
      const n = clearFilters();
      ctx.effect(
        n
          ? `Cleared ${n} filter(s) — showing all markers`
          : "No filters were active"
      );
      return {
        matching: store.state.view.length,
        removed: n,
        undo: "Undoable from the UI.",
      };
    },
    schema: {
      properties: {
        filterId: {
          description: "Remove only this filter, from read_active_filters.",
          maxLength: 32,
          type: "string",
        },
      },
      required: [],
      type: "object",
    },
  },

  {
    description:
      "Reorder the variant table. The rows visibly rearrange for the user and the change is undoable. " +
      "Sorting by 'significance' puts pathogenic findings at the top, which is the usual triage order.",
    layer: "set",
    name: "set_sort",
    run: (args, ctx) => {
      requireDataset();
      const sort = setSort(
        args.key as SortKey,
        (args.direction as "asc" | "desc" | undefined) ?? "asc"
      );
      ctx.effect(`Sorted by ${sort.key} (${sort.dir})`);
      return { sort, ...serialiseRows(store.state.view) };
    },
    schema: {
      properties: {
        direction: {
          description: "Sort direction; defaults to asc.",
          enum: ["asc", "desc"],
          type: "string",
        },
        key: {
          description: "Column to sort by.",
          enum: SORT_KEYS,
          type: "string",
        },
      },
      required: ["key"],
      type: "object",
    },
  },

  {
    description:
      "Switch what the user is looking at. 'guided' is the plain-language summary screen — marker counts, " +
      "how many findings need a look, how strong the evidence is, and what to do next — which is the right " +
      "surface for somebody reading their own DNA. 'advanced' is the full variant table with the filter " +
      "stack, for somebody who works with genomic data. The screen changes immediately and the change is " +
      "undoable. Optionally retune what counts as a finding, using the same three criteria explain_findings " +
      "takes; those settings are visible to the user as controls on the guided screen.",
    layer: "set",
    name: "set_view_mode",
    run: (args, ctx) => {
      requireDataset();
      const mode = args.mode as ViewMode;
      const patch: Record<string, unknown> = {};
      if (typeof args.carriedOnly === "boolean") {
        patch.carriedOnly = args.carriedOnly;
      }
      if (typeof args.includeUncertain === "boolean") {
        patch.includeUncertain = args.includeUncertain;
      }
      if (typeof args.minStars === "number") {
        patch.minStars = args.minStars;
      }
      if (Object.keys(patch).length > 0) {
        setGuidedCriteria(patch);
      }
      setMode(mode);
      ctx.effect(
        mode === "guided"
          ? "Showing the guided summary screen"
          : "Showing the advanced variant table"
      );
      return {
        criteria: store.state.guided,
        mode: store.state.mode,
        showing:
          mode === "guided"
            ? "The plain-language summary, with the findings list."
            : "The full variant table, filters and sorting.",
        undo: "The user can revert this with the Undo button or Cmd/Ctrl+Z.",
      };
    },
    schema: {
      properties: {
        carriedOnly: {
          description:
            "Count only variants the user carries when tallying findings on the guided screen.",
          type: "boolean",
        },
        includeUncertain: {
          description:
            "Count variants of uncertain significance as findings on the guided screen.",
          type: "boolean",
        },
        minStars: {
          description:
            "Minimum ClinVar review stars for a finding on the guided screen.",
          maximum: 4,
          minimum: 0,
          type: "integer",
        },
        mode: {
          description: "Which surface to show the user.",
          enum: ["guided", "advanced"],
          type: "string",
        },
      },
      required: ["mode"],
      type: "object",
    },
  },

  {
    description:
      "Open the variant detail panel for one marker, so the user reads the plain-language explanation of " +
      "it on screen — what the classification means, whether they carry it, how strong the review evidence " +
      "is, and what the analysis cannot tell them. Use this instead of pasting an explanation into chat " +
      "when you want the user to see it in the page, with the shortlist controls attached. Reads nothing " +
      "the user cannot already reach by clicking the row.",
    layer: "set",
    name: "open_variant_details",
    run: (args, ctx) => {
      const ds = requireDataset();
      const row = resolveRow(ds, args);
      if (row < 0 || !openDetail(row)) {
        throw new Error(
          "Provide a valid row id or an rsid present in this dataset."
        );
      }
      const x = explainVariant(row)!;
      ctx.effect(`Opened the detail panel for ${x.rsid}`);
      return {
        opened: {
          carrierStatus: x.carrierText,
          classification: x.classificationLabel,
          condition: x.condition,
          gene: x.gene,
          reviewStars: x.stars,
          rsid: x.rsid,
        },
        shownToUser: true,
      };
    },
    schema: {
      properties: {
        id: {
          description: "Stable row id returned by any read_ or explain_ tool.",
          minimum: 0,
          type: "integer",
        },
        rsid: {
          description: "Alternatively, an rs identifier such as rs334.",
          maxLength: 24,
          type: "string",
        },
      },
      required: [],
      type: "object",
    },
  },

  {
    description:
      "Scroll the table to a specific marker and highlight it, taking the user's eye to it. Use this " +
      "when you want to point at one finding while you explain it. Undoable.",
    layer: "set",
    name: "focus_row",
    run: (args, ctx) => {
      const ds = requireDataset();
      const row = resolveRow(ds, args);
      if (row < 0) {
        throw new Error(
          "Provide a valid row id or an rsid present in this dataset."
        );
      }
      if (!focusRow(row)) {
        throw new Error(
          "That marker exists but is hidden by the active filters. Clear filters first, or call read_active_filters to see what is applied."
        );
      }
      const serialised = serialiseRows([row], 1).rows[0]!;
      ctx.effect(
        `Scrolled to and highlighted ${serialised.rsid} (${serialised.chr}:${serialised.pos})`
      );
      return { focused: serialised };
    },
    schema: {
      properties: {
        id: {
          description: "Stable row id returned by any read_ or explain_ tool.",
          minimum: 0,
          type: "integer",
        },
        rsid: {
          description: "Alternatively, an rs identifier such as rs334.",
          maxLength: 24,
          type: "string",
        },
      },
      required: [],
      type: "object",
    },
  },
];
