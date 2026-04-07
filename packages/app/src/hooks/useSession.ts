import { useState, useCallback } from 'react';
import {
  getStatus,
  initIdentity,
  unlock as unlockApi,
  lock as lockApi,
  setAuthToken,
  type StatusResponse,
} from '../api.client';

export interface UseSession {
  status: StatusResponse | null;
  isUnlocked: boolean;
  token: string | null;
  refresh: () => Promise<StatusResponse | null>;
  unlock: (password: string) => Promise<{ error?: string; token?: string }>;
  init: (password: string) => Promise<{ error?: string }>;
  lock: () => Promise<void>;
}

export function useSession(): UseSession {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<StatusResponse | null> => {
    const data = await getStatus();
    if (!data.error) {
      setStatus(data);
      return data;
    }
    return null;
  }, []);

  const init = useCallback(async (password: string) => {
    const result = await initIdentity(password);
    if (result.error) return { error: result.error };
    // After init, auto-unlock
    const unlockResult = await unlockApi(password);
    if (unlockResult.error) return { error: unlockResult.error };
    if (unlockResult.token) {
      setToken(unlockResult.token);
      setAuthToken(unlockResult.token);
    }
    await refresh();
    return {};
  }, [refresh]);

  const unlockFn = useCallback(async (password: string) => {
    const result = await unlockApi(password);
    if (result.error) return { error: result.error };
    if (result.token) {
      setToken(result.token);
      setAuthToken(result.token);
    }
    await refresh();
    return { token: result.token };
  }, [refresh]);

  const lock = useCallback(async () => {
    await lockApi();
    setAuthToken(null);
    setToken(null);
    setStatus(null);
  }, []);

  return {
    status,
    isUnlocked: status?.unlocked ?? false,
    token,
    refresh,
    unlock: unlockFn,
    init,
    lock,
  };
}
