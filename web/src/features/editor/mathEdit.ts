// Click-to-edit handler for Mathematics nodes, per the extension's own recommended
// "quick prototype" pattern: a prompt() with the current LaTeX, applied via updateInlineMath /
// updateBlockMath. `box` is a ref populated once the owning editor is created, since the
// Mathematics extension is configured before the Editor instance exists.
import type { Editor } from '@tiptap/core';

export function createMathClickHandler(box: { current: Editor | null }, kind: 'inline' | 'block') {
  return (node: { attrs: Record<string, unknown> }, pos: number) => {
    const editor = box.current;
    if (!editor || !editor.isEditable) return;
    const current = (node.attrs.latex as string) || '';
    const next = window.prompt('Edit LaTeX:', current);
    if (next == null) return;
    const chain = editor.chain().setNodeSelection(pos);
    if (kind === 'inline') chain.updateInlineMath({ latex: next });
    else chain.updateBlockMath({ latex: next });
    chain.focus().run();
  };
}
