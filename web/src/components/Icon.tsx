// The app's icon set: Material Symbols Rounded, weight 300, FILL 0 - the vocabulary the
// dark-chrome redesign is drawn in.
//
// This replaced a hand-rolled stroke set. The old set existed so UI chrome wouldn't
// depend on an icon package; that rationale is preserved in a different way here.
// @material-symbols/svg-300 is a devDependency, and scripts/gen-icons.mjs bakes only the
// glyphs actually used into src/components/iconPaths.ts. Nothing is fetched at runtime
// and no icon font ships - which also sidesteps the CSP, since `font-src 'self' data:`
// refuses the fonts.googleapis.com link the design file uses (server/src/lib/csp.ts).
//
// Emoji are still used elsewhere for content identity (notebook emoji, wordmark); these
// are for interactive chrome only.
//
// To add an icon: add it to MAP in scripts/gen-icons.mjs and run `npm run gen:icons -w web`.
import type { CSSProperties } from 'react';
import { ICON_PATHS, ICON_VIEWBOX, type IconName } from './iconPaths';

export type { IconName };

/** Runtime membership test for the icon set - lets callers accept a string that is
 *  either an Icon name (rendered as a vector) or a plain text glyph. */
export function isIconName(value: string): value is IconName {
  return value in ICON_PATHS;
}

export default function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  /** Accepted and ignored. Material Symbols are filled shapes with the weight baked in
   *  at 300, so there is no stroke to widen. Kept in the signature because call sites
   *  across the app still pass it, and silently doing nothing is better here than a
   *  type error at 60-odd sites for a prop that no longer has meaning. */
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="currentColor"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
