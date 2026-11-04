import { useState, useCallback } from 'react';
import {
  getItems,
  outboxAction as outboxApi,
  publishItem as publishApi,
  withdrawItem as withdrawApi,
  type Item,
  type PublishResult,
} from '../api.client';

export interface UseItems {
  items: Item[];
  refresh: () => Promise<void>;
  publish: (text: string, type: 'need' | 'offer', privacy: 'low' | 'medium' | 'high', delivery?: 'send' | 'hold') => Promise<PublishResult & { error?: string }>;
  outboxAction: (id: string, action: 'release' | 'cancel' | 'remove') => Promise<{ error?: string }>;
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
    delivery: 'send' | 'hold' = 'send',
  ) => {
    const result = await publishApi(text, type, privacy, delivery);
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

  const outboxAction = useCallback(async (id: string, action: 'release' | 'cancel' | 'remove') => {
    const result = await outboxApi(id, action);
    await refresh(); // Failed delivery still changes held/unknown state.
    return result;
  }, [refresh]);

  return { items, refresh, publish, withdraw, outboxAction };
}
