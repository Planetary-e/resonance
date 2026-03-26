import { useState, useCallback } from 'react';
import {
  getChannels,
  getChannel,
  sendDisclosure,
  acceptChannel,
  rejectChannel,
  closeChannel,
  type Channel,
} from '../api.client';

export interface ChannelMessage {
  type: 'disclosure' | 'system';
  text: string;
  level?: string;
  from: 'me' | 'partner';
  time: string;
}

export interface UseChannels {
  channels: Channel[];
  activeChannel: Channel | null;
  messages: ChannelMessage[];
  refresh: () => Promise<void>;
  setActive: (channelId: string | null) => Promise<void>;
  addMessage: (msg: ChannelMessage) => void;
  disclose: (text: string, level: string) => Promise<{ error?: string }>;
  accept: (msg?: string) => Promise<{ error?: string }>;
  reject: (reason?: string) => Promise<{ error?: string }>;
  close: () => Promise<{ error?: string }>;
}

export function useChannels(): UseChannels {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChannelMessage[]>>({});

  const refresh = useCallback(async () => {
    const data = await getChannels();
    setChannels(data);
  }, []);

  const setActive = useCallback(async (channelId: string | null) => {
    if (!channelId) {
      setActiveChannel(null);
      setMessages([]);
      return;
    }
    const ch = await getChannel(channelId);
    if (ch.error) {
      setActiveChannel(null);
      setMessages([]);
      return;
    }
    setActiveChannel(ch);
    setMessages(messagesByChannel[channelId] ?? []);
  }, [messagesByChannel]);

  const addMessage = useCallback((msg: ChannelMessage) => {
    setMessages(prev => [...prev, msg]);
    setMessagesByChannel(prev => {
      if (!activeChannel) return prev;
      const id = activeChannel.id;
      const existing = prev[id] ?? [];
      return { ...prev, [id]: [...existing, msg] };
    });
  }, [activeChannel]);

  const disclose = useCallback(async (text: string, level: string) => {
    if (!activeChannel) return { error: 'No active channel' };
    const result = await sendDisclosure(activeChannel.id, text, level);
    if (result.error) return { error: result.error };
    const msg: ChannelMessage = {
      type: 'disclosure',
      text,
      level,
      from: 'me',
      time: new Date().toISOString(),
    };
    addMessage(msg);
    return {};
  }, [activeChannel, addMessage]);

  const accept = useCallback(async (msg?: string) => {
    if (!activeChannel) return { error: 'No active channel' };
    const result = await acceptChannel(activeChannel.id, msg);
    if (result.error) return { error: result.error };
    addMessage({
      type: 'system',
      text: 'You accepted the connection.',
      from: 'me',
      time: new Date().toISOString(),
    });
    await refresh();
    return {};
  }, [activeChannel, addMessage, refresh]);

  const reject = useCallback(async (reason?: string) => {
    if (!activeChannel) return { error: 'No active channel' };
    const result = await rejectChannel(activeChannel.id, reason);
    if (result.error) return { error: result.error };
    setActiveChannel(null);
    setMessages([]);
    await refresh();
    return {};
  }, [activeChannel, refresh]);

  const close = useCallback(async () => {
    if (!activeChannel) return { error: 'No active channel' };
    const result = await closeChannel(activeChannel.id);
    if (result.error) return { error: result.error };
    setActiveChannel(null);
    setMessages([]);
    await refresh();
    return {};
  }, [activeChannel, refresh]);

  return {
    channels,
    activeChannel,
    messages,
    refresh,
    setActive,
    addMessage,
    disclose,
    accept,
    reject,
    close,
  };
}
