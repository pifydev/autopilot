import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeTurn, shouldResetOnSessionStart, hasDoneSignal } from "../src/decide.ts";

/** Minimal stand-ins for pi's message shapes at the agent_end boundary. */
const assistant = (
  blocks: Array<{ type: string; text?: string; name?: string }>,
  stopReason = "stop",
) => ({ role: "assistant", content: blocks, stopReason });
const text = (t: string) => ({ type: "text", text: t });
const toolCall = (name = "bash") => ({ type: "toolCall", id: "c1", name, arguments: {} });
const toolResult = () => ({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], isError: false });
const user = (t: string) => ({ role: "user", content: t });

// ── bug 2: usedTool must be read across the whole run, not the last block ──

test("usedTool is true when an EARLIER assistant message called a tool", () => {
  // pi ends a run on a tool-free assistant message, so the final block never
  // carries a toolCall. The old code read only that block → always false.
  const run = [
    assistant([text("Let me look."), toolCall()], "toolUse"),
    toolResult(),
    assistant([text("Done looking, here is the summary.")], "stop"),
  ];
  const turn = summarizeTurn(run);
  assert.equal(turn.usedTool, true, "tool use earlier in the run must count as progress");
});

test("usedTool is true from a toolResult message even without a visible toolCall block", () => {
  const run = [toolResult(), assistant([text("finished")], "stop")];
  assert.equal(summarizeTurn(run).usedTool, true);
});

test("usedTool is false for a talk-only run (this is what the stall guard watches)", () => {
  const run = [assistant([text("I will now fix the bug.")], "stop")];
  const turn = summarizeTurn(run);
  assert.equal(turn.usedTool, false);
  assert.equal(turn.text, "I will now fix the bug.");
});

test("text is taken from the LAST assistant message and joins its text blocks", () => {
  const run = [
    assistant([text("first")], "toolUse"),
    toolResult(),
    assistant([text("line one"), text("line two")], "stop"),
  ];
  assert.equal(summarizeTurn(run).text, "line one\nline two");
});

// ── bug 1: an aborted run must be detectable so autopilot can disarm ──

test("aborted is true when the last assistant message stopReason is 'aborted'", () => {
  const run = [
    assistant([text("working"), toolCall()], "toolUse"),
    toolResult(),
    assistant([text("partial answer interrupted")], "aborted"),
  ];
  assert.equal(summarizeTurn(run).aborted, true);
});

test("aborted is false for a normally finished run", () => {
  assert.equal(summarizeTurn([assistant([text("all good")], "stop")]).aborted, false);
});

test("summarizeTurn tolerates an empty run and non-object entries", () => {
  assert.deepEqual(summarizeTurn([]), { text: "", usedTool: false, aborted: false, errored: false, errorMessage: "" });
  assert.deepEqual(summarizeTurn([null, 42, "x", user("hi")]), {
    text: "",
    usedTool: false,
    aborted: false,
    errored: false,
    errorMessage: "",
  });
});

// ── f032: an errored run must be detectable so autopilot can stop, not re-drive ──

test("errored is true (with its message) when the last assistant stopReason is 'error'", () => {
  // pi ends a run on an error assistant message after exhausting its own retries;
  // an error before streaming has empty content, so text is "".
  const run = [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" }];
  const turn = summarizeTurn(run);
  assert.equal(turn.errored, true);
  assert.equal(turn.errorMessage, "429 rate limited");
  assert.equal(turn.text, "");
});

test("errored is false and errorMessage empty for a normally finished run", () => {
  const turn = summarizeTurn([assistant([text("all good")], "stop")]);
  assert.equal(turn.errored, false);
  assert.equal(turn.errorMessage, "");
});

test("the done token is still detected in the summarized text", () => {
  const run = [assistant([text("all set <autopilot-done>")], "stop")];
  assert.ok(hasDoneSignal(summarizeTurn(run).text));
});

// ── bug 3 / f036: armed state must not survive a session swap ──
// A /reload re-instantiates the extension (armed starts false again), so the
// reason no longer matters: reset whenever a session_start finds us still armed.

test("shouldResetOnSessionStart disarms whenever still armed", () => {
  assert.equal(shouldResetOnSessionStart(true), true);
});

test("shouldResetOnSessionStart is a no-op when autopilot was never armed", () => {
  assert.equal(shouldResetOnSessionStart(false), false);
});
