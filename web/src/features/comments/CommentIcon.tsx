// A small stroke/currentColor speech-bubble glyph matching components/Icon.tsx's visual
// language (24x24 viewbox, round joins, currentColor stroke). Icon.tsx itself is shared,
// unowned infra this wave (every agent could plausibly want to add a glyph to it, which is
// exactly the kind of concurrent-edit collision the ownership map exists to avoid) — so this
// stays local to the comments feature instead of touching that shared file.
export default function CommentIcon({ size = 15 }: { size?: number }) {
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
      <path d="M21 11.5a7.5 7.5 0 0 1-8.9 7.37 8.4 8.4 0 0 1-2.19-.28L4 20l1.48-3.44A7.5 7.5 0 1 1 21 11.5Z" />
    </svg>
  );
}
