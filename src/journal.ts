/**
 * The collaboration journal — an ephemeral, in-tab audit trail of who changed
 * what.
 *
 * The Tool Activity panel already shows the agent's side of the session, and
 * the undo stack already knows what can be taken back. Neither was readable by
 * the agent, so "what have you changed so far?" was answered from conversation
 * memory, which is exactly the thing that drifts. This journal is the single
 * place both actors' mutations land, and `read_tool_activity` serves it.
 *
 * It records human moves too, and that is the part no server-side API could
 * ever supply: a mouse selection, a filter typed by hand, a declined
 * confirmation. All of it lives in this tab's memory, is never persisted, and
 * dies with the page.
 *
 * Attribution comes from an actor scope that the tool registry sets for the
 * duration of a tool's execution. Concurrent tool calls are all "agent", so
 * they cannot be confused with each other; a human click landing inside an
 * agent's await window is the one case that can be misattributed, which is
 * accepted in exchange for a single hook point at `store.checkpoint`.
 */

export type Actor = "agent" | "human";

export type JournalKind = "declined" | "mutation" | "redo" | "session" | "undo";

export interface JournalEntry {
  actor: Actor;
  /**
   * Present only on entries where consent was the point: false for an action
   * the human declined at the confirmation card.
   */
  approved?: boolean;
  at: number;
  change: string;
  id: string;
  kind: JournalKind;
  tool?: string;
  undoable: boolean;
}

const MAX_ENTRIES = 120;

let seq = 0;
let actor: Actor = "human";
let scopedTool: string | undefined;

class Journal {
  entries: JournalEntry[] = [];

  get actor(): Actor {
    return actor;
  }

  /**
   * Run `fn` attributed to `who`. Restores the previous actor afterwards, so a
   * nested call cannot leave the scope stuck on "agent".
   */
  async as<T>(who: Actor, fn: () => Promise<T> | T, tool?: string): Promise<T> {
    const previousActor = actor;
    const previousTool = scopedTool;
    actor = who;
    scopedTool = tool;
    try {
      return await fn();
    } finally {
      actor = previousActor;
      scopedTool = previousTool;
    }
  }

  record(entry: Omit<JournalEntry, "at" | "id">): void {
    this.entries.unshift({ ...entry, at: Date.now(), id: `j_${++seq}` });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.pop();
    }
  }

  mutation(change: string, tool?: string): void {
    const name = tool ?? scopedTool;
    this.record({
      actor,
      change,
      kind: "mutation",
      undoable: true,
      ...(name ? { tool: name } : {}),
    });
  }

  declined(tool: string, change: string): void {
    this.record({
      actor: "agent",
      approved: false,
      change,
      kind: "declined",
      tool,
      undoable: false,
    });
  }

  clear(): void {
    this.entries = [];
  }

  get count(): number {
    return this.entries.length;
  }
}

export const journal = new Journal();
