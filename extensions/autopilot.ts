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

import { decide, hasDoneSignal, DONE_TOKEN } from "../src/decide.ts";
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
  let guard = new LoopGuard();
  let lastCtx: UiContext | null = null;

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
    done = false;
    stalled = false;
    turns = 0;
    if (ctx.hasUI) {
      ctx.ui.notify(`Autopilot ${reason}.`, "info");
      renderStatus(ctx);
    }
  }

  function nudgeText(): string {
    const close = `When the task is fully complete, end your reply with ${DONE_TOKEN} and stop.`;
    return goal
      ? `Keep working toward this goal, one concrete step at a time:\n${goal}\n\n${close}`
      : `Continue the current task, one concrete step at a time. ${close}`;
  }

  async function drive(ctx: UiContext): Promise<void> {
    turns++;
    renderStatus(ctx);
    try {
      await pi.sendMessage(
        { customType: NUDGE_TYPE, content: nudgeText(), display: false },
        { triggerTurn: true, deliverAs: "nextTurn" },
      );
    } catch {
      // A /reload or a busy session makes the captured handle throw; stop
      // rather than leave a half-armed loop that never advances.
      disarm(ctx, "stopped: could not drive the next turn");
    }
  }

  // ── the loop ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    const warnings = loadSettings(ctx.cwd);
    if (warnings.length > 0 && ctx.hasUI) ctx.ui.notify(`autopilot settings: ${warnings.join("; ")}`, "warning");
  });

  pi.on("ui_prompt_start", async () => {
    blocked = true;
  });
  pi.on("ui_prompt_end", async () => {
    blocked = false;
  });

  pi.on("agent_end", async (event, ctx) => {
    lastCtx = ctx;
    if (!armed) return;
    const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const content = Array.isArray(last?.content) ? (last!.content as Array<Record<string, unknown>>) : [];
    const usedTool = content.some((b) => b.type === "toolCall");
    const text = content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    if (hasDoneSignal(text)) done = true;
    // Feed the no-progress breaker; a stall stops autopilot at the next settle.
    stalled = guard.observe({ text, usedTool }).stalled;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    lastCtx = ctx;
    if (!armed) return;
    const decision = decide({ armed, turns, maxTurns: settings.maxTurns, blocked, stalled, done });
    if (decision.action === "continue") await drive(ctx);
    else if (decision.action === "stop") disarm(ctx, decision.reason);
    // "wait": stay armed, do nothing this settle
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
        turns = 0;
        done = false;
        stalled = false;
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
