/** Queue responses contain every workflow, often many megabytes. Retain only
 * identity/presence fields and share one short-lived read per exact connection
 * and credential. Credentials are memory-only cache keys, never persisted. */
export interface ComfyQueuePresence {
  observationId: number;
  observedAt: number;
  valid: boolean;
  pendingIds: ReadonlySet<string>;
  runningIds: ReadonlySet<string>;
  taskIdByClient: ReadonlyMap<string, string>;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const queueScope = (endpoint: string, headers: Record<string, string>): string => {
  let normalized = endpoint;
  try { normalized = new URL(endpoint).href; } catch { /* transport reports invalid URLs */ }
  return JSON.stringify([normalized, Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b))]);
};

export class ComfyQueuePresenceCache {
  private entries = new Map<string, { expiresAt: number; value: Promise<ComfyQueuePresence>; pending: boolean }>();
  private nextObservationId = 0;

  get(endpoint: string, headers: Record<string, string>, load: () => Promise<unknown>, ttlMs = 1000): Promise<ComfyQueuePresence> {
    const scope = queueScope(endpoint, headers);
    const now = Date.now();
    const existing = this.entries.get(scope);
    if (existing && (existing.pending || existing.expiresAt > now)) return existing.value;
    // Expired results must not retain credentials or large numbers of old
    // endpoint identities for the lifetime of a long-running application.
    for (const [key, entry] of this.entries) if (!entry.pending && entry.expiresAt <= now) this.entries.delete(key);
    const entry = { expiresAt: 0, pending: true, value: Promise.resolve(undefined as unknown as ComfyQueuePresence) };
    entry.value = Promise.resolve().then(load).then((queue) => {
      const pendingIds = new Set<string>();
      const runningIds = new Set<string>();
      const taskIdByClient = new Map<string, string>();
      let valid = record(queue) && Array.isArray(queue.queue_pending) && Array.isArray(queue.queue_running);
      if (valid && record(queue)) for (const [field, ids] of [['queue_pending', pendingIds], ['queue_running', runningIds]] as const) {
        for (const row of queue[field] as unknown[]) {
          if (!Array.isArray(row) || !['string', 'number'].includes(typeof row[1]) || !String(row[1]).trim()) { valid = false; continue; }
          const taskId = String(row[1]);
          ids.add(taskId);
          if (record(row[3]) && typeof row[3].client_id === 'string') taskIdByClient.set(row[3].client_id, taskId);
        }
      }
      const observedAt = Date.now();
      entry.pending = false;
      entry.expiresAt = observedAt + Math.max(0, ttlMs);
      return { observationId: ++this.nextObservationId, observedAt, valid, pendingIds, runningIds, taskIdByClient };
    }).catch((error) => {
      if (this.entries.get(scope) === entry) this.entries.delete(scope);
      throw error;
    });
    this.entries.set(scope, entry);
    return entry.value;
  }

  clear() { this.entries.clear(); }
}

export const COMFY_MISSING_TASK_POLICY = Object.freeze({
  minimumTaskAgeMs: 30 * 60_000,
  observationWindowMs: 2 * 60_000,
  minimumObservations: 6,
});

/** Absence is not a generation failure. Only stop *local* monitoring after a
 * conservative uninterrupted series of successful authoritative checks. */
export class ComfyMissingTaskTracker {
  private missing = new Map<string, { firstAt: number; lastObservationId: number; count: number; identity: string }>();

  observe(taskId: string, submittedAt: number, queue: ComfyQueuePresence, now = Date.now(), identity = taskId): boolean {
    if (!queue.valid || !Number.isFinite(submittedAt) || submittedAt <= 0
      || now - submittedAt < COMFY_MISSING_TASK_POLICY.minimumTaskAgeMs) {
      this.reset(taskId);
      return false;
    }
    const found = this.missing.get(taskId);
    const previous = found?.identity === identity ? found : undefined;
    if (previous?.lastObservationId === queue.observationId) return false;
    const next = { firstAt: previous?.firstAt ?? now, lastObservationId: queue.observationId, count: (previous?.count || 0) + 1, identity };
    this.missing.set(taskId, next);
    return next.count >= COMFY_MISSING_TASK_POLICY.minimumObservations
      && now - next.firstAt >= COMFY_MISSING_TASK_POLICY.observationWindowMs;
  }

  reset(taskId: string) { this.missing.delete(taskId); }
  clear() { this.missing.clear(); }
}
