// Vite resolves `?url` to the emitted (same-origin) asset URL; declare it so tsc accepts the
// pdf.js worker import. Kept scoped to the import feature rather than the global vite-env.
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const src: string;
  export default src;
}
