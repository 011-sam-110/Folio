// Orchestration for the wizard's heavy stages, kept out of the React components: stage every
// RawDoc into the batch (one small request each, exactly like the lecture upload), run the
// client heuristic over the staged items, persist its suggestions, and later commit in
// resumable chunks. The server never holds batch state between requests; the client drives.
import { api } from '../../../lib/api';
import type { ImportItem } from '../../../lib/types';
import type { RawDoc } from '../connectors/types';
import { processFile, createOcrRunner, folderPathOf, mapWithConcurrency } from '../connectors/extract';
import { pickCategoriser } from '../categorise/heuristic';
import type { CategoriserItem } from '../categorise/types';

export type IngestFileStatus = 'queued' | 'extracting' | 'staged' | 'failed';
export interface IngestFileState {
  localId: string;
  name: string;
  sourcePath: string;
  status: IngestFileStatus;
  note?: string;
  words?: number;
}
export interface IngestProgress {
  total: number;
  done: number;
  files: IngestFileState[];
}
export interface IngestResult {
  items: ImportItem[];
  categoriser: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'something went wrong';
}
function wordish(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}
function docName(d: RawDoc): string {
  return d.file?.name ?? d.sourcePath ?? 'file';
}

const JSON_FLUSH = 25; // stage pre-extracted text docs in small batches

/** Extract + stage every doc, then categorise. `onProgress` streams per-file status. */
export async function ingestAndCategorise(
  batchId: string,
  docs: RawDoc[],
  useOcr: boolean,
  onProgress: (p: IngestProgress) => void,
): Promise<IngestResult> {
  const states: IngestFileState[] = docs.map((d, i) => ({
    localId: `q${i}`,
    name: docName(d),
    sourcePath: d.sourcePath ?? docName(d),
    status: 'queued',
  }));
  const report = () =>
    onProgress({ total: states.length, done: states.filter((s) => s.status === 'staged' || s.status === 'failed').length, files: states.slice() });
  report();

  const ocr = useOcr ? createOcrRunner() : null;
  const jsonBuffer: Array<{ originalName: string; sourcePath?: string; title?: string; text: string; sourceTags?: string[] }> = [];

  await mapWithConcurrency(docs, 3, async (doc, i) => {
    const st = states[i];
    st.status = 'extracting';
    report();
    if (!doc.file) {
      st.status = 'failed';
      st.note = 'nothing to import';
      report();
      return;
    }
    try {
      const p = await processFile(doc.file, doc, ocr);
      if (p.mode === 'skip') {
        st.status = 'failed';
        st.note = p.error ?? p.note ?? 'unsupported';
        report();
        return;
      }
      if (p.mode === 'json') {
        jsonBuffer.push({ originalName: p.originalName, sourcePath: p.sourcePath, title: p.title, text: p.text ?? '', sourceTags: p.sourceTags });
        st.words = wordish(p.text ?? '');
        st.note = p.note;
        st.status = 'staged';
      } else {
        const form = new FormData();
        form.append('file', p.file as File, p.originalName);
        if (p.mode === 'upload-photo') form.append('kind', 'photo');
        if (p.ocrText) form.append('ocrText', p.ocrText);
        if (p.sourcePath) form.append('sourcePath', p.sourcePath);
        if (p.title) form.append('title', p.title);
        const { item } = await api.uploadImportFile(batchId, form);
        st.words = item.wordCount;
        st.note = item.error ?? p.note;
        st.status = item.status === 'failed' ? 'failed' : 'staged';
      }
    } catch (err) {
      st.status = 'failed';
      st.note = errMsg(err);
    }
    report();
  });

  if (ocr) await ocr.terminate();

  for (let i = 0; i < jsonBuffer.length; i += JSON_FLUSH) {
    await api.addImportItems(batchId, jsonBuffer.slice(i, i + JSON_FLUSH));
  }

  const [{ items }, labelSpace] = await Promise.all([api.getImportBatch(batchId), api.importLabelSpace()]);
  const categoriser = pickCategoriser();
  const catItems: CategoriserItem[] = items.map((it) => ({
    id: it.id,
    title: it.title,
    text: it.preview,
    filename: it.originalName,
    folderPath: folderPathOf(it.sourcePath ?? undefined),
    sourceTags: it.sourceTags,
  }));
  const suggestions = await categoriser.categorise({ items: catItems, labelSpace });
  const res = await api.categoriseImport(batchId, { categoriser: categoriser.id, suggestions });
  return { items: res.items, categoriser: res.categoriser };
}

export interface CommitProgress {
  total: number;
  done: number;
  created: number;
  failed: number;
  createdNotebooks: Array<{ id: string; name: string }>;
}

const COMMIT_CHUNK = 20;

/** Commit accepted items in small resumable slices, streaming progress. */
export async function commitItems(batchId: string, itemIds: string[], onProgress: (p: CommitProgress) => void): Promise<CommitProgress> {
  const total = itemIds.length;
  let done = 0;
  let created = 0;
  let failed = 0;
  const notebooks = new Map<string, string>();
  for (let i = 0; i < itemIds.length; i += COMMIT_CHUNK) {
    const chunk = itemIds.slice(i, i + COMMIT_CHUNK);
    const res = await api.commitImport(batchId, chunk);
    created += res.created;
    failed += res.failed;
    done += chunk.length;
    for (const nb of res.createdNotebooks) notebooks.set(nb.id, nb.name);
    onProgress({ total, done, created, failed, createdNotebooks: [...notebooks].map(([id, name]) => ({ id, name })) });
  }
  return { total, done, created, failed, createdNotebooks: [...notebooks].map(([id, name]) => ({ id, name })) };
}
