'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from './lib/supabaseClient';

const STORAGE_KEY = 'course-companion-chat';
// Sent to the AI so it has context, capped so a long chat doesn't balloon every request.
const HISTORY_LIMIT = 12;

async function loadCloudChat() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from('saves').select('chat').eq('user_id', user.id).maybeSingle();
  if (error) {
    console.error('loadCloudChat failed:', error);
    return null;
  }
  return data ? data.chat : null;
}

async function saveCloudChat(payload) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase
    .from('saves')
    .upsert({ user_id: user.id, chat: payload, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) console.error('saveCloudChat failed:', error);
}

function makeId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

// Downscaled/re-encoded client-side before ever leaving the browser - a
// straight-from-camera photo can be several MB and several thousand px on a
// side, which is both slow to upload on a classroom connection and wasteful
// once it's sitting in chat history (localStorage + the cloud save) forever.
// Re-encoding to JPEG also normalizes HEIC/PNG/etc. into something every
// vision model reliably accepts.
const MAX_IMAGE_DIM = 1024;
const IMAGE_QUALITY = 0.82;

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', IMAGE_QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// A user message's content is either a plain string (every message before
// this feature existed, and every text-only message since) or an OpenAI-
// style multimodal array ([{type:'text',...}, {type:'image_url',...}]) when
// an image was attached - the chat API route forwards `content` straight
// through untouched either way, so no server-side change was needed for this.
function MessageContent({ content }) {
  if (!Array.isArray(content)) return content;
  const text = content.find((part) => part.type === 'text')?.text;
  const imageUrl = content.find((part) => part.type === 'image_url')?.image_url?.url;
  return (
    <div className="space-y-2">
      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a remote image next/image can optimize
        <img src={imageUrl} alt="attached" className="max-h-56 rounded border border-[#0e3a44] object-contain" />
      )}
      {text && <p className="leading-relaxed whitespace-pre-wrap">{text}</p>}
    </div>
  );
}

function FormattedResponse({ text }) {
  const blocks = [];
  let currentList = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      currentList = null;
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.*)$/) || line.match(/^\d+[.)]\s+(.*)$/);
    if (bulletMatch) {
      if (!currentList) {
        currentList = { type: 'list', items: [] };
        blocks.push(currentList);
      }
      currentList.items.push(bulletMatch[1]);
    } else {
      currentList = null;
      blocks.push({ type: 'p', text: line });
    }
  }

  function renderInline(str, key) {
    const parts = str.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={i} className="rounded bg-[#132313] px-1 py-0.5 text-[0.9em] text-[#8fe9ff]">
            {part.slice(1, -1)}
          </code>
        );
      }
      return <span key={i}>{part}</span>;
    });
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, i) =>
        block.type === 'list' ? (
          <ul key={i} className="list-disc space-y-1.5 pl-5">
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item, j)}</li>
            ))}
          </ul>
        ) : (
          <p key={i} className="leading-relaxed">
            {renderInline(block.text, i)}
          </p>
        ),
      )}
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [pendingImage, setPendingImage] = useState(null); // { dataUrl, fileName }
  const [imageError, setImageError] = useState('');
  const timerRef = useRef(null);
  const bottomRef = useRef(null);
  const localUpdatedAtRef = useRef(0);
  const cloudSyncTimerRef = useRef(null);
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);

  async function handleImageFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setImageError('Only image files are supported.');
      return;
    }
    setImageError('');
    try {
      const dataUrl = await resizeImageFile(file);
      setPendingImage({ dataUrl, fileName: file.name });
      inputRef.current?.focus();
    } catch {
      setImageError('Could not read that image.');
    }
  }

  function handleFileInputChange(e) {
    handleImageFile(e.target.files?.[0]);
    e.target.value = ''; // so picking the same file again still fires onChange
  }

  function handlePaste(e) {
    const item = Array.from(e.clipboardData?.items || []).find((it) => it.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    handleImageFile(item.getAsFile());
  }

  function handleDrop(e) {
    e.preventDefault();
    handleImageFile(e.dataTransfer?.files?.[0]);
  }

  // Load any saved conversation once on mount, so it survives navigating to
  // another page and back (state would otherwise reset every time this
  // component unmounts).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          // old format from before cloud sync existed - no timestamp
          setMessages(parsed);
          localUpdatedAtRef.current = 0;
        } else if (parsed && Array.isArray(parsed.messages)) {
          setMessages(parsed.messages);
          localUpdatedAtRef.current = parsed.updatedAt || 0;
        }
      }
    } catch {
      // ignore corrupted/blocked storage
    } finally {
      setHydrated(true);
    }
  }, []);

  // Once hydrated from localStorage, check for a cloud save and adopt it if
  // it's newer - handles opening this page already logged in on a device
  // that's never seen this conversation before.
  useEffect(() => {
    if (!hydrated) return;
    (async () => {
      const cloud = await loadCloudChat();
      if (cloud && (cloud.updatedAt || 0) >= localUpdatedAtRef.current) {
        setMessages(cloud.messages || []);
        localUpdatedAtRef.current = cloud.updatedAt || Date.now();
      }
    })();
  }, [hydrated]);

  // Re-check the cloud save whenever the account widget reports a fresh login.
  useEffect(() => {
    function handleLogin() {
      (async () => {
        const cloud = await loadCloudChat();
        if (cloud && (cloud.updatedAt || 0) >= localUpdatedAtRef.current) {
          setMessages(cloud.messages || []);
          localUpdatedAtRef.current = cloud.updatedAt || Date.now();
        }
      })();
    }
    window.addEventListener('account:login', handleLogin);
    return () => window.removeEventListener('account:login', handleLogin);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const updatedAt = Date.now();
    localUpdatedAtRef.current = updatedAt;
    const payload = { messages, updatedAt };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore write failures (private browsing, storage full, etc.)
    }

    if (cloudSyncTimerRef.current) clearTimeout(cloudSyncTimerRef.current);
    cloudSyncTimerRef.current = setTimeout(() => saveCloudChat(payload), 3000);
  }, [messages, hydrated]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // Grows the textarea with its content (up to the max-h-40 cap, where it
  // starts scrolling instead) - a plain <textarea rows={1}> stays a fixed
  // height no matter how much is typed, so this is what actually makes
  // multi-line input feel natural instead of just technically possible.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  function clearChat() {
    setMessages([]);
    const updatedAt = Date.now();
    localUpdatedAtRef.current = updatedAt;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    saveCloudChat({ messages: [], updatedAt });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const text = input.trim();
    if ((!text && !pendingImage) || loading) return;

    const content = pendingImage
      ? [
          { type: 'text', text: text || 'What is in this image?' },
          { type: 'image_url', image_url: { url: pendingImage.dataUrl } },
        ]
      : text;

    const userMessage = { id: makeId(), role: 'user', content };
    const assistantId = makeId();
    const history = [...messages, userMessage].slice(-HISTORY_LIMIT);

    setMessages((current) => [...current, userMessage, { id: assistantId, role: 'assistant', content: '', error: false }]);
    setInput('');
    setPendingImage(null);
    setLoading(true);
    setElapsed(0);

    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    function updateAssistant(patch) {
      setMessages((current) => current.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)));
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Chat request failed.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        updateAssistant({ content: full });
      }
      if (!full) updateAssistant({ content: 'No response received.', error: true });
    } catch (err) {
      updateAssistant({ content: err.message, error: true });
    } finally {
      clearInterval(timerRef.current);
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-[#05070a] px-4 py-12 sm:py-16">
      <div className="w-full max-w-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <span className="inline-block rounded border border-[#1c3a1c] bg-[#0b0f0c] px-3 py-1 text-xs font-semibold tracking-wide text-[#39ff14] uppercase">
              # ai study companion
            </span>
            <p className="mt-2 text-sm text-[#6b8f6b]"># ask questions about your course material</p>
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearChat}
              className="mt-1 shrink-0 rounded border border-[#5a2323] px-3 py-1.5 text-xs font-medium text-[#ff8080] transition hover:bg-[#ff4444] hover:text-[#1a0000]"
            >
              clear --history
            </button>
          )}
        </div>

        <div className="overflow-hidden rounded-md border border-[#1c3a1c] bg-[#0b0f0c] shadow-[0_0_30px_rgba(57,255,20,0.06)]">
          <div className="flex items-center gap-2 border-b border-[#1c3a1c] bg-[#0e140e] px-3 py-2 text-xs text-[#6b8f6b]">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" />
            <span className="ml-2">study_buddy.sh</span>
          </div>

          <div className="p-5 sm:p-6">
            {messages.length === 0 ? (
              <p className="pb-2 text-center text-sm text-[#4a5a4a]">$ waiting for input_</p>
            ) : (
              <div className="mb-5 max-h-[28rem] space-y-4 overflow-y-auto pr-1">
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] rounded border px-4 py-2.5 text-sm ${
                        m.role === 'user'
                          ? 'border-[#0e3a44] bg-[#062226] text-[#8fe9ff]'
                          : m.error
                            ? 'border-[#5a2323] bg-[#1a0a0a] text-[#ff8080]'
                            : 'border-[#1c3a1c] bg-[#0e140e] text-[#c8ffcf]'
                      }`}
                    >
                      {m.role === 'assistant' && !m.error ? (
                        <>
                          <FormattedResponse text={m.content || (loading ? '' : '...')} />
                          {loading && m.id === messages[messages.length - 1].id && (
                            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[#39ff14] align-middle" />
                          )}
                        </>
                      ) : (
                        <MessageContent content={m.content} />
                      )}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}

            {loading && (
              <div className="mb-4 flex items-center gap-2 text-sm text-[#6b8f6b]">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#1c3a1c] border-t-[#39ff14]" />
                {elapsed < 5
                  ? 'sending request to classroom server...'
                  : `still running (${elapsed}s) — the shared classroom server can be slow when busy.`}
              </div>
            )}

            {pendingImage && (
              <div className="mb-3 flex items-center gap-3 rounded border border-[#0e3a44] bg-[#062226] px-3 py-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a remote image next/image can optimize */}
                <img src={pendingImage.dataUrl} alt="" className="h-12 w-12 rounded object-cover" />
                <span className="flex-1 truncate text-xs text-[#8fe9ff]">{pendingImage.fileName}</span>
                <button
                  type="button"
                  onClick={() => setPendingImage(null)}
                  className="shrink-0 text-xs text-[#ff8080] hover:underline"
                >
                  remove
                </button>
              </div>
            )}
            {imageError && <p className="mb-3 text-xs text-[#ff8080]">{imageError}</p>}

            <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileInputChange}
                className="hidden"
              />
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                className="flex flex-1 items-start rounded border border-[#1c3a1c] bg-[#05070a] px-3 focus-within:border-[#39ff14]"
              >
                <span className="mt-2.5 text-[#39ff14]">&gt;</span>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    // Enter sends, like before - shift+enter (or any other
                    // modifier) inserts a real newline instead, same as
                    // every other multi-line chat box.
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={pendingImage ? 'say something about the image (optional)...' : 'ask a question, or attach/paste an image...'}
                  rows={1}
                  className="max-h-40 w-full resize-none overflow-y-auto bg-transparent px-2 py-2.5 text-[#c8ffcf] placeholder:text-[#4a5a4a] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="attach an image"
                  className="mt-2 shrink-0 rounded border border-[#1c3a1c] px-2 py-1 text-xs text-[#6b8f6b] transition hover:border-[#39ff14] hover:text-[#39ff14]"
                >
                  + image
                </button>
              </div>
              <button
                type="submit"
                disabled={loading || (!input.trim() && !pendingImage)}
                className="inline-flex items-center justify-center gap-2 rounded border border-[#1fae0c] px-5 py-2.5 font-medium text-[#39ff14] transition hover:bg-[#39ff14] hover:text-[#04150a] disabled:cursor-not-allowed disabled:border-[#2a352a] disabled:text-[#4a5a4a] disabled:hover:bg-transparent"
              >
                {loading && (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current/40 border-t-current" />
                )}
                {loading ? `running... ${elapsed}s` : 'run'}
              </button>
            </form>
            <p className="mt-2 text-xs text-[#4a5a4a]"># enter to send, shift+enter for a new line</p>
          </div>
        </div>
      </div>
    </main>
  );
}
