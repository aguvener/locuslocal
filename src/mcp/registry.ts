import { journal } from "../journal";
import { type ActivityEntry, activity, type ToolLayer } from "./activity";
import { type ObjectSchema, validate } from "./validate";

export interface CallToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface RunContext {
  effect: (text: string) => void;
  signal: AbortSignal;
}

export interface ToolSpec {
  /**
   * Non-null return means the action is gated behind a click in the UI before
   * it runs. Used for every `act_*` tool.
   *
   * An `args` in the return replaces the arguments `run` is called with. That
   * is what keeps the card honest: anything the card resolves out of live
   * state — "the current selection", "the whole shortlist" — has to be pinned
   * here, because the user can change that state while the card is on screen
   * and `run` would otherwise apply the action to a different set than the one
   * they were shown and approved.
   */
  confirm?: (args: Record<string, unknown>) => {
    args?: Record<string, unknown>;
    detail: string;
    title: string;
  } | null;
  description: string;
  layer: ToolLayer;
  name: string;
  readOnly?: boolean;
  run: (
    args: Record<string, unknown>,
    ctx: RunContext
  ) => Promise<unknown> | unknown;
  schema: ObjectSchema;
  /**
   * Marks the tool's *return value* as containing content the user loaded,
   * which the agent must treat as data and never as instructions.
   */
  untrustedContent?: boolean;
}

export type GroupName =
  | "core"
  | "dataset"
  | "history"
  | "selection"
  | "shortlist";

interface LiveGroup {
  controller: AbortController;
  names: string[];
}

export interface RegistryHooks {
  requestConfirmation: (
    toolName: string,
    title: string,
    detail: string
  ) => Promise<boolean>;
}

/**
 * Payload caps. Tools return compact JSON, never a full dataset dump.
 *
 * Chrome's own WebMCP guidance puts a tool result's useful budget at roughly
 * 1.5K characters, and a genomics row is not small — ten of them with gene
 * symbols and condition names will already crowd that. So the row cap is not
 * the real limit: `serialiseRows` fills up to whichever comes first, the row
 * count or the character budget, and says which one stopped it.
 */
export const MAX_ROWS_RETURNED = 10;
export const MAX_RESULT_CHARS = 1500;

export class ToolRegistry {
  readonly #groups = new Map<GroupName, LiveGroup>();
  readonly #hooks: RegistryHooks;
  readonly #specs = new Map<string, ToolSpec>();
  readonly #inflight = new Map<string, AbortController>();

  constructor(hooks: RegistryHooks) {
    this.#hooks = hooks;
  }

  get available(): boolean {
    return "modelContext" in document;
  }

  get activeGroups(): GroupName[] {
    return [...this.#groups.keys()];
  }

  get registeredNames(): string[] {
    return [...this.#groups.values()].flatMap((g) => g.names).sort();
  }

  specFor(name: string): ToolSpec | undefined {
    return this.#specs.get(name);
  }

  get allSpecs(): ToolSpec[] {
    return [...this.#specs.values()];
  }

  learn(specs: ToolSpec[]): void {
    for (const s of specs) {
      this.#specs.set(s.name, s);
    }
  }

  async registerGroup(group: GroupName, specs: ToolSpec[]): Promise<void> {
    if (this.#groups.has(group)) {
      return;
    }
    this.learn(specs);
    const controller = new AbortController();
    this.#groups.set(group, { controller, names: specs.map((s) => s.name) });
    if (!this.available) {
      return;
    }

    try {
      await this.#registerAll(specs, controller);
    } catch (err) {
      // A group that failed to register is not live, and recording it as live
      // would make the `has(group)` guard above refuse to ever retry it. Undo
      // the bookkeeping and let the error propagate to the caller.
      controller.abort();
      this.#groups.delete(group);
      throw err;
    }
  }

  #registerAll(
    specs: ToolSpec[],
    controller: AbortController
  ): Promise<unknown> {
    const mc = modelContext();
    return Promise.all(
      specs.map((spec) =>
        mc.registerTool(
          {
            annotations: {
              readOnlyHint: spec.readOnly ?? false,
              untrustedContentHint: spec.untrustedContent ?? false,
            },
            description: spec.description,
            execute: (args: unknown, ctx?: { signal?: AbortSignal }) =>
              this.#invoke(spec, args, ctx?.signal),
            inputSchema: spec.schema,
            name: spec.name,
          },
          // Aborting this signal is the only way to unregister a tool in
          // Chrome 152 — there is no unregisterTool(). See docs/webmcp-probe-findings.md
          { signal: controller.signal }
        )
      )
    );
  }

  retractGroup(group: GroupName): void {
    const live = this.#groups.get(group);
    if (!live) {
      return;
    }
    live.controller.abort();
    this.#groups.delete(group);
  }

  cancel(callId: string): void {
    this.#inflight
      .get(callId)
      ?.abort(new DOMException("Cancelled by user", "AbortError"));
  }

  /**
   * The wrapper every tool call passes through: log it, validate the arguments
   * as untrusted input, gate side effects behind human confirmation, honour
   * cancellation, cap the payload, and return compact JSON.
   */
  async #invoke(
    spec: ToolSpec,
    rawArgs: unknown,
    platformSignal?: AbortSignal
  ): Promise<CallToolResult> {
    // Chrome 152 does not pass a per-execution signal, so the app owns one and
    // exposes it as a Cancel button. If a future Chrome does supply one, it is
    // chained in here automatically.
    const controller = new AbortController();
    platformSignal?.addEventListener(
      "abort",
      () => controller.abort(platformSignal.reason),
      { once: true }
    );

    const entry = activity.start(spec.name, spec.layer, rawArgs, controller);
    this.#inflight.set(entry.id, controller);

    try {
      const v = validate(spec.schema, rawArgs ?? {});
      entry.notes = v.notes;
      if (!v.ok) {
        return this.#fail(entry, `Invalid arguments: ${v.errors.join("; ")}`);
      }

      let callArgs = v.value;
      if (spec.confirm) {
        const ask = spec.confirm(callArgs);
        if (ask) {
          // Pinned before the await, so what runs is what was approved.
          callArgs = ask.args ?? callArgs;
          const approved = await this.#hooks.requestConfirmation(
            spec.name,
            ask.title,
            ask.detail
          );
          if (!approved) {
            activity.finish(entry, {
              error: "The user declined this action.",
              status: "denied",
            });
            // A refusal is part of the collaboration history, not an absence
            // from it: the agent should be able to read back that it asked and
            // was told no, rather than asking again.
            journal.declined(spec.name, ask.title);
            return errorResult(
              "The user declined this action in the page. Nothing was changed."
            );
          }
        }
      }

      if (controller.signal.aborted) {
        return this.#cancelled(entry);
      }

      // Everything this tool mutates is journalled as the agent's work, via
      // the actor scope that `store.checkpoint` reads.
      const data = await journal.as(
        "agent",
        () =>
          spec.run(callArgs, {
            effect: (message) => {
              entry.effect = message;
              activity.update();
            },
            signal: controller.signal,
          }),
        spec.name
      );

      if (controller.signal.aborted) {
        return this.#cancelled(entry);
      }

      const text = JSON.stringify(data);
      activity.finish(entry, { result: text, status: "ok" });
      return { content: [{ text, type: "text" }] };
    } catch (err) {
      if (controller.signal.aborted) {
        return this.#cancelled(entry);
      }
      return this.#fail(
        entry,
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      this.#inflight.delete(entry.id);
    }
  }

  #fail(entry: ActivityEntry, message: string): CallToolResult {
    activity.finish(entry, { error: message, status: "error" });
    return errorResult(message);
  }

  #cancelled(entry: ActivityEntry): CallToolResult {
    activity.finish(entry, {
      error: "Cancelled by the user.",
      status: "cancelled",
    });
    return errorResult(
      "The user cancelled this call from the page. Nothing was changed."
    );
  }
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ text: JSON.stringify({ error: message }), type: "text" }],
    isError: true,
  };
}

interface ModelContext {
  addEventListener?: (type: string, fn: () => void) => void;
  executeTool: (
    tool: unknown,
    json: string,
    options?: { signal?: AbortSignal }
  ) => Promise<string>;
  getTools: (options?: {
    fromOrigins?: string[];
  }) => Promise<{ name: string }[]>;
  registerTool: (
    def: unknown,
    options?: { signal?: AbortSignal }
  ) => Promise<void>;
}

export function modelContext(): ModelContext {
  return (document as unknown as { modelContext: ModelContext }).modelContext;
}

export function webmcpAvailable(): boolean {
  const context = (
    document as unknown as { modelContext?: Partial<ModelContext> }
  ).modelContext;
  return typeof context?.registerTool === "function";
}
