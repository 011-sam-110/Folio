// STUB — web-shell replaces this.
export default function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} style={{ height: 12, background: 'var(--bg-hover, #f1f1ef)', borderRadius: 6, margin: '8px 0', width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}
