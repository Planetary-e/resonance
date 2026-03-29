import React from 'react';

export type TabId = 'dashboard' | 'publish' | 'search' | 'matches' | 'channels';

const TABS: { id: TabId; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'publish', label: 'Publish' },
  { id: 'search', label: 'Search' },
  { id: 'matches', label: 'Matches' },
  { id: 'channels', label: 'Channels' },
];

interface TabNavProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
}

export default function TabNav({ activeTab, onChange }: TabNavProps) {
  return (
    <nav className="tab-nav">
      {TABS.map(tab => (
        <button
          key={tab.id}
          className={activeTab === tab.id ? 'active' : ''}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
