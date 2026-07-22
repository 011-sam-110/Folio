# Iteration 2: feature wave ownership map

Seven parallel agents. NEVER touch another agent's files. Pre-staged read-only foundation:
schema.sql (templates + note_comments tables added), web/src/lib/api.ts + types.ts (all new
endpoints/types), main.tsx (routes /search /tags → placeholder pages), docs/API.md (contracts).

| Agent | Owns (may create new files inside its areas) |
|---|---|
| palette-nav | components/CommandPalette.tsx*, lib/commands.ts*, lib/useShortcuts.ts, App.tsx, components/Sidebar.tsx, components/QuickSwitcher.tsx |
| search-tags | server routes/search.ts + test/search-ops.test.ts*, web pages/SearchPage.tsx, pages/TagsPage.tsx, their css* |
| editor-blocks | features/editor/{buildExtensions.ts, SlashItems.ts, SlashMenu.tsx, FolioEditor.tsx, WikilinkExtension.ts, WikilinkView.tsx, AiPreviewModal.tsx, markdown.ts, editor.css, suggestionRenderer.tsx} + new node/plugin files (Columns.ts*, BlockMenu.tsx*, textColor*, …) |
| notepage-tools | features/editor/{NotePage.tsx, SelectionToolbar.tsx, notePage.css} + new FindReplace* + QuickCardModal* files, features/comments/** (new), server routes/comments.ts* + test/comments.test.ts* |
| study-manual | features/study/**, server routes/study.ts + test additions in test/study.test.ts |
| templates-nb | server routes/templates.ts* + templates seeding (in that route file on boot, NOT seed.ts) + test/templates.test.ts*, web features/templates/** (new), pages/NotebookPage.tsx |
| dashboard-recall | server routes/dashboard.ts + test/dashboard2.test.ts*, web pages/DashboardPage.tsx + its css |

(* = new file)

## Cross-agent contracts (fixed paths/shapes)
- Column node JSON (editor-blocks implements; templates-nb's Cornell template emits it):
  `{ type: 'columnList', content: [{ type: 'column', attrs: { width: null }, content: [blocks…] }] }`. 2–4 columns,
  keyboard-escapable, deletable, degrades to sequential blocks if nodes unknown.
- Comment mark (notepage-tools implements at features/comments/CommentMark.ts, exports `CommentMark`):
  mark name 'comment', attrs { commentId }. editor-blocks imports it in buildExtensions.ts via
  `import { CommentMark } from '../comments/CommentMark'`, so notepage-tools MUST export exactly that.
- Command registry (palette-nav, lib/commands.ts): `registerCommands(cmds: Command[])`, `useCommands()`;
  `Command = { id, title, hint?, section, keywords?, shortcut?, run(ctx: { navigate }) }`.
  Other agents DO NOT register commands this wave: palette-nav wires built-ins itself (navigation, new note,
  theme, open import, snapshot via autosaveBus, study/ask/search/tags pages).
- SelectionToolbar "Add to flashcards" (notepage-tools) uses api.createCard; Browse-tab add/edit UI is study-manual's.
- Server markdown export of new nodes: NOT this wave. Integration captain patches lib/export.ts
  (columns → sequential sections separated by blank lines; comment marks stripped; templates never exported).

## Rules (same as wave 1)
- No npm install (list needs), no dev servers on shared ports (4780/5173/4781/5174/4790), no commits, no seeds against data/folio.db.
- Unit tests for server work in your OWN new test file (or study-manual: extend study.test.ts).
- Typecheck your workspace at the end; other agents' in-flight errors are acceptable, but note them.
- Consult context7 for TipTap v3 APIs instead of guessing.
