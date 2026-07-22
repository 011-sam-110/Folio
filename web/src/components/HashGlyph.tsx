// palette-nav - small local glyph for "Tags", matching Icon.tsx's stroke
// system (24x24, currentColor, 1.8px round strokes). Not added to Icon.tsx's
// own set: tags render as "#hashtags" elsewhere in the app, so a hash reads
// truer here than any existing entry, and Icon.tsx isn't this wave's file to
// extend. Shared by Sidebar.tsx's Tags nav link and CommandPalette.tsx's
// "Tags" command.
export default function HashGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="5" y1="9" x2="19" y2="9" />
      <line x1="4" y1="15" x2="18" y2="15" />
      <line x1="10" y1="4" x2="7" y2="20" />
      <line x1="16" y1="4" x2="13" y2="20" />
    </svg>
  );
}
