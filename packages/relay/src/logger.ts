/**
 * Structured JSON logging. Strips vector/embedding fields to prevent data leaks.
 */

type LogLevel = 'info' | 'warn' | 'error';

function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'vector' || key === 'embedding' || key === 'perturbed') continue;
    clean[key] = value;
  }
  return clean;
}

export function log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(data ? sanitize(data) : {}),
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}
