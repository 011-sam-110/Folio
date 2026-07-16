// web-shell — keep the prop signature exactly: { size? }.
export default function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className="folio-spinner"
      role="status"
      aria-label="Loading"
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 9)) }}
    />
  );
}
