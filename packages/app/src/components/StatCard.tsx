import React from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  color: 'blue' | 'green' | 'gold' | 'purple';
}

export default function StatCard({ label, value, color }: StatCardProps) {
  return (
    <div className={`stat-card stat-${color}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
