/** Retain known history locations when later desktop selections replace earlier ones. */
import { existsSync } from 'node:fs';
import { canonicalHistorySetupPath, measureStorageDirectories, parseStorageDirectories, parseStorageFiles } from '@resonance/relay';
import { readHistoryVolunteerConfigurationFile } from '../../../relay/src/history-volunteer-config.js';
import type { RelayConfig } from './session.js';
import { readRelayStorageRegistry, readRelayStorageLocations, relayStorageRegistryPath, retainRelayStorageRegistry } from './history-storage-registry.js';

export function relayStorageDirectories(config: RelayConfig, runtimeDirectory: string): string[] {
  const directories = [runtimeDirectory, ...(config.historyStorageDirectories ?? []), ...readRelayStorageRegistry(runtimeDirectory)];
  if (config.runtime?.admissionHistoryDirectory) directories.push(config.runtime.admissionHistoryDirectory);
  if (config.historyActivationInput) directories.push(config.historyActivationInput.historyDirectory);
  if (config.historyVolunteerActivationInput) directories.push(config.historyVolunteerActivationInput.directory);
  else if (config.runtime?.historyVolunteerFile) directories.push(readHistoryVolunteerConfigurationFile(config.runtime.historyVolunteerFile).directory);
  if (config.historyRecoveryInput) directories.push(config.historyRecoveryInput.workspaceDirectory, config.historyRecoveryInput.historyDirectory);
  if (config.historySetupInput && config.historySetupInput.role !== 'configuration') directories.push(config.historySetupInput.directory);
  if (config.historySetupInput && 'localRoleDirectory' in config.historySetupInput) directories.push(config.historySetupInput.localRoleDirectory);
  return parseStorageDirectories([...new Set(directories.map(canonicalHistorySetupPath))]);
}
export function retainRelayStorageDirectories(next: RelayConfig, previous: RelayConfig | undefined, runtimeDirectory: string): RelayConfig {
  const directories = [...new Set([...relayStorageDirectories(next, runtimeDirectory),
    ...(previous ? relayStorageDirectories(previous, runtimeDirectory) : [])])];
  // Simple relays need no migration until a history location has been selected.
  if (directories.length === 1 && !previous?.historyStorageDirectories && !next.historyStorageDirectories) return next;
  return { ...next, historyStorageDirectories: parseStorageDirectories(directories) };
}
export function relayStorageOutputFiles(config: RelayConfig, runtimeDirectory: string): string[] {
  const files = [...readRelayStorageLocations(runtimeDirectory).files];
  if (config.historySetupInput && 'output' in config.historySetupInput) files.push(config.historySetupInput.output);
  if (config.historyVolunteerActivationInput) files.push(config.historyVolunteerActivationInput.output);
  return parseStorageFiles([...new Set(files.map(canonicalHistorySetupPath))]);
}
export async function inventoryRelayHistoryStorage(config: RelayConfig, runtimeDirectory: string, signal: AbortSignal) {
  try {
    const directories = relayStorageDirectories(config, runtimeDirectory), registry = relayStorageRegistryPath(runtimeDirectory);
    if (existsSync(registry)) directories.push(registry);
    return await measureStorageDirectories(directories, { signal, files: relayStorageOutputFiles(config, runtimeDirectory) });
  }
  catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code) throw new Error('Storage inventory unavailable: retained locations or their registry are missing, unreadable or changed');
    throw error;
  }
}

export function retainRelayHistoryOperationLocations(config: RelayConfig, runtimeDirectory: string, previous?: RelayConfig) {
  const directories = [...relayStorageDirectories(config, runtimeDirectory), ...(previous ? relayStorageDirectories(previous, runtimeDirectory) : [])];
  const files = [...relayStorageOutputFiles(config, runtimeDirectory), ...(previous ? relayStorageOutputFiles(previous, runtimeDirectory) : [])];
  retainRelayStorageRegistry(runtimeDirectory, [...new Set(directories)], [...new Set(files)]);
}
