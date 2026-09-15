/**
 * The one decision that matters, pure and testable: after a turn settles,
 * should autopilot drive another turn, stop, or just wait?
 *
 * The ordering encodes the safety priorities. Not armed → do nothing. The
 * agent said it is done → stop. Blocked on a human question → wait (never talk
 * over the user). No progress across recent turns → stop (it is spinning). Turn
 * budget spent → stop. Only then: continue.
 */

export interface AutopilotState {
  /** Explicitly turned on by the user this session. Off by default. */
  armed: boolean;
  /** Auto-continuations driven so far this run. */
  turns: number;
  /** Hard ceiling on auto-continuations. */
  maxTurns: number;
  /** A user-facing dialog is open — do not drive a turn over it. */
  blocked: boolean;
  /** The no-progress breaker flagged a stall (see loop-guard.ts). */
  stalled: boolean;
  /** The agent emitted the completion token. */
  done: boolean;
}

export type AutopilotAction = "continue" | "stop" | "wait";

export interface AutopilotDecision {
  action: AutopilotAction;
  reason: string;
}

export function decide(state: AutopilotState): AutopilotDecision {
  if (!state.armed) return { action: "wait", reason: "not armed" };
  if (state.done) return { action: "stop", reason: "the agent reported the task complete" };
  if (state.blocked) return { action: "wait", reason: "waiting on your answer" };
  if (state.stalled) return { action: "stop", reason: "stopped: no progress across recent turns" };
  if (state.turns >= state.maxTurns) {
    return { action: "stop", reason: `stopped: reached the ${state.maxTurns}-turn limit` };
  }
  return { action: "continue", reason: `continuing (turn ${state.turns + 1}/${state.maxTurns})` };
}

/** The token the agent ends its reply with to end autopilot cleanly. */
export const DONE_TOKEN = "<autopilot-done>";

export function hasDoneSignal(text: string): boolean {
  return text.toLowerCase().includes(DONE_TOKEN);
}

/** What autopilot reads back out of one finished agent run. */
export interface TurnSummary {
  /** Visible text of the final assistant message — what the loop guard fingerprints. */
  text: string;
  /** Did any message in the run call or run a tool? A tool call is forward progress. */
  usedTool: boolean;
  /** The user interrupted the run (Esc/abort) rather than the agent finishing it. */
  aborted: boolean;
}

function isBlockType(block: unknown, type: string): boolean {
  return typeof block === "object" && block !== null && (block as { type?: unknown }).type === type;
}

/**
 * Reduce an `agent_end` run (its full list of new messages) to the three facts
 * autopilot acts on. Pure, so it is unit-testable without a live agent.
 *
 * Two subtleties this encodes, both from real pi behaviour:
 *   - `usedTool` is computed across the WHOLE run, not just the final assistant
 *     message. pi ends a run on an assistant message that made no tool calls
 *     (that is precisely why the loop stopped), so the last content block never
 *     carries a `toolCall`; the tool work lives in earlier assistant messages
 *     and in `toolResult` messages. Reading only the last block leaves it
 *     permanently false, which silently kills the stall guard's progress reset.
 *   - `aborted` mirrors the LAST assistant message's `stopReason`. When you press
 *     Esc, pi ends the run with that message flagged `"aborted"`; re-driving it
 *     would fight the interrupt, so the caller disarms instead of continuing.
 */
export function summarizeTurn(messages: readonly unknown[]): TurnSummary {
  let usedTool = false;
  let lastAssistant: { content?: unknown; stopReason?: unknown } | undefined;
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as { role?: unknown; content?: unknown; stopReason?: unknown };
    if (m.role === "toolResult") {
      usedTool = true;
      continue;
    }
    if (m.role === "assistant") {
      lastAssistant = m;
      if (Array.isArray(m.content) && m.content.some((b) => isBlockType(b, "toolCall"))) usedTool = true;
    }
  }
  const content = Array.isArray(lastAssistant?.content) ? (lastAssistant!.content as unknown[]) : [];
  const text = content
    .filter((b) => isBlockType(b, "text") && typeof (b as { text?: unknown }).text === "string")
    .map((b) => (b as { text: string }).text)
    .join("\n");
  const aborted = lastAssistant?.stopReason === "aborted";
  return { text, usedTool, aborted };
}

/**
 * A /new, /resume, or fork swaps the session out from under a still-armed
 * autopilot; only a /reload keeps the same session alive. So on any start reason
 * except "reload", a session that is still armed is chasing the previous
 * session's stale goal and must be disarmed.
 */
export function shouldResetOnSessionStart(armed: boolean, reason: string): boolean {
  return armed && reason !== "reload";
}
