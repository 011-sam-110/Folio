// Insert item: "Sketch" - an inline draw surface embedded directly in the note.

import { focusFrom, type InsertItem } from './insertTypes';
import { SKETCH_WORLD_H_DEFAULT } from './sketchModel';

export const sketchInsertable: InsertItem = {
  id: 'sketch',
  title: 'Sketch',
  description: 'Draw inline with pen, highlighter or finger',
  icon: '✏️',
  section: 'Notation',
  keywords: ['sketch', 'draw', 'ink', 'pen', 'handwriting', 'diagram', 'doodle', 'whiteboard'],
  run: (editor, range) => {
    focusFrom(editor, range)
      .insertContent({ type: 'sketch', attrs: { strokes: [], h: SKETCH_WORLD_H_DEFAULT, bg: 'dots' } })
      .run();
  },
};

export default sketchInsertable;
