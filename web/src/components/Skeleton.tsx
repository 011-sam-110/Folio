// web-shell — keep the prop signature exactly: { lines? }.
export default function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="folio-skeleton-line"
          style={{ width: `${92 - i * 11}%`, animationDelay: `${i * 70}ms` }}
        />
      ))}
    </div>
  );
}
