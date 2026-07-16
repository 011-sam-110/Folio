// STUB — web-shell replaces this (keep the prop signature).
import type { NoteLite } from '../lib/types';

export default function NoteCard({ note, onClick }: { note: NoteLite; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ border: '1px solid var(--line, #e8e8e6)', borderRadius: 8, padding: 12, cursor: 'pointer' }}>
      <div style={{ fontSize: 12, color: 'var(--ink-2, #57606a)' }}>{note.notebook?.emoji} {note.notebook?.name}</div>
      <div style={{ fontWeight: 600 }}>{note.title || 'Untitled'}</div>
      <div style={{ fontSize: 13, color: 'var(--ink-2, #57606a)' }}>{note.snippet}</div>
    </div>
  );
}
