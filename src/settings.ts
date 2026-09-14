/**
 * Settings for @pify/autopilot. Autonomy is opt-in per session (armed with a
 * command), so there is no "on by default" switch — only the safety bounds:
 * how many turns it may drive, and how many unchanged turns count as stuck.
 * `.pi/autopilot.json` (project) or `<agentDir>/autopilot.json` (global).
 */

export interface AutopilotSettings {
  /** Hard cap on auto-continuations per arming (1..MAX). */
  maxTurns: number;
  /** Identical/no-tool turns in a row that count as no progress → stop. */
  maxUnchangedTurns: number;
}

export const DEFAULT_SETTINGS: AutopilotSettings = {
  maxTurns: 10,
  maxUnchangedTurns: 3,
};

const LIMITS: Record<keyof AutopilotSettings, { min: number; max: number }> = {
  // A ceiling even the setting can't exceed: autopilot must never be unbounded.
  maxTurns: { min: 1, max: 200 },
  maxUnchangedTurns: { min: 2, max: 10 },
};

export function resolveSettings(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { settings: AutopilotSettings; warnings: string[] } {
  const settings: AutopilotSettings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];

  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push("settings file is not an object — ignored");
    } else {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!(key in DEFAULT_SETTINGS)) {
          warnings.push(`unknown setting "${key}"`);
          continue;
        }
        const name = key as keyof AutopilotSettings;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          warnings.push(`"${key}" must be a number — using ${DEFAULT_SETTINGS[name]}`);
          continue;
        }
        settings[name] = clamp(name, value, warnings);
      }
    }
  }

  const envMax = env.PIFY_AUTOPILOT_MAX_TURNS;
  if (envMax !== undefined && envMax !== "") {
    const n = Number(envMax);
    if (Number.isFinite(n)) settings.maxTurns = clamp("maxTurns", n, warnings);
    else warnings.push(`PIFY_AUTOPILOT_MAX_TURNS="${envMax}" is not a number — ignored`);
  }

  return { settings, warnings };
}

function clamp(name: keyof AutopilotSettings, value: number, warnings: string[]): number {
  const { min, max } = LIMITS[name];
  const c = Math.round(Math.min(max, Math.max(min, value)));
  if (c !== value) warnings.push(`"${name}" clamped to ${c} (allowed ${min}–${max})`);
  return c;
}
