import { useState, useCallback, useRef } from 'react';

export type ToastType = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

export interface UseToast {
  toasts: Toast[];
  toast: (message: string, type?: ToastType) => void;
  dismiss: (id: number) => void;
}

let nextId = 0;

export function useToast(): UseToast {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++nextId;
    const newToast: Toast = { id, message, type };
    setToasts(prev => [...prev, newToast]);

    // Auto-dismiss after 5 seconds
    const timer = setTimeout(() => {
      dismiss(id);
    }, 5000);
    timersRef.current.set(id, timer);
  }, [dismiss]);

  return { toasts, toast, dismiss };
}
