import type { StateMachine } from '../../engine/types';

/**
 * §5.6's author-time *warnings*. Deliberately not in `schema.ts`: `validateDefinition` has no
 * warning channel, and these are shapes a designer may legitimately be halfway through authoring —
 * blocking a save on "End is not reachable yet" would make the machine impossible to build.
 *
 * The hard rules (Start has no `enterableFrom`, End has no `exitableTo`, no one-sided edges) stay
 * errors in the schema, and surface on the rail badge instead.
 */
export function machineWarnings(machine: StateMachine): string[] {
  const byId = new Map(machine.states.map((s) => [s.id, s]));
  const warnings: string[] = [];

  // Reachability from Start, following legal transitions only.
  const seen = new Set<string>([machine.startStateId]);
  const queue = [machine.startStateId];
  while (queue.length > 0) {
    const current = byId.get(queue.shift()!);
    if (!current) continue;
    for (const next of current.exitableTo) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  if (!seen.has(machine.endStateId)) {
    warnings.push('End cannot be reached from Start — no sequence of transitions gets there, so the game can never finish on its own.');
  }

  for (const state of machine.states) {
    if (state.id === machine.startStateId) continue;
    if (state.enterableFrom.length === 0) {
      warnings.push(`Nothing can enter “${state.name}” — it has no inbound transition.`);
    } else if (!seen.has(state.id)) {
      warnings.push(`“${state.name}” cannot be reached from Start.`);
    }
  }

  return warnings;
}
