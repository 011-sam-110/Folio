// The Unote mark. Drawn rather than set as the 📓 emoji it replaces: an emoji renders as
// a different object on every OS (purple on Windows, glossy rings on macOS, green on
// Android), carries its own side bearings so it never optically aligns to the wordmark,
// and brings colours the palette does not contain.
//
// This is a closed book seen edge-on. It inherits currentColor for the cover, so it works
// on paper and on the dark AI band, and the page edge picks up the highlighter yellow -
// which is what ties the identity to the signature.
export default function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="mkt-logo"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      {/* cover */}
      <path
        d="M4 3.2a1.6 1.6 0 0 1 1.6-1.6h9.2a1 1 0 0 1 1 1v14.8a1 1 0 0 1-1 1H5.6A1.6 1.6 0 0 1 4 16.8V3.2Z"
        fill="currentColor"
      />
      {/* the fore-edge of the pages */}
      <path d="M15.8 4.6h1.1a.6.6 0 0 1 .6.6v9.6a.6.6 0 0 1-.6.6h-1.1V4.6Z" className="mkt-logo__edge" />
      {/* spine band */}
      <path d="M6.7 1.6v16.8" stroke="var(--mkt-paper)" strokeWidth="1" strokeOpacity="0.5" />
    </svg>
  );
}
