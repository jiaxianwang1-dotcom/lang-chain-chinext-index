export interface StageLogPayload {
  stage: string;
  indexCode?: string;
  ms?: number;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export function logStage(payload: StageLogPayload): void {
  const enriched = { ts: new Date().toISOString(), ...payload };
  console.log(JSON.stringify(enriched));
}

export async function timed<T>(
  stage: string,
  indexCode: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    logStage({ stage, indexCode, ms: Date.now() - t0, ok: true });
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logStage({ stage, indexCode, ms: Date.now() - t0, ok: false, error });
    throw e;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
