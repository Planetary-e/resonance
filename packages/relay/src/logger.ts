/**
 * Structured JSON logging. Strips vector/embedding fields to prevent data leaks.
 */

import { openBoundedDiagnostics } from './bounded-diagnostics.js';

let diagnostics: ReturnType<typeof openBoundedDiagnostics> | undefined;
export function configureServiceDiagnostics(directory: string | undefined) {
  if (!directory) return;
  if (diagnostics) throw new Error('Service diagnostics already configured');
  diagnostics = openBoundedDiagnostics(directory);
  process.once('exit', () => { try { diagnostics?.close(); } catch { /* Disposable diagnostics never authorize protocol state. */ } });
  process.on('uncaughtExceptionMonitor', error => log('error', 'uncaught_exception', { error: String(error) }));
}
export function diagnosticLogStatus() { return diagnostics?.status() ?? null; }

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
  const line = JSON.stringify(entry) + '\n';
  diagnostics?.write(line);
  process.stdout.write(line);
}
