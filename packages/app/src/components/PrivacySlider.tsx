import React from 'react';

const LABELS = ['Low', 'Medium', 'High'];

interface PrivacySliderProps {
  value: number; // 0, 1, or 2
  onChange: (value: number) => void;
}

export default function PrivacySlider({ value, onChange }: PrivacySliderProps) {
  return (
    <div className="form-group">
      <label>
        Privacy Level: <strong>{LABELS[value]}</strong>
      </label>
      <input
        type="range"
        min={0}
        max={2}
        step={1}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
      <div className="slider-labels">
        <span>Low</span>
        <span>Medium</span>
        <span>High</span>
      </div>
    </div>
  );
}
