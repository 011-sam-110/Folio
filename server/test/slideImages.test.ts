import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { extractPptxImages } from '../src/lib/slideImages.js';

/**
 * The checked-in .pptx fixtures are 2KB synthetic text-only decks with no media at
 * all, so they exercise none of this. These tests build real archives instead, with
 * the exact shapes that make naive extraction produce a mess: a crest repeated on
 * every slide, bullet-sized icons, and the same figure reused on two slides.
 */

const tmpFiles: string[] = [];

afterAll(() => {
  for (const f of tmpFiles) fs.rmSync(f, { force: true });
});

/** Deterministic pseudo-image bytes of a given size; `seed` varies the content hash. */
function fakeImage(sizeBytes: number, seed: number): Uint8Array {
  const b = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) b[i] = (i * 31 + seed * 17) % 251;
  return b;
}

function rels(targets: string[]): Uint8Array {
  const body = targets
    .map(
      (t, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${t}"/>`,
    )
    .join('');
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`,
  );
}

/** Build a .pptx on disk. `slides[i]` lists the media targets referenced by slide i+1. */
function buildPptx(slides: string[][], media: Record<string, Uint8Array>): string {
  const files: Record<string, Uint8Array> = {};
  const slideXml = new TextEncoder().encode('<?xml version="1.0"?><p:sld/>');
  slides.forEach((targets, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = slideXml;
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels(targets);
  });
  for (const [name, bytes] of Object.entries(media)) files[`ppt/media/${name}`] = bytes;

  const file = path.join(os.tmpdir(), `folio-slidetest-${Date.now()}-${Math.random().toString(36).slice(2)}.pptx`);
  fs.writeFileSync(file, Buffer.from(zipSync(files)));
  tmpFiles.push(file);
  return file;
}

const FIGURE_A = fakeImage(40 * 1024, 1);
const FIGURE_B = fakeImage(50 * 1024, 2);
const CREST = fakeImage(30 * 1024, 3);
const TINY_ICON = fakeImage(2 * 1024, 4);

describe('extractPptxImages', () => {
  it('returns figures in slide order', async () => {
    const file = buildPptx(
      [[], ['../media/figA.png'], [], ['../media/figB.png'], [], []],
      { 'figA.png': FIGURE_A, 'figB.png': FIGURE_B },
    );
    const out = await extractPptxImages(file);
    expect(out.map((i) => i.slide)).toEqual([2, 4]);
    expect(out[0].mime).toBe('image/png');
    expect(out[0].bytes.length).toBe(FIGURE_A.length);
  });

  it('drops template furniture that appears on most slides', async () => {
    // A crest on all six slides is decoration; the one real figure must survive.
    const file = buildPptx(
      [
        ['../media/crest.png'],
        ['../media/crest.png', '../media/figA.png'],
        ['../media/crest.png'],
        ['../media/crest.png'],
        ['../media/crest.png'],
        ['../media/crest.png'],
      ],
      { 'crest.png': CREST, 'figA.png': FIGURE_A },
    );
    const out = await extractPptxImages(file);
    expect(out).toHaveLength(1);
    expect(out[0].slide).toBe(2);
    expect(out[0].bytes.length).toBe(FIGURE_A.length);
  });

  it('does not apply the ubiquity rule to very short decks', async () => {
    // On a 2-slide deck "on both slides" is not evidence of decoration.
    const file = buildPptx(
      [['../media/figA.png'], ['../media/figB.png']],
      { 'figA.png': FIGURE_A, 'figB.png': FIGURE_B },
    );
    const out = await extractPptxImages(file);
    expect(out).toHaveLength(2);
  });

  it('skips bullet-sized icons', async () => {
    const file = buildPptx(
      [['../media/icon.png'], ['../media/figA.png'], [], [], [], []],
      { 'icon.png': TINY_ICON, 'figA.png': FIGURE_A },
    );
    const out = await extractPptxImages(file);
    expect(out.map((i) => i.slide)).toEqual([2]);
  });

  it('deduplicates the same figure reused across slides, keeping the first', async () => {
    // PowerPoint often stores a re-pasted image as a separate media entry, so
    // dedupe has to be by content, not by filename.
    const file = buildPptx(
      [[], ['../media/figA.png'], [], ['../media/figA-copy.png'], [], []],
      { 'figA.png': FIGURE_A, 'figA-copy.png': FIGURE_A },
    );
    const out = await extractPptxImages(file);
    expect(out).toHaveLength(1);
    expect(out[0].slide).toBe(2);
  });

  it('ignores formats no browser can render', async () => {
    const file = buildPptx(
      [['../media/diagram.emf'], ['../media/figA.png'], [], [], [], []],
      { 'diagram.emf': fakeImage(60 * 1024, 5), 'figA.png': FIGURE_A },
    );
    const out = await extractPptxImages(file);
    expect(out.map((i) => i.name)).toEqual(['ppt/media/figA.png']);
  });

  it('ignores externally-linked images that are not in the archive', async () => {
    const file = buildPptx(
      [['https://example.com/remote.png'], ['../media/figA.png'], [], [], [], []],
      { 'figA.png': FIGURE_A },
    );
    const out = await extractPptxImages(file);
    expect(out.map((i) => i.slide)).toEqual([2]);
  });

  it('returns empty rather than throwing for a file that is not a zip', async () => {
    const file = path.join(os.tmpdir(), `folio-notazip-${Date.now()}.pptx`);
    fs.writeFileSync(file, 'this is plainly not a pptx');
    tmpFiles.push(file);
    // A failed image pass must never take down an import whose text extracted fine.
    await expect(extractPptxImages(file)).resolves.toEqual([]);
  });
});
