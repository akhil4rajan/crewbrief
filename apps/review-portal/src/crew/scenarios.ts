/** Scripted demo briefings (src/demo/scenarios/*.json), used to pre-fill and play a briefing. */
export interface ScenarioLine {
  speaker: string;
  at_ms: number;
  text: string;
}

export interface Scenario {
  id: string;
  title: string;
  task_type: string;
  location: string;
  crew: string[];
  summary: string;
  lines: ScenarioLine[];
}

const modules = import.meta.glob<{ default: Scenario }>("../demo/scenarios/*.json", { eager: true });

export const SCENARIOS: Scenario[] = Object.keys(modules)
  .sort()
  .map((path) => modules[path].default);

export function scenarioById(id: string | null | undefined): Scenario | undefined {
  return id ? SCENARIOS.find((s) => s.id === id) : undefined;
}

const KEY = (sessionId: string) => `crewbrief.scenario.${sessionId}`;

/** Remember which scenario a session was created from, so the briefing screen can play it. */
export function rememberScenario(sessionId: string, scenarioId: string | null): void {
  try {
    if (scenarioId) localStorage.setItem(KEY(sessionId), scenarioId);
    else localStorage.removeItem(KEY(sessionId));
  } catch {
    // Storage unavailable: the user can still pick the scenario on the briefing screen.
  }
}

export function storedScenario(sessionId: string): string | null {
  try {
    return localStorage.getItem(KEY(sessionId));
  } catch {
    return null;
  }
}
