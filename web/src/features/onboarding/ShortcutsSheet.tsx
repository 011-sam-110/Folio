// Keyboard shortcut cheatsheet.
//
// Every binding listed here was read off the code that implements it, not off the
// spec — lib/useShortcuts.ts for the global chords, NotePage.tsx for the note-page
// window listener (Ctrl+S/F/H), SearchPage.tsx for "/", ReviewTab.tsx for the review
// keys, and TipTap's StarterKit defaults for the formatting marks. A cheatsheet that
// lists a shortcut which does not fire is worse than no cheatsheet.
import { useEffect, useState } from 'react';
import Modal from '../../components/Modal';
import './onboarding.css';

/** Mac renders the real glyphs; everything else spells the modifiers out, because
 *  "⌘" on a Windows machine is just noise. */
function useIsMac(): boolean {
  const [isMac] = useState(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent));
  return isMac;
}

interface Row {
  keys: string[];
  label: string;
}

interface Group {
  name: string;
  rows: Row[];
}

function groups(mod: string, shift: string, alt: string): Group[] {
  void alt;
  return [
    {
      name: 'Anywhere',
      rows: [
        { keys: [mod, 'K'], label: 'Jump to a note' },
        { keys: [mod, 'P'], label: 'Command palette: run anything' },
        { keys: [mod, 'N'], label: 'New note in the current notebook' },
        { keys: [mod, shift, 'F'], label: 'Search your notes' },
        { keys: [mod, '\\'], label: 'Show or hide the sidebar' },
        { keys: ['?'], label: 'This cheatsheet' },
        { keys: ['Esc'], label: 'Close whatever is open' },
      ],
    },
    {
      name: 'Writing',
      rows: [
        { keys: ['/'], label: 'Slash menu: headings, lists, tables, callouts' },
        { keys: ['[', '['], label: 'Link another note' },
        { keys: ['#', 'Space'], label: 'Heading (and "- " a bullet, "> " a quote)' },
        { keys: [mod, 'B'], label: 'Bold' },
        { keys: [mod, 'I'], label: 'Italic' },
        { keys: [mod, 'U'], label: 'Underline' },
        { keys: [mod, 'E'], label: 'Inline code' },
        { keys: [mod, 'Z'], label: 'Undo' },
      ],
    },
    {
      name: 'On a note',
      rows: [
        { keys: [mod, 'S'], label: 'Save a named version you can restore' },
        { keys: [mod, 'F'], label: 'Find in this note' },
        { keys: [mod, 'H'], label: 'Find and replace' },
        { keys: ['Tab'], label: 'Move between columns' },
      ],
    },
    {
      name: 'Search page',
      rows: [{ keys: ['/'], label: 'Focus the search box' }],
    },
    {
      name: 'Reviewing flashcards',
      rows: [
        { keys: ['Space'], label: 'Show the answer' },
        { keys: ['1'], label: 'Again' },
        { keys: ['2'], label: 'Hard' },
        { keys: ['3'], label: 'Good' },
        { keys: ['4'], label: 'Easy' },
      ],
    },
  ];
}

export default function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const isMac = useIsMac();
  const mod = isMac ? '⌘' : 'Ctrl';
  const shift = isMac ? '⇧' : 'Shift';
  const alt = isMac ? '⌥' : 'Alt';

  // Pressing "?" again while it is open closes it, so the same key toggles.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === '?') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width={640}>
      <div className="ks-sheet" data-testid="shortcuts-sheet">
        {groups(mod, shift, alt).map((group) => (
          <section className="ks-group" key={group.name}>
            <h3 className="ks-group__name">{group.name}</h3>
            <dl className="ks-list">
              {group.rows.map((row) => (
                <div className="ks-row" key={`${group.name}-${row.label}`}>
                  <dt className="ks-row__keys">
                    {row.keys.map((k, i) => (
                      <kbd key={`${k}-${i}`}>{k}</kbd>
                    ))}
                  </dt>
                  <dd className="ks-row__label">{row.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
