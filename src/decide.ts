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
