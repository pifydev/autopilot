/**
 * @pify/autopilot — let the main agent keep going on its own, safely.
 *
 * The suite loop-guards CHILD agents (subagent/swarm) but nothing keeps the
 * PRIMARY session moving without you pressing enter each turn. This does — and
 * because an unbounded self-driving agent is the dangerous kind, every default
 * here is a brake:
 *
 *   - OFF by default; you arm it explicitly with `/autopilot on [goal]`.
 *   - a hard turn cap (maxTurns) it can never exceed, even via settings;
 *   - a no-progress breaker (the same LoopGuard subagent uses) that stops it
 *     the moment it repeats itself instead of working;
 *   - it never drives a turn while a dialog is open (you are being asked
 *     something), and it stops the instant the agent emits the done token;
 *   - a visible footer while armed, and a notification with the reason whenever
 *     it stops.
 *
 * It drives a turn on `agent_settled` (fully idle) via sendMessage triggerTurn,
 * so it never talks over a running turn. Zero runtime dependencies.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  decide,
  hasDoneSignal,
  hasBlockedSignal,
  summarizeTurn,
  shouldResetOnSessionStart,
  DONE_TOKEN,
  BLOCKED_TOKEN,
} from "../src/decide.ts";
import { DEFAULT_SETTINGS, resolveSettings, type AutopilotSettings } from "../src/settings.ts";
import { LoopGuard } from "../src/loop-guard.ts";

type UiContext = ExtensionContext;
const STATUS = "autopilot";
const NUDGE_TYPE = "pify-autopilot-nudge";

export default function autopilot(pi: ExtensionAPI) {
  let settings: AutopilotSettings = DEFAULT_SETTINGS;
  let armed = false;
  let turns = 0;
  let goal: string | null = null;
  let blocked = false;
  let done = false;
  let stalled = false;
  // The agent asked to hand a decision back to the user (emitted BLOCKED_TOKEN).
  let blockedByAgent = false;
  // The last settled run ended on a provider/model error pi could not retry away.
  // Recorded in agent_end (a successful retry's agent_end overwrites it) and acted
  // on in the settle handler — never inside agent_end, which fires BEFORE pi
  // decides whether to auto-retry, so a transient 429 must not disarm on sight.
  let lastErrored = false;
  let lastError = "";
  // A settle returned "wait" (a dialog was open); resume when the dialog closes.
  let parked = false;
  let guard = new LoopGuard();
  let lastCtx: UiContext | null = null;

  function resetRunState(): void {
    turns = 0;
    done = false;
    stalled = false;
    blockedByAgent = false;
    lastErrored = false;
    lastError = "";
    parked = false;
  }

  function loadSettings(cwd: string): string[] {
    for (const file of [join(cwd, ".pi", "autopilot.json"), join(getAgentDir(), "autopilot.json")]) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = resolveSettings(JSON.parse(raw));
        settings = parsed.settings;
        return parsed.warnings;
      } catch (err) {
        settings = DEFAULT_SETTINGS;
        return [`${file}: ${err instanceof Error ? err.message : String(err)}`];
      }
    }
    settings = resolveSettings(undefined).settings;
    return [];
  }

  function renderStatus(ctx: UiContext | null = lastCtx): void {
    if (!ctx || !ctx.hasUI) return;
    ctx.ui.setStatus(STATUS, armed ? `🅰 autopilot ${turns}/${settings.maxTurns}` : undefined);
  }

  function disarm(ctx: UiContext, reason: string): void {
    if (!armed) return;
    armed = false;
    goal = null;
    resetRunState();
    if (ctx.hasUI) {
      ctx.ui.notify(`Autopilot ${reason}.`, "info");
      renderStatus(ctx);
    }
  }

  function nudgeText(): string {
    // Two escape hatches, each anchored to the final line so a mid-reply mention
    // does not trip them: done when finished, blocked when only the user can
    // decide. Without the blocked token a genuine question just gets re-nudged
    // until the cap, so spell it out — and forbid writing either token loosely.
    const close =
      `When the task is fully complete, end your reply with ${DONE_TOKEN} and stop. ` +
      `If you cannot proceed without a decision or information only the user can give, ` +
      `state exactly what you need and end your reply with ${BLOCKED_TOKEN} instead. ` +
      `Write each token only as the very last thing in your reply, and do not write ` +
      `either token for any other reason.`;
    return goal
      ? `Keep working toward this goal, one concrete step at a time:\n${goal}\n\n${close}`
      : `Continue the current task, one concrete step at a time. ${close}`;
  }

  async function drive(ctx: UiContext): Promise<void> {
    turns++;
    parked = false; // we are advancing now; nothing to resume later
    renderStatus(ctx);
    try {
      // deliverAs "followUp" (not "nextTurn"): while idle, pi runs a message
      // delivered as followUp/steer immediately (triggerTurn → _runAgentPrompt),
      // whereas a "nextTurn" message is only QUEUED into whatever turn starts
      // next and never drives one itself — which meant autopilot armed but never
      // actually advanced. followUp is what @pify/goal uses to self-drive too.
      await pi.sendMessage(
        { customType: NUDGE_TYPE, content: nudgeText(), display: false },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // A /reload or a busy session makes the captured handle throw; stop
      // rather than leave a half-armed loop that never advances.
      disarm(ctx, "stopped: could not drive the next turn");
    }
  }

  // ── the loop ─────────────────────────────────────────────────────────

  // Decide and act after a run has fully settled (or a blocking dialog closed).
  // Shared by agent_settled and ui_prompt_end so both take the same safe path.
  async function settle(ctx: UiContext): Promise<void> {
    if (!armed) return;
    // A run that ERRORED after pi exhausted its own retries: stop rather than
    // re-drive a dead provider to the turn cap. Checked before decide() because
    // an errored run carries no signal decide() understands (its text is empty).
    if (lastErrored) {
      disarm(ctx, `stopped: the last turn failed: ${lastError || "unknown error"}`);
      return;
    }
    const decision = decide({ armed, turns, maxTurns: settings.maxTurns, blocked, stalled, done, blockedByAgent });
    if (decision.action === "continue") await drive(ctx);
    else if (decision.action === "stop") disarm(ctx, decision.reason);
    else parked = true; // "wait": a dialog is open — resume when it closes
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    // Any session_start under a still-armed pilot means stand down: a /new,
    // /resume or fork replaces the session, so the pilot would drive a fresh,
    // unrelated session toward the old goal. (A /reload re-instantiates the
    // extension, so it never reaches here armed — it disarms silently.)
    if (shouldResetOnSessionStart(armed)) {
      armed = false;
      goal = null;
      resetRunState();
      guard = new LoopGuard();
      if (ctx.hasUI) {
        ctx.ui.notify("Autopilot disarmed: new session.", "info");
        renderStatus(ctx);
      }
    }
    const warnings = loadSettings(ctx.cwd);
    if (warnings.length > 0 && ctx.hasUI) ctx.ui.notify(`autopilot settings: ${warnings.join("; ")}`, "warning");
  });

  pi.on("ui_prompt_start", async () => {
    blocked = true;
  });
  pi.on("ui_prompt_end", async (_event, ctx) => {
    lastCtx = ctx;
    blocked = false;
    // If a settle already parked us on this dialog, the settle that cleared it
    // will never fire again on its own (ui_prompt_end only flips the flag), so
    // re-decide here. Guarded by `parked` (only a prior "wait" sets it) and by
    // isIdle() so a dialog closing mid-run — where the turn resumes and will
    // settle on its own — does not double-drive.
    if (armed && parked && ctx.isIdle()) {
      parked = false;
      await settle(ctx);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    lastCtx = ctx;
    if (!armed) return;
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    const turn = summarizeTurn(messages);
    // You pressed Esc: never re-drive an interrupted turn — disarm instead.
    if (turn.aborted) {
      disarm(ctx, "stopped: you interrupted");
      return;
    }
    if (hasDoneSignal(turn.text)) done = true;
    // The agent handed a decision back to the user; stop at the next settle with
    // a "needs your input" reason, never the misleading "reported complete".
    if (hasBlockedSignal(turn.text)) blockedByAgent = true;
    // Record (do not act on) an errored run: pi emits this agent_end BEFORE it
    // decides to auto-retry, so a transient failure pi recovers from will emit a
    // fresh, non-error agent_end that overwrites these. The settle handler, which
    // fires only after retries are exhausted, is where we act on it.
    lastErrored = turn.errored;
    lastError = turn.errorMessage;
    // Feed the no-progress breaker; a stall stops autopilot at the next settle.
    // usedTool is read across the whole run (see summarizeTurn) — the final
    // assistant message never carries a tool call, so reading only it would make
    // this always false and silently disable the stall guard's progress reset.
    stalled = guard.observe({ text: turn.text, usedTool: turn.usedTool }).stalled;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    lastCtx = ctx;
    await settle(ctx);
  });

  pi.registerCommand("autopilot", {
    description: "Keep the agent going on its own: /autopilot [on [goal] | off | status]",
    handler: async (args, ctx: UiContext) => {
      if (!ctx.hasUI) return; // arming is interactive-only; headless never self-drives
      lastCtx = ctx;
      const [verb, ...rest] = (args ?? "").trim().split(/\s+/);
      const v = (verb ?? "").toLowerCase();

      if (v === "off") {
        if (armed) disarm(ctx, "off");
        else ctx.ui.notify("Autopilot is already off.", "info");
        return;
      }
      if (v === "" || v === "status") {
        ctx.ui.notify(
          armed
            ? `Autopilot on: ${turns}/${settings.maxTurns} turns used${goal ? `, goal: ${goal}` : ""}.`
            : `Autopilot off. Arm with /autopilot on [goal]. Caps: ${settings.maxTurns} turns, stop after ${settings.maxUnchangedTurns} unchanged.`,
          "info",
        );
        return;
      }
      if (v === "on") {
        armed = true;
        resetRunState();
        guard = new LoopGuard({ repeat: settings.maxUnchangedTurns });
        goal = rest.join(" ").trim() || null;
        ctx.ui.notify(`Autopilot on (cap ${settings.maxTurns} turns)${goal ? `, working toward: ${goal}` : ""}.`, "info");
        await drive(ctx); // start working immediately
        return;
      }
      ctx.ui.notify("Usage: /autopilot [on [goal] | off | status]", "warning");
    },
  });
}
