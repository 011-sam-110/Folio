// Shared import-kind metadata used by ImportModal and CapturePage.
import type { IconName } from '../../components/Icon';

export type ImportKind = 'photo' | 'slides' | 'transcript';

export interface KindConfig {
  key: ImportKind;
  label: string;
  /** Vector icon (interactive chrome) — emoji is reserved for user content per Icon.tsx. */
  iconName: IconName;
  accept: string;
  hint: string;
  exts: string[];
  mimePrefixes?: string[];
}

export const IMPORT_KINDS: KindConfig[] = [
  {
    key: 'photo',
    label: 'Photo of notes',
    iconName: 'camera',
    accept: 'image/*,.heic,.heif',
    hint: 'JPEG, PNG, WEBP or HEIC · up to 25MB',
    exts: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],
    mimePrefixes: ['image/'],
  },
  {
    key: 'slides',
    label: 'Lecture slides',
    iconName: 'layers',
    accept: '.pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation',
    hint: 'PDF or PPTX · up to 25MB',
    exts: ['pdf', 'pptx'],
  },
  {
    key: 'transcript',
    label: 'Transcript or essay',
    iconName: 'file-text',
    accept: '.txt,.md,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    hint: 'TXT, MD, PDF or DOCX · up to 25MB',
    exts: ['txt', 'md', 'pdf', 'docx'],
  },
];

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function findKind(kind: ImportKind): KindConfig {
  return IMPORT_KINDS.find(k => k.key === kind) ?? IMPORT_KINDS[0];
}

/** Inline validation: type + size. Returns a human-readable error, or null if the file is fine. */
export function validateFile(file: File, kind: ImportKind): string | null {
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is over the 25MB limit`;
  }
  const config = findKind(kind);
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mimeOk = config.mimePrefixes?.some(prefix => file.type.startsWith(prefix)) ?? false;
  const extOk = config.exts.includes(ext);
  if (!mimeOk && !extOk) {
    return `${file.name} isn't a supported file for ${config.label.toLowerCase()}`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
