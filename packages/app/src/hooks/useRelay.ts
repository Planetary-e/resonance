import { useState, useCallback } from 'react';
import {
  getRelayStatus,
  startRelay,
  stopRelay,
  type RelayStatus,
} from '../api.client';

export interface UseRelay {
  relayStatus: RelayStatus | null;
  refresh: () => Promise<void>;
  toggle: () => Promise<{ error?: string }>;
}

export function useRelay(): UseRelay {
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);

  const refresh = useCallback(async () => {
    const data = await getRelayStatus();
    if (!data.error) {
      setRelayStatus(data);
    }
  }, []);

  const toggle = useCallback(async () => {
    if (relayStatus?.enabled) {
      const result = await stopRelay();
      if (result.error) return { error: result.error };
    } else {
      const result = await startRelay();
      if (result.error) return { error: result.error };
    }
    await refresh();
    return {};
  }, [relayStatus, refresh]);

  return { relayStatus, refresh, toggle };
}
