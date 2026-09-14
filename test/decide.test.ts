import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, hasDoneSignal, DONE_TOKEN } from "../src/decide.ts";

const s = (over = {}) => ({ armed: true, turns: 0, maxTurns: 10, blocked: false, stalled: false, done: false, ...over });

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
