import { useState, useCallback } from 'react';
import {
  getItems,
  publishItem as publishApi,
  withdrawItem as withdrawApi,
  type Item,
  type PublishResult,
} from '../api.client';

export interface UseItems {
  items: Item[];
  refresh: () => Promise<void>;
  publish: (text: string, type: 'need' | 'offer', privacy: 'low' | 'medium' | 'high') => Promise<PublishResult & { error?: string }>;
  withdraw: (id: string) => Promise<{ error?: string }>;
}

export function useItems(): UseItems {
  const [items, setItems] = useState<Item[]>([]);

  const refresh = useCallback(async () => {
    const data = await getItems();
    setItems(data);
  }, []);

  const publish = useCallback(async (
    text: string,
    type: 'need' | 'offer',
    privacy: 'low' | 'medium' | 'high',
  ) => {
    const result = await publishApi(text, type, privacy);
    if (!result.error) {
      await refresh();
    }
    return result;
  }, [refresh]);

  const withdraw = useCallback(async (id: string) => {
    const result = await withdrawApi(id);
    if (!result.error) {
      await refresh();
    }
    return result;
  }, [refresh]);

  return { items, refresh, publish, withdraw };
}
