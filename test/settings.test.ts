import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

test("defaults when there is no config", () => {
  const { settings, warnings } = resolveSettings(undefined, {});
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.deepEqual(warnings, []);
});

test("valid overrides are taken", () => {
  const { settings } = resolveSettings({ maxTurns: 25, maxUnchangedTurns: 4 }, {});
  assert.equal(settings.maxTurns, 25);
  assert.equal(settings.maxUnchangedTurns, 4);
});

test("maxTurns is clamped to a hard ceiling — autopilot is never unbounded", () => {
  assert.equal(resolveSettings({ maxTurns: 100000 }, {}).settings.maxTurns, 200);
  assert.equal(resolveSettings({ maxTurns: 0 }, {}).settings.maxTurns, 1);
  assert.ok(resolveSettings({ maxTurns: 100000 }, {}).warnings.some((w) => w.includes("clamped")));
});

test("maxUnchangedTurns is clamped to 2–10", () => {
  assert.equal(resolveSettings({ maxUnchangedTurns: 1 }, {}).settings.maxUnchangedTurns, 2);
  assert.equal(resolveSettings({ maxUnchangedTurns: 50 }, {}).settings.maxUnchangedTurns, 10);
});

test("wrong types and unknown keys warn and fall back", () => {
  const { settings, warnings } = resolveSettings({ maxTurns: "lots", nope: 1 }, {});
  assert.equal(settings.maxTurns, DEFAULT_SETTINGS.maxTurns);
  assert.ok(warnings.some((w) => w.includes("must be a number")));
  assert.ok(warnings.some((w) => w.includes('unknown setting "nope"')));
});

test("PIFY_AUTOPILOT_MAX_TURNS overrides and is clamped", () => {
  assert.equal(resolveSettings({ maxTurns: 10 }, { PIFY_AUTOPILOT_MAX_TURNS: "5" }).settings.maxTurns, 5);
  assert.equal(resolveSettings(undefined, { PIFY_AUTOPILOT_MAX_TURNS: "9999" }).settings.maxTurns, 200);
  assert.ok(resolveSettings(undefined, { PIFY_AUTOPILOT_MAX_TURNS: "x" }).warnings.some((w) => w.includes("not a number")));
});
