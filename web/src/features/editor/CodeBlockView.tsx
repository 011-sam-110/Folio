// NodeView for code blocks: adds a language selector + copy button header on top of
// the lowlight-highlighted <pre><code>.
import { useState } from 'react';
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';

const LANGS = [
  'plaintext', 'javascript', 'typescript', 'python', 'bash', 'json', 'css', 'html', 'xml',
  'sql', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'ruby', 'php', 'yaml', 'markdown', 'diff',
];

export default function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const lang = (node.attrs.language as string) || 'plaintext';

  async function copy() {
    try {
      await navigator.clipboard.writeText(node.textContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard API unavailable - silently ignore
    }
  }

  return (
    <NodeViewWrapper className="folio-codeblock">
      <div className="folio-codeblock-head" contentEditable={false}>
        <select
          className="folio-codeblock-lang"
          value={lang}
          onChange={(e) => updateAttributes({ language: e.target.value })}
          aria-label="Code language"
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button type="button" className="folio-codeblock-copy" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <pre>
        <NodeViewContent className={`language-${lang}`} />
      </pre>
    </NodeViewWrapper>
  );
}
