// Instrumentation legere du demarrage de l'app pour diagnostiquer la lenteur
// percue. Activation : `localStorage.haiko_boot_perf = "1"` puis reload.
//
// Chaque mark log `[boot] +XXXms event ...details` avec le delta depuis le
// premier import du module (cote client). En production / desactive, c'est
// un no-op tres bon marche.

const t0 =
  typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();

function enabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage?.getItem("haiko_boot_perf") === "1") return true;
    if (window.location.search.includes("bootperf=1")) return true;
  } catch {
    /* localStorage indispo */
  }
  return false;
}

function fmt(ms: number): string {
  if (ms < 1000) return `+${ms.toFixed(0)}ms`;
  return `+${(ms / 1000).toFixed(2)}s`;
}

export function bootMark(event: string, extra?: Record<string, unknown>): void {
  if (!enabled()) return;
  const now =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  const delta = now - t0;
  const detail = extra && Object.keys(extra).length ? extra : undefined;
  if (detail) {
    console.log(`[boot] ${fmt(delta)} ${event}`, detail);
  } else {
    console.log(`[boot] ${fmt(delta)} ${event}`);
  }
}

/** Wrap an async call with start/end marks. */
export async function bootTime<T>(event: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled()) return fn();
  bootMark(`${event}:start`);
  const start =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  try {
    const res = await fn();
    const now =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    bootMark(`${event}:done`, { dur_ms: Math.round(now - start) });
    return res;
  } catch (err) {
    const now =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    bootMark(`${event}:error`, { dur_ms: Math.round(now - start), err: String(err) });
    throw err;
  }
}

if (typeof window !== "undefined" && enabled()) {
  console.log(
    "[boot] +0ms boot-perf armed (set localStorage.haiko_boot_perf=\"0\" to disable)"
  );
}
