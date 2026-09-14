# @pify/autopilot

[![CI](https://github.com/pifydev/autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/autopilot/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/autopilot)](https://www.npmjs.com/package/@pify/autopilot) [![npm downloads](https://img.shields.io/npm/dm/@pify/autopilot)](https://www.npmjs.com/package/@pify/autopilot)

Let the main [pi](https://github.com/earendil-works/pi) agent keep going on its own between turns — **opt-in, hard-capped, and never over your head**. Arm it toward a goal and it drives the next turn itself until the work is done, the cap is hit, or it stops making progress.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install autopilot`](https://github.com/pifydev/cli) or `pi install npm:@pify/autopilot`.

## Why

The suite already loop-guards *child* agents (`@pify/subagent`, `@pify/swarm`), but the *primary* session still stops after every turn and waits for you. For a well-scoped task you'd rather set it going and step away. Autopilot does that — carefully.

## Safety first

An unbounded self-driving agent is the dangerous kind, so every default is a brake:

- **Off by default.** It does nothing until you arm it with `/autopilot on`.
- **A hard turn cap** it can never exceed, even via settings (ceiling 200).
- **A no-progress breaker** — the same guard `@pify/subagent` uses — stops it the moment it repeats itself instead of working.
- **Never over your head.** While a dialog is open (an `ask_question`, a confirm), it waits rather than driving a turn.
- **A clean finish.** The agent ends its reply with `<autopilot-done>` when the task is complete, and autopilot stops.
- **Always visible.** A `🅰 autopilot N/max` footer while armed, and a notification with the reason every time it stops.

It drives each turn on `agent_settled` (fully idle) via a triggered message, so it never talks over a running turn. Arming is interactive-only, so a headless `pi -p` run never self-drives.

## Use

```
/autopilot on refactor auth.ts to use the new session API and make the tests pass
/autopilot status        # armed? turns used, goal
/autopilot off           # stop now
```

Give a goal (recommended) and it works toward that, one concrete step per turn; without one it just continues the current task. It stops on any of: the done signal, the turn cap, no progress, an error, or `/autopilot off`.

## Settings

`.pi/autopilot.json` (project) or `<agentDir>/autopilot.json` (global):

```json
{
  "maxTurns": 10,
  "maxUnchangedTurns": 3
}
```

`maxTurns` (1–200) is the hard cap per arming; `maxUnchangedTurns` (2–10) is how many turns with no real progress count as stuck. `PIFY_AUTOPILOT_MAX_TURNS` overrides the cap for one run. Bad values fall back to the defaults with a warning.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
