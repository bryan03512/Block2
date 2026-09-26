'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function AccountWidget() {
  const [user, setUser] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: authError } =
      mode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setShowModal(false);
    setEmail('');
    setPassword('');
    window.dispatchEvent(new CustomEvent('account:login'));
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.dispatchEvent(new CustomEvent('account:logout'));
  }

  function openModal(nextMode) {
    setMode(nextMode);
    setError('');
    setShowModal(true);
  }

  return (
    <>
      {user ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="max-w-[140px] truncate text-[#6b8f6b]">{user.email}</span>
          <button
            onClick={handleLogout}
            className="rounded border border-[#5a2323] px-2 py-1 text-[#ff8080] transition hover:bg-[#ff4444] hover:text-[#1a0000]"
          >
            log out
          </button>
        </div>
      ) : (
        <div className="flex gap-2 text-xs">
          <button
            onClick={() => openModal('login')}
            className="rounded border border-[#1fae0c] px-2 py-1 text-[#39ff14] transition hover:bg-[#39ff14] hover:text-[#04150a]"
          >
            log in
          </button>
          <button
            onClick={() => openModal('signup')}
            className="rounded border border-[#1fae0c] px-2 py-1 text-[#39ff14] transition hover:bg-[#39ff14] hover:text-[#04150a]"
          >
            sign up
          </button>
        </div>
      )}

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={(e) => e.target === e.currentTarget && setShowModal(false)}
        >
          <div className="w-[min(320px,90vw)] rounded-md border border-[#1fae0c] bg-[#0b0f0c] p-4">
            <div className="mb-3 flex items-center justify-between text-[#39ff14]">
              <span>{mode === 'login' ? 'log in' : 'sign up'}</span>
              <button onClick={() => setShowModal(false)} className="text-lg leading-none text-[#6b8f6b]">
                &times;
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email"
                className="rounded border border-[#1c3a1c] bg-[#05070a] px-3 py-2 text-sm text-[#c8ffcf] placeholder:text-[#4a5a4a] focus:border-[#39ff14] focus:outline-none"
              />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="password"
                className="rounded border border-[#1c3a1c] bg-[#05070a] px-3 py-2 text-sm text-[#c8ffcf] placeholder:text-[#4a5a4a] focus:border-[#39ff14] focus:outline-none"
              />
              {error && <p className="text-xs text-[#ff8080]">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="rounded border border-[#1fae0c] px-3 py-2 text-sm text-[#39ff14] transition hover:bg-[#39ff14] hover:text-[#04150a] disabled:opacity-50"
              >
                {loading ? 'working...' : mode === 'login' ? 'log in' : 'sign up'}
              </button>
              <button
                type="button"
                onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
                className="text-xs text-[#00e5ff]"
              >
                {mode === 'login' ? 'need an account? sign up' : 'have an account? log in'}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
