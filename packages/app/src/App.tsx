import React, { useState, useEffect, useCallback, useRef } from 'react';
import TopBar from './components/TopBar';
import TabNav, { type TabId } from './components/TabNav';
import ToastContainer from './components/Toast';
import Login from './screens/Login';
import Dashboard, { type Activity } from './screens/Dashboard';
import Publish from './screens/Publish';
import Search from './screens/Search';
import Matches from './screens/Matches';
import ChannelScreen from './screens/Channel';
import { useSession } from './hooks/useSession';
import { useItems } from './hooks/useItems';
import { useMatches } from './hooks/useMatches';
import { useChannels } from './hooks/useChannels';
import { useRelay } from './hooks/useRelay';
import { useToast } from './hooks/useToast';
import { connectEvents, type AppEvent } from './api.client';

type AppState = 'loading' | 'login' | 'app';

export default function App() {
  const [appState, setAppState] = useState<AppState>('loading');
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const [activities, setActivities] = useState<Activity[]>([]);

  const session = useSession();
  const items = useItems();
  const matches = useMatches();
  const channels = useChannels();
  const relay = useRelay();
  const { toasts, toast, dismiss } = useToast();

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Activity feed helper ----
  const addActivity = useCallback((type: Activity['type'], text: string) => {
    setActivities(prev => {
      const next = [{ type, text, time: new Date() }, ...prev];
      return next.slice(0, 50);
    });
  }, []);

  // ---- WebSocket event handler ----
  const handleEvent = useCallback((event: AppEvent) => {
    switch (event.type) {
      case 'match': {
        const sim = event.similarity as number;
        const partner = event.partnerDID as string;
        const pct = Math.round((sim || 0) * 100);
        toast(`New match found! Similarity: ${pct}%`, 'success');
        addActivity('match', `Match with ${partner?.substring(0, 20)}... (${pct}%)`);
        matches.refresh();
        session.refresh();
        break;
      }
      case 'channel_ready':
        toast('Channel is ready for disclosure.', 'success');
        addActivity('channel', 'Channel opened');
        channels.refresh();
        session.refresh();
        break;
      case 'confirm_result': {
        const confirmed = event.confirmed as boolean;
        const sim = event.similarity as number;
        if (confirmed) {
          toast(`Match confirmed! True similarity: ${Math.round((sim || 0) * 100)}%`, 'success');
        } else {
          toast('Match could not be confirmed.', 'error');
        }
        const channelId = event.channelId as string;
        if (channels.activeChannel?.id === channelId) {
          channels.addMessage({
            type: 'system',
            text: confirmed
              ? `Match confirmed. True similarity: ${Math.round((sim || 0) * 100)}%`
              : 'Match confirmation failed.',
            from: 'partner',
            time: new Date().toISOString(),
          });
        }
        break;
      }
      case 'disclosure': {
        toast('New disclosure received.', 'info');
        const channelId = event.channelId as string;
        if (channels.activeChannel?.id === channelId) {
          channels.addMessage({
            type: 'disclosure',
            text: event.text as string,
            level: event.level as string | undefined,
            from: 'partner',
            time: new Date().toISOString(),
          });
        }
        break;
      }
      case 'accept': {
        const msg = event.message as string | undefined;
        toast(msg ? `Accepted: ${msg}` : 'Partner accepted the connection!', 'success');
        addActivity('channel', 'Connection accepted');
        channels.refresh();
        break;
      }
      case 'reject': {
        const reason = event.reason as string | undefined;
        toast(reason ? `Rejected: ${reason}` : 'Partner rejected the connection.', 'error');
        channels.refresh();
        break;
      }
      case 'close':
        toast('Channel closed.', 'info');
        if (channels.activeChannel?.id === (event.channelId as string)) {
          channels.setActive(null);
        }
        channels.refresh();
        session.refresh();
        break;
    }
  }, [toast, addActivity, matches, session, channels]);

  // ---- Connect WebSocket ----
  const connectWs = useCallback((token: string) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const ws = connectEvents(token, handleEvent, () => {
      wsRef.current = null;
      // Reconnect after 2 seconds
      reconnectTimerRef.current = setTimeout(() => {
        if (session.token) connectWs(session.token);
      }, 2000);
    });
    wsRef.current = ws;
  }, [handleEvent, session.token]);

  // ---- Cleanup WebSocket on unmount ----
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, []);

  // ---- Initial status check ----
  useEffect(() => {
    let cancelled = false;

    async function check() {
      const data = await session.refresh();
      if (cancelled) return;

      if (!data) {
        // Server not ready, retry
        setTimeout(check, 1000);
        return;
      }

      if (data.unlocked) {
        // Already unlocked (e.g., page reload)
        setAppState('app');
      } else {
        setAppState('login');
      }
    }

    check();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- After unlock, load data and connect WS ----
  const handleUnlocked = useCallback(async (token?: string) => {
    setAppState('app');

    // Connect WebSocket
    if (token) {
      connectWs(token);
    }

    // Load all data in parallel
    await Promise.all([
      session.refresh(),
      items.refresh(),
      matches.refresh(),
      channels.refresh(),
      relay.refresh(),
    ]);
  }, [connectWs, session, items, matches, channels, relay]);

  // ---- Auth handlers ----
  const handleUnlock = useCallback(async (password: string) => {
    const result = await session.unlock(password);
    if (result.error) return { error: result.error };
    await handleUnlocked(result.token);
    return {};
  }, [session, handleUnlocked]);

  const handleInit = useCallback(async (password: string) => {
    const result = await session.init(password);
    if (result.error) return { error: result.error };
    await handleUnlocked(session.token ?? undefined);
    return {};
  }, [session, handleUnlocked]);

  // ---- Lock ----
  const handleLock = useCallback(async () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    await session.lock();
    setAppState('login');
    setActivities([]);
  }, [session]);

  // ---- Relay toggle ----
  const handleRelayToggle = useCallback(async () => {
    const result = await relay.toggle();
    if (result.error) {
      toast(`Relay error: ${result.error}`, 'error');
    } else {
      const status = relay.relayStatus;
      toast(
        status?.enabled ? 'Relay stopped' : `Relay started on port ${status?.port ?? '?'}`,
        'success',
      );
    }
    await session.refresh();
  }, [relay, toast, session]);

  // ---- Tab change triggers data refresh ----
  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab);
    switch (tab) {
      case 'dashboard':
        session.refresh();
        relay.refresh();
        break;
      case 'publish':
        items.refresh();
        break;
      case 'matches':
        matches.refresh();
        break;
      case 'channels':
        channels.refresh();
        break;
    }
  }, [session, relay, items, matches, channels]);

  // ============================
  // Render
  // ============================

  // Loading screen
  if (appState === 'loading') {
    return (
      <>
        <div className="loading-screen">
          <div className="logo">Resonance</div>
          <div className="spinner" />
          <div className="subtitle">Connecting...</div>
        </div>
        <ToastContainer toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  // Login screen
  if (appState === 'login') {
    return (
      <>
        <Login
          initialized={session.status?.initialized ?? false}
          onUnlock={handleUnlock}
          onInit={handleInit}
        />
        <ToastContainer toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  // Main app
  return (
    <div className="app-layout">
      <TopBar
        did={session.status?.did ?? null}
        relayConnected={session.status?.relayConnected ?? false}
        onLock={handleLock}
      />
      <TabNav activeTab={activeTab} onChange={handleTabChange} />

      <main className="main-content">
        {activeTab === 'dashboard' && (
          <Dashboard
            status={session.status}
            channelCount={channels.channels.length}
            relayStatus={relay.relayStatus}
            onRelayToggle={handleRelayToggle}
            activities={activities}
          />
        )}

        {activeTab === 'publish' && (
          <Publish
            items={items.items}
            onPublish={async (text, type, privacy) => {
              const result = await items.publish(text, type, privacy);
              if (!result.error) {
                addActivity('publish', `Published ${type}: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
                session.refresh();
              }
              return result;
            }}
            onWithdraw={async (id) => {
              const result = await items.withdraw(id);
              if (!result.error) session.refresh();
              return result;
            }}
            onToast={toast}
          />
        )}

        {activeTab === 'search' && (
          <Search onToast={toast} />
        )}

        {activeTab === 'matches' && (
          <Matches
            matches={matches.matches}
            items={items.items}
            onConnect={async (matchId) => {
              const result = await matches.connect(matchId);
              if (!result.error) {
                addActivity('channel', 'Channel initiated');
                channels.refresh();
                session.refresh();
              }
              return result;
            }}
            onToast={toast}
            onSwitchToChannels={() => handleTabChange('channels')}
          />
        )}

        {activeTab === 'channels' && (
          <ChannelScreen
            channels={channels.channels}
            activeChannel={channels.activeChannel}
            messages={channels.messages}
            onSelect={channels.setActive}
            onDisclose={channels.disclose}
            onAccept={channels.accept}
            onReject={channels.reject}
            onClose={channels.close}
            onToast={toast}
          />
        )}
      </main>

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
