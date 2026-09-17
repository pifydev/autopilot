import { test } from "node:test";
import assert from "node:assert/strict";
import autopilot from "../extensions/autopilot.ts";
import { StubHost } from "./host.ts";
import { DONE_TOKEN, BLOCKED_TOKEN } from "../src/decide.ts";

/** pi message shapes at the agent_end boundary. */
const errorRun = (msg = "429 rate limited") => ({
  messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: msg }],
});
const okRun = (t = "ok") => ({ messages: [{ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop" }] });
const textRun = (t: string) => ({ messages: [{ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop" }] });

/** Arm autopilot the way a user does; returns the wired stub host. */
async function armed(goal = "migrate the auth module"): Promise<StubHost> {
  const host = new StubHost();
  autopilot(host.api as never);
  await host.run("autopilot", `on ${goal}`);
  return host;
}

// ── f033 / f034: the nudge documents both escape hatches and forbids loose use ──

test("the nudge names the done and blocked tokens and forbids writing them otherwise", async () => {
  const host = await armed();
  assert.ok(host.lastNudge.includes(DONE_TOKEN), "done token");
  assert.ok(host.lastNudge.includes(BLOCKED_TOKEN), "blocked token");
  assert.match(host.lastNudge, /not write (each|either) token for any other reason|for any other reason/i);
});

// ── f032: an errored turn does not disarm on the first attempt (pi may retry) ──

test("error agent_end then a recovered agent_end then settle → keeps going", async () => {
  const host = await armed();
  assert.equal(host.sent.length, 1, "arming drives one turn");
  await host.fire("agent_end", errorRun()); // pi will retry this
  await host.fire("agent_end", okRun()); // the retry succeeded; overwrites the error
  await host.fire("agent_settled");
  assert.equal(host.sent.length, 2, "a recovered error must not stop autopilot");
  assert.ok(!host.notices.some((n) => /last turn failed/.test(n.message)), "no failure notice");
});

test("error agent_end then settle (retries exhausted) → disarms with the message", async () => {
  const host = await armed();
  await host.fire("agent_end", errorRun("401 unauthorized"));
  await host.fire("agent_settled");
  assert.equal(host.sent.length, 1, "must not re-drive a dead provider");
  const notice = host.notices.at(-1)!.message;
  assert.match(notice, /last turn failed/);
  assert.match(notice, /401 unauthorized/);
  // Disarmed: a further settle drives nothing.
  await host.fire("agent_settled");
  assert.equal(host.sent.length, 1);
});

// ── f034: the blocked token stops with "needs your input", never "complete" ──

test("a blocked-token turn disarms with the needs-input reason", async () => {
  const host = await armed();
  await host.fire("agent_end", textRun(`I need the staging DB URL to proceed.\n${BLOCKED_TOKEN}`));
  await host.fire("agent_settled");
  assert.equal(host.sent.length, 1, "does not drive again");
  const notice = host.notices.at(-1)!.message;
  assert.match(notice, /needs your input/);
  assert.doesNotMatch(notice, /reported complete/);
});

test("a plain question with no token is still re-driven (the token is the only hatch)", async () => {
  const host = await armed();
  await host.fire("agent_end", textRun("Should I use sessions or JWTs here?"));
  await host.fire("agent_settled");
  assert.equal(host.sent.length, 2, "without the blocked token autopilot keeps going");
});

// ── f035: a settle parked on an open dialog resumes when the dialog closes ──

test("a settle blocked by a dialog resumes on ui_prompt_end", async () => {
  const host = await armed();
  await host.fire("ui_prompt_start");
  await host.fire("agent_settled"); // blocked → wait → parked
  assert.equal(host.sent.length, 1, "does not drive over the open dialog");
  await host.fire("ui_prompt_end"); // dialog closed while idle → resume
  assert.equal(host.sent.length, 2, "parked pilot resumes when the dialog closes");
});

test("a dialog closing mid-run (not idle) does not double-drive", async () => {
  const host = await armed();
  await host.fire("ui_prompt_start");
  await host.fire("agent_settled"); // parked
  host.idle = false; // the turn is still running behind the dialog
  await host.fire("ui_prompt_end");
  assert.equal(host.sent.length, 1, "the running turn will settle on its own; no extra drive");
});

// ── f036: a session swap under an armed pilot disarms it ──

test("session_start under an armed pilot disarms it", async () => {
  const host = await armed();
  await host.fire("session_start", { reason: "new" });
  await host.fire("agent_settled");
  assert.equal(host.sent.length, 1, "the disarmed pilot drives nothing");
  assert.ok(host.notices.some((n) => /disarmed: new session/.test(n.message)));
});
