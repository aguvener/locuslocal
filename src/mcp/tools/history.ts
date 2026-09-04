/**
 * Layer 5 — read_tool_activity  (the ephemeral collaboration history)
 *
 * Registered only once something has actually happened in this tab, which is
 * the point: before the first change there is no history to read, and a tool
 * that answers "nothing yet" is a tool the agent has to be told to ignore.
 *
 * This is the reader for `src/journal.ts`. It exists because "what have you
 * changed so far?" was previously answered from conversation memory — the one
 * source that drifts, that a page reload silently invalidates, and that knows
 * nothing about what the human did between two agent turns. The journal knows
 * all three: agent mutations, human mutations, and actions the human declined
 * at the confirmation card.
 *
 * No server-side API could serve this. The selection was made with a mouse in
 * this tab, the refusal happened in a card in this tab, and none of it was ever
 * transmitted anywhere.
 */

import { journal } from "../../journal";
import { store } from "../../store";
import { activity } from "../activity";
import { MAX_RESULT_CHARS, type ToolSpec } from "../registry";

const DEFAULT_LIMIT = 20;

/** Compact per-entry shape. Short keys; the model pays for every character. */
interface ActionOut {
  actor: string;
  approved?: boolean;
  change: string;
  kind: string;
  secondsAgo: number;
  tool?: string;
  undoable: boolean;
}

export const historyTools: ToolSpec[] = [
  {
    description:
      "Return this tab's collaboration history: what the agent changed, what the human changed by hand, " +
      "and what the human declined at a confirmation card — newest first, with whether each change can " +
      "still be undone. Use this instead of recalling your own earlier turns: it is the tab's own record, " +
      "it includes the human's mouse work between your turns, and it is the only place a declined action " +
      "is visible. It is ephemeral — it lives in this tab's memory, is never stored, and dies with the " +
      "page. Reads state only.",
    layer: "meta",
    name: "read_tool_activity",
    readOnly: true,
    run: (args) => {
      const limit = (args.limit as number | undefined) ?? DEFAULT_LIMIT;
      const now = Date.now();

      const actions: ActionOut[] = [];
      let used = 0;
      let truncated = false;
      for (const e of journal.entries) {
        if (actions.length >= limit) {
          truncated = true;
          break;
        }
        const out: ActionOut = {
          actor: e.actor,
          change: e.change,
          kind: e.kind,
          secondsAgo: Math.round((now - e.at) / 1000),
          undoable: e.undoable,
        };
        if (e.tool) {
          out.tool = e.tool;
        }
        if (e.approved !== undefined) {
          out.approved = e.approved;
        }
        const cost = JSON.stringify(out).length + 1;
        if (actions.length > 0 && used + cost > MAX_RESULT_CHARS) {
          truncated = true;
          break;
        }
        actions.push(out);
        used += cost;
      }

      // Tool calls that read without changing anything never reach the journal,
      // so the counts come from the activity log — they are how the agent can
      // tell "I looked and changed nothing" from "I have not looked yet".
      const calls = activity.entries;
      return {
        actions,
        declined: calls.filter((c) => c.status === "denied").length,
        note:
          "Newest first. `undoable: true` means the change is still on this tab's undo stack and the user " +
          "can revert it with one keystroke. Human entries were made with the mouse or keyboard in this " +
          "tab and were never transmitted anywhere.",
        recorded: journal.count,
        returned: actions.length,
        toolCalls: calls.length,
        truncated,
        undoAvailable: store.canUndo,
        undoNext: store.undoLabel,
      };
    },
    schema: {
      properties: {
        limit: {
          description:
            "Maximum history entries to return, newest first. Cut shorter if the entries do not fit the result's character budget.",
          maximum: 50,
          minimum: 1,
          type: "integer",
        },
      },
      required: [],
      type: "object",
    },
  },
];
