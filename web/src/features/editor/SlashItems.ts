// Backwards-compatible shim. The command catalog moved to insertables.ts - the shared
// Insert registry now feeding the "/" menu, the gutter "+" and the toolbar Insert button.
// These aliases keep any older imports of the "Slash*" names resolving to the new source.
export type { InsertItem as SlashItem, InsertSection as SlashSection } from './insertables';
export { INSERT_ITEMS as SLASH_ITEMS, getInsertItems as getSlashItems } from './insertables';
