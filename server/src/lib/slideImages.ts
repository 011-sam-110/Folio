// Pull the figures and diagrams out of a slide deck, in slide order.
//
// Text extraction alone loses the part of a lecture slide that is often carrying the
// actual explanation - the graph, the tree diagram, the worked trace. A .pptx is a
// ZIP, so the pictures are already sitting in ppt/media/; the work is not getting the
// bytes out but deciding which ones are worth keeping and which slide each belongs to.
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

export interface SlideImage {
  /** 1-based slide number this image appears on. */
  slide: number;
  /** Original path inside the archive, e.g. ppt/media/image3.png */
  name: string;
  mime: string;
  bytes: Buffer;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
};

// Below this an image is almost certainly a bullet glyph, rule, or icon rather than a
// figure worth putting in someone's notes.
const MIN_BYTES = 12 * 1024;

/**
 * An image on more than this share of slides is template furniture - a university
 * crest, a footer bar, the lecturer's headshot on every page. Keeping them would put
 * the same logo into the note a dozen times.
 *
 * Only applied once there are enough slides for the ratio to mean anything; on a
 * three-slide deck "appears on 40%" is one slide and says nothing.
 */
const UBIQUITY_RATIO = 0.4;
const UBIQUITY_MIN_SLIDES = 5;

function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i === -1 ? '' : p.slice(i).toLowerCase();
}

/** ppt/slides/slide12.xml -> 12, so slides come back in the order they're presented. */
function slideNumber(p: string): number | null {
  const m = /ppt\/slides\/slide(\d+)\.xml$/.exec(p);
  return m ? Number(m[1]) : null;
}

/**
 * Resolve a relationship Target against the slide's own folder.
 * Targets are written relative to ppt/slides/, e.g. "../media/image2.png".
 */
function resolveTarget(target: string): string | null {
  const cleaned = target.replace(/^\.\//, '');
  if (cleaned.startsWith('../')) return 'ppt/' + cleaned.slice(3);
  if (cleaned.startsWith('/')) return cleaned.slice(1);
  return 'ppt/slides/' + cleaned;
}

/**
 * Extract slide images from a .pptx, ordered by slide.
 *
 * Returns an empty array rather than throwing for a deck with no usable pictures, or
 * for a file that turns out not to be a readable ZIP - a failed image pass must not
 * take the whole import down when the text extracted fine.
 */
export async function extractPptxImages(filePath: string): Promise<SlideImage[]> {
  let files: Record<string, Uint8Array>;
  try {
    const buf = await fsp.readFile(filePath);
    files = unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch {
    return [];
  }

  const slidePaths = Object.keys(files)
    .map((p) => ({ p, n: slideNumber(p) }))
    .filter((x): x is { p: string; n: number } => x.n !== null)
    .sort((a, b) => a.n - b.n);
  if (slidePaths.length === 0) return [];

  // Walk each slide's relationship file rather than globbing ppt/media, because the
  // media folder has no ordering and no association with the slides that use it.
  const perSlide: Array<{ slide: number; media: string[] }> = [];
  for (const { p, n } of slidePaths) {
    const rels = files[p.replace(/slides\/slide(\d+)\.xml$/, 'slides/_rels/slide$1.xml.rels')];
    if (!rels) continue;
    const xml = Buffer.from(rels).toString('utf8');
    const media: string[] = [];
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      if (!/Type="[^"]*\/image"/.test(tag)) continue;
      const target = /Target="([^"]+)"/.exec(tag)?.[1];
      if (!target) continue;
      // External images live at a URL, not in the archive; nothing to extract.
      if (/TargetMode="External"/.test(tag) || /^https?:/i.test(target)) continue;
      const resolved = resolveTarget(target);
      if (resolved && files[resolved]) media.push(resolved);
    }
    perSlide.push({ slide: n, media });
  }

  // Count slides-per-image to spot template furniture. Counted by content hash, not
  // path: PowerPoint frequently stores the same logo as several separate media files.
  const hashOf = new Map<string, string>();
  const slidesByHash = new Map<string, Set<number>>();
  for (const { slide, media } of perSlide) {
    for (const name of media) {
      let h = hashOf.get(name);
      if (!h) {
        h = createHash('sha1').update(files[name]).digest('hex');
        hashOf.set(name, h);
      }
      if (!slidesByHash.has(h)) slidesByHash.set(h, new Set());
      slidesByHash.get(h)!.add(slide);
    }
  }

  const applyUbiquity = slidePaths.length >= UBIQUITY_MIN_SLIDES;
  const ubiquityLimit = Math.max(2, Math.ceil(slidePaths.length * UBIQUITY_RATIO));

  const out: SlideImage[] = [];
  const emitted = new Set<string>(); // by hash - the same figure twice adds nothing
  for (const { slide, media } of perSlide) {
    for (const name of media) {
      const bytes = files[name];
      if (!bytes || bytes.byteLength < MIN_BYTES) continue;

      const mime = MIME_BY_EXT[extOf(name)];
      if (!mime) continue; // EMF/WMF vector blobs - no browser renders them

      const h = hashOf.get(name)!;
      if (applyUbiquity && (slidesByHash.get(h)?.size ?? 0) >= ubiquityLimit) continue;
      if (emitted.has(h)) continue;
      emitted.add(h);

      out.push({ slide, name, mime, bytes: Buffer.from(bytes) });
    }
  }

  return out;
}
