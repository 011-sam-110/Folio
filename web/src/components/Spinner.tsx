// STUB — web-shell replaces this.
export default function Spinner({ size = 18 }: { size?: number }) {
  return <span style={{ display: 'inline-block', width: size, height: size, border: '2px solid #ddd', borderTopColor: '#4f46e5', borderRadius: '50%', animation: 'folio-spin .7s linear infinite' }} />;
}
