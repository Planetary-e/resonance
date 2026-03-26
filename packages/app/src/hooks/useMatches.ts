import { useState, useCallback } from 'react';
import {
  getMatches,
  initiateChannel,
  type Match,
} from '../api.client';

export interface UseMatches {
  matches: Match[];
  refresh: () => Promise<void>;
  connect: (matchId: string) => Promise<{ channelId?: string; error?: string }>;
}

export function useMatches(): UseMatches {
  const [matches, setMatches] = useState<Match[]>([]);

  const refresh = useCallback(async () => {
    const data = await getMatches();
    setMatches(data);
  }, []);

  const connect = useCallback(async (matchId: string) => {
    const result = await initiateChannel(matchId);
    if (result.error) return { error: result.error };
    return { channelId: result.channelId };
  }, []);

  return { matches, refresh, connect };
}
