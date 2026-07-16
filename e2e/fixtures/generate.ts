/**
 * Deterministic fixture generator for the e2e suite.
 *
 * Run once (manually, or whenever a fixture needs regenerating) with:
 *   npx tsx e2e/fixtures/generate.ts
 *
 * Produces, into this folder:
 *   - transcript.txt  — a fake lecture transcript on deadlocks (plain text)
 *   - slides.pdf      — a hand-built 3-page PDF about SQL JOINs (raw PDF objects, no deps)
 *   - note-photo.png  — a 1200x900 white bitmap with rendered "handwritten-ish" lecture
 *                        notes text about OS scheduling, drawn via Windows System.Drawing
 *
 * These are committed to the repo so the e2e suite never depends on regenerating them,
 * but this script is kept so they can be reproduced/edited deterministically.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIXTURES_DIR = __dirname;

// ---------------------------------------------------------------------------
// 1. transcript.txt — fake lecture transcript on deadlocks
// ---------------------------------------------------------------------------

function writeTranscript(): void {
  const lines = [
    'CS304 Operating Systems — Lecture 11 transcript',
    'Recorded lecture, auto-captioned, lightly cleaned up. Topic: deadlocks.',
    '',
    "Okay, let's get started. Today we're talking about deadlocks, which is one of",
    'the classic problems in operating systems whenever you have multiple processes',
    'competing for a limited set of resources.',
    '',
    'So first, what actually is a deadlock? A deadlock is a situation where a set of',
    'processes are each waiting for a resource that another process in that same set',
    'is holding, and none of them can ever make progress. Nobody backs off, so',
    'everybody just sits there forever.',
    '',
    'There are four conditions that all have to hold at once for a deadlock to be',
    'possible. These are usually called the Coffman conditions, named after Edward',
    'Coffman who wrote them up in the early seventies.',
    '',
    'The first condition is mutual exclusion. At least one resource has to be held',
    'in a non-shareable mode — only one process can use it at a time.',
    '',
    'The second condition is hold and wait. A process is currently holding at least',
    'one resource and is simultaneously waiting to acquire additional resources that',
    'are currently being held by other processes.',
    '',
    'The third condition is no preemption. Resources cannot be forcibly taken away',
    'from a process. A resource can only be released voluntarily by the process',
    'holding it, once that process has finished using it.',
    '',
    'And the fourth condition is circular wait. There has to be a set of processes',
    'P1, P2, up to Pn, such that P1 is waiting for a resource held by P2, P2 is',
    'waiting for a resource held by P3, and so on, until Pn is waiting for a',
    'resource held by P1. That closes the loop.',
    '',
    'If you break any single one of these four conditions, deadlock becomes',
    'impossible. That gives us our main strategies. Deadlock prevention attacks one',
    'of the four conditions directly — for example, requesting all resources up',
    'front removes hold and wait.',
    '',
    'Deadlock avoidance is more dynamic — the classic example is the Banker\'s',
    'algorithm, which only grants a resource request if the resulting state is still',
    'safe, meaning there exists some ordering of processes that can all finish.',
    '',
    'Deadlock detection and recovery just lets deadlocks happen, periodically runs a',
    'cycle-detection algorithm over a resource-allocation graph, and kills or rolls',
    'back a process to break the cycle when one is found.',
    '',
    'And finally some systems just do deadlock ignorance — the ostrich algorithm —',
    'and assume deadlocks are rare enough that it is cheaper to reboot than to pay',
    'the constant overhead of prevention or detection. That is actually what most',
    'general-purpose operating systems do in practice.',
    '',
    "That's it for today — next lecture we'll move on to memory management and",
    'paging. Read chapter seven before Thursday.',
  ];
  fs.writeFileSync(path.join(FIXTURES_DIR, 'transcript.txt'), lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// 2. slides.pdf — hand-written raw PDF, 3 pages of fake lecture slides on SQL JOINs
// ---------------------------------------------------------------------------

function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function slideContentStream(title: string, bullets: string[]): string {
  const parts: string[] = [];
  parts.push('BT');
  parts.push('/F1 20 Tf');
  parts.push('72 740 Td');
  parts.push(`(${escapePdfText(title)}) Tj`);
  parts.push('/F1 13 Tf');
  parts.push('0 -40 Td');
  parts.push('18 TL');
  bullets.forEach((b, i) => {
    parts.push(`(${escapePdfText('- ' + b)}) Tj`);
    if (i < bullets.length - 1) parts.push('T*');
  });
  parts.push('ET');
  return parts.join('\n');
}

interface Slide {
  title: string;
  bullets: string[];
}

const SLIDES: Slide[] = [
  {
    title: 'Lecture 5: SQL JOINs',
    bullets: [
      'Today: combining rows from two or more tables using a related column.',
      'An INNER JOIN returns only rows with matching values in both tables.',
      'Syntax: SELECT * FROM A INNER JOIN B ON A.id = B.a_id.',
      'Non-matching rows are excluded from an INNER JOIN entirely.',
    ],
  },
  {
    title: 'Outer JOINs',
    bullets: [
      'A LEFT JOIN keeps every row from the left table, matched or not.',
      'A RIGHT JOIN keeps every row from the right table, matched or not.',
      'A FULL OUTER JOIN keeps unmatched rows from both sides, filling NULLs.',
      'Use LEFT JOIN whenever you must not lose rows from the primary table.',
    ],
  },
  {
    title: 'Self JOINs and JOIN performance',
    bullets: [
      'A SELF JOIN joins a table to itself using two different aliases.',
      "Common use case: finding an employee's manager in the same table.",
      'JOIN performance depends heavily on indexes on the join columns.',
      'Always check EXPLAIN when a multi-table JOIN query feels slow.',
    ],
  },
];

function buildPdf(slides: Slide[]): Buffer {
  // Object numbering: 1 Catalog, 2 Pages, then per-slide (Page, Contents) pairs, then Font.
  const contentStreams = slides.map((s) => slideContentStream(s.title, s.bullets));
  const pageObjNums = slides.map((_, i) => 3 + i * 2); // 3, 5, 7
  const contentObjNums = slides.map((_, i) => 4 + i * 2); // 4, 6, 8
  const fontObjNum = 3 + slides.length * 2; // 9

  const objects: string[] = [];
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${slides.length} >>\nendobj\n`;

  slides.forEach((_, i) => {
    const pageNum = pageObjNums[i];
    const contentNum = contentObjNums[i];
    objects[pageNum] =
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`;
    const stream = contentStreams[i];
    const len = Buffer.byteLength(stream, 'utf8');
    objects[contentNum] = `${contentNum} 0 obj\n<< /Length ${len} >>\nstream\n${stream}\nendstream\nendobj\n`;
  });

  objects[fontObjNum] = `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  const totalObjects = fontObjNum; // objects numbered 1..fontObjNum
  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = new Array(totalObjects + 1).fill(0);
  let cursor = Buffer.byteLength(header, 'utf8');
  for (let n = 1; n <= totalObjects; n++) {
    offsets[n] = cursor;
    const objStr = objects[n];
    if (!objStr) throw new Error(`missing object ${n}`);
    body += objStr;
    cursor += Buffer.byteLength(objStr, 'utf8');
  }

  const xrefStart = cursor;
  let xref = `xref\n0 ${totalObjects + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let n = 1; n <= totalObjects; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n` + `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(header + body + xref + trailer, 'utf8');
}

async function writeAndVerifySlidesPdf(): Promise<void> {
  const pdfBuffer = buildPdf(SLIDES);
  const outPath = path.join(FIXTURES_DIR, 'slides.pdf');
  fs.writeFileSync(outPath, pdfBuffer);

  // Verify it actually parses with unpdf (same lib the import route uses server-side).
  const { getDocumentProxy, extractText } = await import('unpdf');
  const data = new Uint8Array(fs.readFileSync(outPath));
  const pdf = await getDocumentProxy(data);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  if (totalPages !== SLIDES.length) {
    throw new Error(`slides.pdf: expected ${SLIDES.length} pages, unpdf saw ${totalPages}`);
  }
  if (!/JOIN/i.test(text)) {
    throw new Error('slides.pdf: extracted text does not mention JOIN — fixture is broken');
  }
  console.log(`[fixtures] slides.pdf OK — ${totalPages} pages, ${text.length} chars extracted, contains "JOIN"`);
}

// ---------------------------------------------------------------------------
// 3. note-photo.png — rendered lecture-notes text via Windows System.Drawing
// ---------------------------------------------------------------------------

const PHOTO_LINES = [
  'CS204 Operating Systems',
  'Lecture 7: CPU Scheduling',
  'Scheduling decides which process runs next on the CPU.',
  'FCFS: First-Come First-Served, non-preemptive, causes convoy effect.',
  'SJF: Shortest Job First minimizes average waiting time.',
  'Round Robin uses a fixed time quantum for fairness.',
  'Priority scheduling can starve low-priority processes without aging.',
  'Multilevel feedback queues combine several scheduling policies.',
];

function writeNotePhotoPng(): void {
  const outPath = path.join(FIXTURES_DIR, 'note-photo.png');
  const linesLiteral = PHOTO_LINES.map((l) => `'${l.replace(/'/g, "''")}'`).join(",\n  ");

  const script = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(1200, 900)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Consolas', 28, [System.Drawing.FontStyle]::Regular)
$brush = [System.Drawing.Brushes]::Black
$lines = @(
  ${linesLiteral}
)
$y = 60
foreach ($line in $lines) {
  $g.DrawString($line, $font, $brush, 50, $y)
  $y += 95
}
$bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`;

  const scriptPath = path.join(os.tmpdir(), `folio-note-photo-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      stdio: 'inherit',
    });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }

  if (!fs.existsSync(outPath)) {
    throw new Error('note-photo.png was not created by the PowerShell script');
  }
  const size = fs.statSync(outPath).size;
  if (size < 10 * 1024) {
    throw new Error(`note-photo.png is too small (${size} bytes) — rendering likely failed`);
  }
  console.log(`[fixtures] note-photo.png OK — ${size} bytes`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  writeTranscript();
  console.log('[fixtures] transcript.txt OK');

  await writeAndVerifySlidesPdf();

  writeNotePhotoPng();

  console.log('[fixtures] all fixtures generated in', FIXTURES_DIR);
}

main().catch((err) => {
  console.error('[fixtures] generation failed:', err);
  process.exit(1);
});
