import React, { useState, useCallback } from 'react';
import type { Toast as ToastData } from '../hooks/useToast';

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: number) => void;
}

function ToastItem({ toast, onDismiss }: { toast: ToastData; onDismiss: (id: number) => void }) {
  const [removing, setRemoving] = useState(false);

  const handleClick = useCallback(() => {
    setRemoving(true);
    setTimeout(() => onDismiss(toast.id), 200);
  }, [toast.id, onDismiss]);

  return (
    <div
      className={`toast toast-${toast.type}${removing ? ' removing' : ''}`}
      onClick={handleClick}
    >
      {toast.message}
    </div>
  );
}

export default function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
