/**
 * Human-in-the-loop confirmation.
 *
 * The registry will not run a side-effecting tool until this resolves true, so
 * an agent can propose a shortlist change or an export but cannot perform one.
 * Declining returns a normal (non-error) result telling the agent the user said
 * no, which is information it can act on rather than something to retry.
 *
 * The same card is used for destructive things the human initiates — closing a
 * file, wiping local data — with a different kicker, so one dialog covers both
 * and neither path invents its own modal.
 */
let active: (() => void) | null = null;

export function requestConfirmation(
  toolName: string,
  title: string,
  detail: string
): Promise<boolean> {
  return confirmCard(
    title,
    detail,
    "The agent is asking permission",
    toolName,
    ["Decline", "Allow"]
  );
}

export function confirmAction(
  title: string,
  detail: string,
  kicker = "Confirm"
): Promise<boolean> {
  return confirmCard(title, detail, kicker, null, ["Cancel", "Confirm"]);
}

function confirmCard(
  title: string,
  detail: string,
  kicker: string,
  toolName: string | null,
  [denyLabel, allowLabel]: [string, string]
): Promise<boolean> {
  active?.();
  return new Promise<boolean>((resolve) => {
    const root = document.getElementById("confirm-root");
    if (!root) {
      resolve(false);
      return;
    }

    const layer = document.createElement("div");
    layer.className = "confirm-layer";
    layer.innerHTML = `
      <div class="confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="confirm-kicker"></div>
        <div class="confirm-title" id="confirm-title"></div>
        <div class="confirm-detail"></div>
        <div class="confirm-tool"></div>
        <div class="confirm-actions">
          <button class="btn" data-act="deny" type="button"></button>
          <button class="btn btn-primary" data-act="allow" type="button"></button>
        </div>
      </div>`;
    (layer.querySelector(".confirm-kicker") as HTMLElement).textContent =
      kicker;
    (layer.querySelector(".confirm-title") as HTMLElement).textContent = title;
    (layer.querySelector(".confirm-detail") as HTMLElement).textContent =
      detail;
    (layer.querySelector(".confirm-tool") as HTMLElement).textContent = toolName
      ? `tool: ${toolName}`
      : "";
    (layer.querySelector('[data-act="deny"]') as HTMLElement).textContent =
      denyLabel;
    (layer.querySelector('[data-act="allow"]') as HTMLElement).textContent =
      allowLabel;

    const returnFocus = document.activeElement as HTMLElement | null;
    const buttons = [
      layer.querySelector<HTMLElement>('[data-act="deny"]'),
      layer.querySelector<HTMLElement>('[data-act="allow"]'),
    ].filter((b): b is HTMLElement => b !== null);

    const finish = (ok: boolean) => {
      layer.remove();
      document.removeEventListener("keydown", onKey);
      active = null;
      returnFocus?.focus();
      resolve(ok);
    };
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        finish(false);
        return;
      }
      // Tab cycles between the two answers and nowhere else. `aria-modal` is a
      // claim about focus, not an enforcement of it, and the page behind this
      // card is reachable by tab without the trap.
      if (e.key !== "Tab" || buttons.length === 0) {
        return;
      }
      e.preventDefault();
      const at = buttons.indexOf(document.activeElement as HTMLElement);
      const step = e.shiftKey ? -1 : 1;
      const next = (at + step + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }

    layer.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (act) {
        finish(act.dataset.act === "allow");
      } else if (e.target === layer) {
        finish(false);
      }
    });
    document.addEventListener("keydown", onKey);
    active = () => finish(false);

    root.append(layer);
    // The negative answer takes focus, never the affirmative one. This card
    // appears while the user is doing something else — typing in the search
    // box, writing a note — and it steals focus when it does, so the next
    // keystroke lands on whichever button is focused. A reflexive Enter must
    // not be able to approve an agent's mutation or a "delete everything".
    layer.querySelector<HTMLElement>('[data-act="deny"]')?.focus();
  });
}
