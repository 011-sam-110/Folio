// Public surface of the sketch / canvas-insert module. The parent session wires these into
// the editor: add `SketchNode` to createFolioExtensions()'s extensions array, and register
// `sketchInsertable` + `canvasInsertInsertable` (both section 'Notation') in the Insert menu.

import SketchNode from './SketchNode';
import { sketchInsertable } from './sketchInsertable';
import { canvasInsertInsertable } from './canvasInsertInsertable';
import type { InsertItem } from './insertTypes';

export { default as SketchNode } from './SketchNode';
export { sketchInsertable } from './sketchInsertable';
export { canvasInsertInsertable } from './canvasInsertInsertable';
export type { InsertItem, InsertSection } from './insertTypes';

/** Both insert items this module contributes, ready to spread into the Insert catalogue. */
export const sketchInsertables: InsertItem[] = [sketchInsertable, canvasInsertInsertable];

/** The extension the parent adds to the editor. */
export const sketchExtension = SketchNode;
