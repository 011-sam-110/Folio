// Whether the AI gateway is actually reachable, shared across every AI affordance.
//
// The user's on/off switch (aiPrefs) says whether they WANT AI. This says whether it
// would work. Both matter: without the health signal, a deployment with no reachable
// gateway still renders every AI button, and each one fails only after the user
// clicks it and waits. Dead controls that look live are worse than absent ones.
import { useEffect, useState } from 'react';
import { api } from './api';
import { useAiEnabled } from './aiPrefs';

export type AiStatus = 'pending' | 'ok' | 'bad';

export interface AiHealth {
  status: AiStatus;
  model?: string;
  error?: string;
}

// One probe serves the whole app. Several AI components mount at once, and each
// running its own health check would mean redundant round trips on every render.
let cached: AiHealth = { status: 'pending' };
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function probe(): Promise<void> {
  inFlight ??= api
    .aiHealth()
    .then((r) => {
      cached = r.ok
        ? { status: 'ok', model: r.model }
        : { status: 'bad', error: r.error };
    })
    .catch((e: unknown) => {
      cached = { status: 'bad', error: e instanceof Error ? e.message : 'unreachable' };
    })
    .finally(() => {
      inFlight = null;
      emit();
    });
  return inFlight;
}

/** Force a re-probe — used by the sidebar's manual retry. */
export function refreshAiHealth(): Promise<void> {
  cached = { status: 'pending' };
  emit();
  return probe();
}

export function useAiHealth(): AiHealth {
  const [health, setHealth] = useState(cached);
  useEffect(() => {
    const l = () => setHealth(cached);
    listeners.add(l);
    if (cached.status === 'pending' && !inFlight) void probe();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return health;
}

/**
 * Should AI affordances be rendered at all?
 *
 * Deliberately optimistic while the probe is in flight: hiding AI on first paint
 * and popping it back a moment later is a worse flicker than the reverse, and the
 * healthy case is the common one. Once the probe says `bad`, the affordances go.
 */
export function useAiAvailable(): boolean {
  const [enabled] = useAiEnabled();
  const health = useAiHealth();
  return enabled && health.status !== 'bad';
}
