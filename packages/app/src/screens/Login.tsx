import React, { useState, useRef, useEffect } from 'react';

interface LoginProps {
  initialized: boolean;
  onUnlock: (password: string) => Promise<{ error?: string }>;
  onInit: (password: string) => Promise<{ error?: string }>;
}

export default function Login({ initialized, onUnlock, onInit }: LoginProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmed = password.trim();
    if (!trimmed) {
      setError('Please enter a password.');
      return;
    }

    setError('');
    setLoading(true);

    const handler = initialized ? onUnlock : onInit;
    const result = await handler(trimmed);

    if (result.error) {
      setError(result.error);
      setLoading(false);
    }
    // On success, the parent App component will transition to the app view
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="logo">Resonance</div>
        <p className="description">
          {initialized
            ? 'Enter your password to unlock.'
            : 'Create a password to generate your decentralized identity.'}
        </p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <input
              ref={inputRef}
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={loading}
              autoComplete="current-password"
            />
          </div>

          <button
            className="btn btn-primary w-full"
            type="submit"
            disabled={loading}
          >
            {loading
              ? 'Please wait...'
              : initialized
                ? 'Unlock'
                : 'Create Identity'}
          </button>

          {error && <div className="error-msg">{error}</div>}
        </form>
      </div>
    </div>
  );
}
