/**
 * Layer 3 — act_*  (side effects, gated behind an explicit human click)
 *
 * Every tool in this layer returns a non-null `confirm`, so the registry stops
 * and renders a confirmation card in the page before the action runs. The agent
 * cannot shortlist, clear or export anything on its own; a human approves each
 * one. Note what is deliberately absent: there is no tool that transmits data.
 * The export tool writes a file to the user's own disk and nowhere else, and
 * the page's CSP (`connect-src 'none'`) makes any other outcome impossible.
 */
import {
  addToShortlist,
  deleteAllLocalData,
  loadDataset,
  removeFromShortlist,
  removeManyFromShortlist,
  setShortlistNote,
  setShortlistStatus,
  unloadDataset,
} from "../../actions";
import {
  SHORTLIST_STATUSES,
  type ShortlistStatus,
  STATUS_LABEL,
  store,
} from "../../store";
import { CHROM_LABELS, rsLabel } from "../../types";
import type { ToolSpec } from "../registry";
import { requireDataset, serialiseRows } from "./shared";

export const actTools: ToolSpec[] = [
  {
    // `fromSelection` is resolved here rather than in `run`. The selection is
    // mouse-driven and stays live while the card is on screen, so re-reading it
    // after the user clicks Allow could add a completely different set from the
    // one the card counted.
    confirm: (args) => {
      const ids =
        args.fromSelection === true
          ? [...store.state.selection]
          : ((args.ids as number[] | undefined) ?? []);
      const n = ids.length;
      return {
        args: { ...args, fromSelection: false, ids },
        detail:
          typeof args.note === "string" && args.note
            ? `Note: “${args.note}”`
            : "No note supplied.",
        title: `Add ${n} marker${n === 1 ? "" : "s"} to your shortlist?`,
      };
    },
    description:
      "Add markers to the triage shortlist with a note explaining why. Shows the user a confirmation " +
      "card first; they must approve it before anything is added. The shortlist panel then updates " +
      "visibly and the change is undoable. Pass ids explicitly, or set fromSelection to shortlist " +
      "exactly what the user has highlighted.",
    layer: "act",
    name: "act_add_to_shortlist",
    run: (args, ctx) => {
      const ds = requireDataset();
      const ids =
        args.fromSelection === true
          ? [...store.state.selection]
          : ((args.ids as number[] | undefined) ?? []);
      if (ids.length === 0) {
        throw new Error(
          "Nothing to add: pass ids, or set fromSelection when the user has a selection."
        );
      }
      const valid = ids.filter(
        (i) => Number.isInteger(i) && i >= 0 && i < ds.n
      );
      if (valid.length === 0) {
        throw new Error("None of those row ids exist in the loaded dataset.");
      }
      const added = addToShortlist(
        valid,
        (args.note as string | undefined) ?? "",
        "agent"
      );
      ctx.effect(`Added ${added} marker(s) to the shortlist`);
      return {
        added,
        alreadyPresent: valid.length - added,
        shortlistSize: store.state.shortlist.length,
        ...serialiseRows(valid),
      };
    },
    schema: {
      properties: {
        fromSelection: {
          description: "Shortlist the user's current manual selection instead.",
          type: "boolean",
        },
        ids: {
          description: "Stable row ids from any read_ or explain_ tool.",
          items: { type: "integer" },
          maxItems: 50,
          type: "array",
        },
        note: {
          description: "Short reason this is worth following up.",
          maxLength: 160,
          type: "string",
        },
      },
      required: [],
      type: "object",
    },
  },

  {
    // Same reason as act_add_to_shortlist: the count on the card is pinned to
    // the rows that existed when it was shown, and `run` clears exactly those.
    confirm: () => {
      const ids = store.state.shortlist.map((e) => e.row);
      return {
        args: { ids },
        detail: "This empties the shortlist panel. You can undo it afterwards.",
        title: `Clear all ${ids.length} shortlisted markers?`,
      };
    },
    description:
      "Empty the triage shortlist. Destructive, so the user has to approve it in the page first. " +
      "The change is undoable.",
    layer: "act",
    name: "act_clear_shortlist",
    run: (args, ctx) => {
      requireDataset();
      const approved = new Set((args.ids as number[] | undefined) ?? []);
      const n = removeManyFromShortlist(
        store.state.shortlist.map((e) => e.row).filter((r) => approved.has(r))
      );
      ctx.effect(`Cleared ${n} marker(s) from the shortlist`);
      return { cleared: n, undo: "Undoable from the UI." };
    },
    schema: { properties: {}, required: [], type: "object" },
  },

  {
    confirm: () => ({
      detail:
        "Real public genotypes for 1000 Genomes sample NA12878 (~900k markers). Replaces anything currently loaded. Nothing is uploaded.",
      title: "Load the bundled demo genome?",
    }),
    description:
      "Load the bundled demo genome so the workbench has something to work on. This is real, public, " +
      "open-consent genotype data for 1000 Genomes sample NA12878 — it is not synthetic and not the " +
      "user's own data. Asks the user to confirm first. Once loaded, roughly ten further analysis " +
      "tools become available that do not exist right now.",
    layer: "act",
    name: "act_load_demo_dataset",
    run: async (_args, ctx) => {
      ctx.effect("Loading the bundled demo genome…");
      const res = await fetchDemoFile();
      const ds = await loadDataset(res);
      ctx.effect(
        `Loaded ${ds.n.toLocaleString()} markers from ${ds.sourceName}`
      );
      let annotated = 0;
      for (let i = 0; i < ds.n; i++) {
        if (ds.annIdx[i]! >= 0) {
          annotated++;
        }
      }
      return {
        build: ds.build,
        loaded: true,
        markers: ds.n,
        markersWithClinVarAnnotation: annotated,
        note: "Analysis tools are now registered. Call read_dataset_summary next.",
        provenance:
          "1000 Genomes Project, Affymetrix 6.0 genotype chip, sample NA12878. Public, open-consent data.",
        source: ds.sourceName,
      };
    },
    schema: { properties: {}, required: [], type: "object" },
  },

  {
    confirm: (args) => {
      const entry = store.state.shortlist.find((e) => e.row === args.id);
      const label = entry
        ? rsLabel(store.state.dataset?.rsNum[entry.row] ?? 0)
        : "that marker";
      if (args.remove === true) {
        return {
          detail: "It stays in the dataset; it just comes off your worklist.",
          title: `Take ${label} off your shortlist?`,
        };
      }
      const parts: string[] = [];
      if (typeof args.status === "string") {
        parts.push(
          `Status: ${STATUS_LABEL[args.status as ShortlistStatus] ?? args.status}`
        );
      }
      if (typeof args.note === "string") {
        parts.push(`Note: \u201c${args.note}\u201d`);
      }
      return {
        detail: parts.join(" \u00b7 ") || "No change was specified.",
        title: `Update your shortlist entry for ${label}?`,
      };
    },
    description:
      "Update one entry on the triage shortlist: rewrite its note, set what the user has decided to do " +
      "about it (undecided, ask a doctor, read up on it, not important), or take it off the list " +
      "entirely. These are the same controls the user has on each shortlist row, so anything you do here " +
      "they can see and change by hand. Shows a confirmation card first and the change is undoable.",
    layer: "act",
    name: "act_update_shortlist_entry",
    run: (args, ctx) => {
      requireDataset();
      const id = args.id as number;
      const entry = store.state.shortlist.find((e) => e.row === id);
      if (!entry) {
        throw new Error(
          `Row ${id} is not on the shortlist. Call read_shortlist to see what is.`
        );
      }
      if (args.remove === true) {
        removeFromShortlist(id);
        ctx.effect(
          `Removed ${rsLabel(store.state.dataset!.rsNum[id]!)} from the shortlist`
        );
        return {
          removed: true,
          shortlistSize: store.state.shortlist.length,
        };
      }
      const changed: string[] = [];
      if (
        typeof args.status === "string" &&
        setShortlistStatus(id, args.status as ShortlistStatus)
      ) {
        changed.push(`status \u2192 ${args.status}`);
      }
      if (typeof args.note === "string" && setShortlistNote(id, args.note)) {
        changed.push("note rewritten");
      }
      if (changed.length === 0) {
        throw new Error(
          "Nothing to change: pass a note, a status, or remove: true."
        );
      }
      ctx.effect(`Updated the shortlist entry (${changed.join(", ")})`);
      const updated = store.state.shortlist.find((e) => e.row === id)!;
      return {
        entry: {
          ...serialiseRows([id], 1).rows[0]!,
          addedBy: updated.addedBy,
          note: updated.note,
          status: updated.status,
        },
        undo: "Undoable from the UI.",
      };
    },
    schema: {
      properties: {
        id: {
          description: "Stable row id of the shortlisted marker.",
          minimum: 0,
          type: "integer",
        },
        note: {
          description: "Replacement note explaining why this matters.",
          maxLength: 200,
          type: "string",
        },
        remove: {
          description: "Take this marker off the shortlist entirely.",
          type: "boolean",
        },
        status: {
          description: "What the user has decided to do about this marker.",
          enum: SHORTLIST_STATUSES,
          type: "string",
        },
      },
      required: ["id"],
      type: "object",
    },
  },

  {
    confirm: () => ({
      detail:
        "The genotypes are dropped from memory and the analysis tools are retracted. The copy saved on this device is left alone, so it can be reopened.",
      title: "Close the loaded genetics file?",
    }),
    description:
      "Close the currently loaded file, dropping the genotypes from memory. Use this when the user says " +
      "they are done, or wants to work on a different file. The user approves it in the page first. This " +
      "does not erase the copy saved on their device — act_delete_local_data does that.",
    layer: "act",
    name: "act_close_dataset",
    run: (_args, ctx) => {
      const ds = requireDataset();
      const { sourceName } = ds;
      unloadDataset();
      ctx.effect(`Closed ${sourceName}`);
      return {
        closed: sourceName,
        note: "The analysis tools have been retracted. Only the core tools remain until a file is loaded again.",
        undo: "Undoable from the UI.",
      };
    },
    schema: { properties: {}, required: [], type: "object" },
  },

  {
    confirm: () => ({
      detail:
        "This erases the stored genome, filters, shortlist and notes from this browser. It cannot be undone.",
      title: "Delete everything LocusLocal has stored on this device?",
    }),
    description:
      "Erase everything this page has kept on the user's device: the parsed genome, the filters, the " +
      "shortlist and the notes. Use it when the user asks to clear their data or is finishing up on a " +
      "shared machine. Destructive and not undoable, so the user must approve it in the page.",
    layer: "act",
    name: "act_delete_local_data",
    run: async (_args, ctx) => {
      await deleteAllLocalData();
      ctx.effect("Erased all locally stored data");
      return {
        deleted: true,
        note: "Nothing was transmitted anywhere; this only removed data that was already local.",
      };
    },
    schema: { properties: {}, required: [], type: "object" },
  },
];

/**
 * The demo file ships inside the JS bundle as a lazily imported chunk, not as a
 * fetchable asset, because `connect-src 'none'` means this page cannot fetch
 * anything at runtime. Loading it is a script import, and it becomes a File
 * object without ever touching the network stack.
 */
async function fetchDemoFile(): Promise<File> {
  const mod = await import("../../data/demo.data.js");
  return new File([mod.DEMO_TSV], mod.DEMO_FILENAME, {
    type: "text/tab-separated-values",
  });
}

export function shortlistSummaryLine(): string {
  const ds = store.state.dataset;
  if (!ds) {
    return "";
  }
  return store.state.shortlist
    .map(
      (e) =>
        `${rsLabel(ds.rsNum[e.row]!)} ${CHROM_LABELS[ds.chrom[e.row]!]}:${ds.pos[e.row]}`
    )
    .join(", ");
}
