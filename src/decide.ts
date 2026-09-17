/**
 * The one decision that matters, pure and testable: after a turn settles,
 * should autopilot drive another turn, stop, or just wait?
 *
 * The ordering encodes the safety priorities. Not armed → do nothing. The
 * agent said it is done → stop. The agent said it is blocked on the user →
 * stop (hand the decision back). Blocked on an open dialog → wait (never talk
 * over the user). No progress across recent turns → stop (it is spinning). Turn
 * budget spent → stop. Only then: continue.
 *
 * A turn that ERRORED is not a decision made here: pi runs its own retry loop
 * before it settles, so the extension records the error and short-circuits in
 * its agent_settled handler (see extensions/autopilot.ts) rather than routing
 * it through decide(), which never sees a half-retried run.
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
  /** The agent emitted the blocked token: it needs a human decision to proceed. */
  blockedByAgent: boolean;
}

export type AutopilotAction = "continue" | "stop" | "wait";

export interface AutopilotDecision {
  action: AutopilotAction;
  reason: string;
}

export function decide(state: AutopilotState): AutopilotDecision {
  if (!state.armed) return { action: "wait", reason: "not armed" };
  if (state.done) return { action: "stop", reason: "the agent reported the task complete" };
  if (state.blockedByAgent) return { action: "stop", reason: "stopped: the agent needs your input" };
  if (state.blocked) return { action: "wait", reason: "waiting on your answer" };
  if (state.stalled) return { action: "stop", reason: "stopped: no progress across recent turns" };
  if (state.turns >= state.maxTurns) {
    return { action: "stop", reason: `stopped: reached the ${state.maxTurns}-turn limit` };
  }
  return { action: "continue", reason: `continuing (turn ${state.turns + 1}/${state.maxTurns})` };
}

/** The token the agent ends its reply with to end autopilot cleanly. */
export const DONE_TOKEN = "<autopilot-done>";

/** The token the agent ends its reply with to hand a decision back to the user. */
export const BLOCKED_TOKEN = "<autopilot-blocked>";

/**
 * The last non-empty line of a reply, lowercased with trailing markdown/emphasis
 * and sentence punctuation stripped. Matching a control token is anchored to
 * THIS line, not the whole reply: a model that restates the instruction mid-plan
 * ("I'll end with <autopilot-done> once tests pass") must not end autopilot on
 * turn one. Only the token sitting on its own final line counts — including when
 * the model decorates it as "`<autopilot-done>`", "<autopilot-done>." or bold.
 */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line !== "") return line.toLowerCase().replace(/[\s`*_~.,!?;:)\]}"']+$/, "");
  }
  return "";
}

export function hasDoneSignal(text: string): boolean {
  return lastLine(text).endsWith(DONE_TOKEN);
}

export function hasBlockedSignal(text: string): boolean {
  return lastLine(text).endsWith(BLOCKED_TOKEN);
}

/** What autopilot reads back out of one finished agent run. */
export interface TurnSummary {
  /** Visible text of the final assistant message — what the loop guard fingerprints. */
  text: string;
  /** Did any message in the run call or run a tool? A tool call is forward progress. */
  usedTool: boolean;
  /** The user interrupted the run (Esc/abort) rather than the agent finishing it. */
  aborted: boolean;
  /** The run ended on a provider/model error (pi's own retries were exhausted). */
  errored: boolean;
  /** The provider error text, when the run errored; "" otherwise. */
  errorMessage: string;
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
 *   - `errored` mirrors a LAST assistant message flagged `"error"` (pi ends the
 *     run on it after exhausting its own retries; an error before streaming has
 *     empty content, so `text` is "" and the loop guard would treat it as a
 *     silent turn). The caller stops on it so autopilot does not re-drive a dead
 *     provider up to the turn cap. `errorMessage` carries pi's error text.
 */
export function summarizeTurn(messages: readonly unknown[]): TurnSummary {
  let usedTool = false;
  let lastAssistant: { content?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
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
  const errored = lastAssistant?.stopReason === "error";
  const errorMessage = errored && typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : "";
  return { text, usedTool, aborted, errored, errorMessage };
}

/**
 * Any session_start under a still-armed pilot means the pilot must stand down:
 * a /new, /resume or fork swaps the session out from under it, chasing the
 * previous session's stale goal. A /reload cannot reach here armed — it
 * re-instantiates the extension, so `armed` starts false again (autopilot is
 * silently disarmed by a reload). The reason therefore does not matter; reset
 * whenever we are still armed.
 */
export function shouldResetOnSessionStart(armed: boolean): boolean {
  return armed;
}
