// STUB — web-shell replaces this (keep the exported API: toast() + <Toaster/>).
import { useEffect, useState } from 'react';

type Kind = 'ok' | 'error' | 'info';
type Item = { id: number; message: string; kind: Kind };
let push: ((i: Item) => void) | null = null;
let nextId = 1;

export function toast(message: string, kind: Kind = 'info') {
  push?.({ id: nextId++, message, kind });
}

export function Toaster() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    push = (i) => {
      setItems(prev => [...prev, i]);
      setTimeout(() => setItems(prev => prev.filter(x => x.id !== i.id)), 4000);
    };
    return () => { push = null; };
  }, []);
  return (
    <div style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 200 }}>
      {items.map(i => (
        <div key={i.id} style={{ background: i.kind === 'error' ? '#d1242f' : '#1f2328', color: '#fff', padding: '10px 14px', borderRadius: 8, fontSize: 13 }}>
          {i.message}
        </div>
      ))}
    </div>
  );
}
