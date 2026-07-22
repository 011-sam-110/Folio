// The first-run hint ids, in a dependency-free module so both the app (HintHost.tsx)
// and the e2e fixture can import them without the fixture pulling in React.
//
// The e2e fixture pre-dismisses all of these for the account it hands to every spec,
// so an unrelated test never has a hint bubble appear mid-run and intercept a click.
// Keeping the list here rather than duplicating it there is what stops the two
// drifting apart when a hint is added or removed.
//
// Ids are versioned (`-v1`). Changing a hint's wording materially means minting a
// new id, so people who dismissed the old one see the new one once - and never
// means resurrecting a hint someone has already waved away.
export const HINT_IDS = ['canvas-ink-v1', 'editor-slash-v1', 'search-operators-v1'] as const;

export type HintId = (typeof HINT_IDS)[number];
