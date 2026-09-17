import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, hasDoneSignal, hasBlockedSignal, DONE_TOKEN, BLOCKED_TOKEN } from "../src/decide.ts";

const s = (over = {}) => ({
  armed: true,
  turns: 0,
  maxTurns: 10,
  blocked: false,
  stalled: false,
  done: false,
  blockedByAgent: false,
  ...over,
});

test("continues when armed, under cap, making progress, not blocked", () => {
  const d = decide(s());
  assert.equal(d.action, "continue");
  assert.match(d.reason, /turn 1\/10/);
});

test("does nothing when not armed", () => {
  assert.equal(decide(s({ armed: false })).action, "wait");
});

test("the done signal stops it, ahead of everything else", () => {
  assert.equal(decide(s({ done: true, turns: 99, stalled: true })).action, "stop");
  assert.match(decide(s({ done: true })).reason, /complete/);
});

test("a pending user dialog makes it wait, never talk over the user", () => {
  const d = decide(s({ blocked: true }));
  assert.equal(d.action, "wait");
  assert.match(d.reason, /waiting on your answer/);
});

test("a stall stops it", () => {
  assert.equal(decide(s({ stalled: true })).action, "stop");
  assert.match(decide(s({ stalled: true })).reason, /no progress/);
});

test("the turn cap is a hard stop", () => {
  assert.equal(decide(s({ turns: 10, maxTurns: 10 })).action, "stop");
  assert.equal(decide(s({ turns: 9, maxTurns: 10 })).action, "continue");
});

test("blocked takes priority over a stall or the cap (wait, don't stop)", () => {
  assert.equal(decide(s({ blocked: true, stalled: true, turns: 100 })).action, "wait");
});

test("the done token is detected case-insensitively", () => {
  assert.ok(hasDoneSignal(`all set ${DONE_TOKEN}`));
  assert.ok(hasDoneSignal("done here <AUTOPILOT-DONE>"));
  assert.ok(!hasDoneSignal("still working"));
});

// ── f033: the done token is matched on the LAST line, not anywhere in the text ──

test("restating the instruction mid-reply is NOT the done signal", () => {
  const restated = `Plan: I'll end with ${DONE_TOKEN} once the tests pass.\nStarting step 1 now.`;
  assert.ok(!hasDoneSignal(restated));
});

test("the done token on its own final line is the done signal, decorations and all", () => {
  assert.ok(hasDoneSignal(`Fixed the bug and tests pass.\n\n${DONE_TOKEN}`));
  assert.ok(hasDoneSignal(`${DONE_TOKEN}.`), "trailing period");
  assert.ok(hasDoneSignal("`<autopilot-done>`"), "wrapped in code ticks");
  assert.ok(hasDoneSignal("**<autopilot-done>**"), "bold");
});

// ── f034: a distinct blocked token hands the decision back to the user ──

test("the blocked token is a stop, ahead of a plain dialog/stall/cap", () => {
  const d = decide(s({ blockedByAgent: true, blocked: true, stalled: true, turns: 100 }));
  assert.equal(d.action, "stop");
  assert.match(d.reason, /needs your input/);
});

test("the done token still wins over the blocked token", () => {
  assert.equal(decide(s({ done: true, blockedByAgent: true })).reason, "the agent reported the task complete");
});

test("hasBlockedSignal follows the same last-line rule as done", () => {
  assert.ok(hasBlockedSignal(`I need the staging DB URL to continue.\n${BLOCKED_TOKEN}`));
  assert.ok(hasBlockedSignal(`${BLOCKED_TOKEN}.`));
  assert.ok(!hasBlockedSignal(`I'll write ${BLOCKED_TOKEN} if I get stuck, but first let me try.`));
  assert.ok(!hasBlockedSignal("no token at all"));
});
