/** Retain known history locations when later desktop selections replace earlier ones. */
import { canonicalHistorySetupPath, measureStorageDirectories, parseStorageDirectories } from '@resonance/relay';
import { readHistoryVolunteerConfigurationFile } from '../../../relay/src/history-volunteer-config.js';
import type { RelayConfig } from './session.js';

export function relayStorageDirectories(config: RelayConfig, runtimeDirectory: string): string[] {
  const directories = [runtimeDirectory, ...(config.historyStorageDirectories ?? [])];
  if (config.runtime?.admissionHistoryDirectory) directories.push(config.runtime.admissionHistoryDirectory);
  if (config.historyActivationInput) directories.push(config.historyActivationInput.historyDirectory);
  if (config.historyVolunteerActivationInput) directories.push(config.historyVolunteerActivationInput.directory);
  else if (config.runtime?.historyVolunteerFile) directories.push(readHistoryVolunteerConfigurationFile(config.runtime.historyVolunteerFile).directory);
  if (config.historyRecoveryInput) directories.push(config.historyRecoveryInput.workspaceDirectory, config.historyRecoveryInput.historyDirectory);
  if (config.historySetupInput && config.historySetupInput.role !== 'configuration') directories.push(config.historySetupInput.directory);
  return parseStorageDirectories([...new Set(directories.map(canonicalHistorySetupPath))]);
}
export function retainRelayStorageDirectories(next: RelayConfig, previous: RelayConfig | undefined, runtimeDirectory: string): RelayConfig {
  const directories = [...new Set([...relayStorageDirectories(next, runtimeDirectory),
    ...(previous ? relayStorageDirectories(previous, runtimeDirectory) : [])])];
  // Simple relays need no migration until a history location has been selected.
  if (directories.length === 1 && !previous?.historyStorageDirectories && !next.historyStorageDirectories) return next;
  return { ...next, historyStorageDirectories: parseStorageDirectories(directories) };
}
export async function inventoryRelayHistoryStorage(config: RelayConfig, runtimeDirectory: string, signal: AbortSignal) {
  return measureStorageDirectories(relayStorageDirectories(config, runtimeDirectory), { signal });
}
