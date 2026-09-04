export type ToolLayer = "read" | "set" | "act" | "explain" | "meta";

export interface ActivityEntry {
  args: unknown;
  controller: AbortController | null;
  durationMs: number | null;
  effect: string | null;
  error: string | null;
  id: string;
  layer: ToolLayer;
  notes: string[];
  result: string | null;
  startedAt: number;
  status: "running" | "ok" | "error" | "cancelled" | "denied";
  tool: string;
}

type Listener = (entries: ActivityEntry[]) => void;

let seq = 0;

class ActivityLog {
  entries: ActivityEntry[] = [];
  readonly #listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(): void {
    for (const fn of this.#listeners) {
      fn(this.entries);
    }
  }

  start(
    tool: string,
    layer: ToolLayer,
    args: unknown,
    controller: AbortController
  ): ActivityEntry {
    const entry: ActivityEntry = {
      args,
      controller,
      durationMs: null,
      effect: null,
      error: null,
      id: `call_${++seq}`,
      layer,
      notes: [],
      result: null,
      startedAt: performance.now(),
      status: "running",
      tool,
    };
    this.entries.unshift(entry);
    if (this.entries.length > 200) {
      this.entries.pop();
    }
    this.#emit();
    return entry;
  }

  finish(entry: ActivityEntry, patch: Partial<ActivityEntry>): void {
    Object.assign(entry, patch);
    entry.durationMs = performance.now() - entry.startedAt;
    entry.controller = null;
    this.#emit();
  }

  update(): void {
    this.#emit();
  }

  clear(): void {
    this.entries = [];
    this.#emit();
  }

  get callCount(): number {
    return seq;
  }
}

export const activity = new ActivityLog();
