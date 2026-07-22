# Unote iteration log

Rule: after the first full build, run ≥10 critique→fix→test iterations. Each iteration records:
critic findings (holes, missing features, bugs), what was fixed, test results, and what carries forward.
An iteration only counts when the full test suite (vitest + playwright) is green at its end.

| # | Focus | Critic findings | Fixed | Tests | Carried forward |
|---|-------|----------------|-------|-------|-----------------|

## Iteration entries

### Iteration 1: Five-lens critique + 29-fix wave (2026-07-16/17, commits 8e80c54, 002a0ae, 3b06329)
Critics: feature-gap, server-bughunt, web-bughunt, design, student-persona → 92 findings (11 critical),
full detail in docs/reviews/iter1-findings.json. All 11 criticals + 18 majors fixed (docs/reviews/iter1-fixes.md):
editor data-integrity races (stale-load, failed-save dirty flag, in-flight flush, restore/import resync),
import race lock, rename re-links backlinks, contentJson validation, soft-delete+undo+30d purge, CORS lockdown,
AI size caps, SM-2 relearn escape, pptx/docx end-to-end, capture multi-page chaining, attachment originals strip,
server-side wikilink+math nodes in imports, study notebook filter, mobile dashboard overflow, contrast, icons.
Tests: 76/76 vitest (+19), e2e 23→34 green ×2 consecutively; review-pack 18/18 clean.
Carried forward: free-gateway vision quota is the top e2e reliability risk (consider mock-gateway mode);
gateway silently substitutes models; client-side AI-apply still inserts wikilinks as literal text;
versions.spec.ts page-wide /restor/i selector brittle. Deferred feature systems → iteration 2.

### Iteration 0: Integration (2026-07-16, commit 84a1206)
Opus captain drove wave-1 output to green: 57/57 vitest, 23/23 e2e ×2 (0 flaky), real-gateway AI smokes,
single-port SPA mode, zero console errors. Notable product bugs fixed: StrictMode-stranded autosave,
wikilink alias pipe breaking link extraction, navigation racing the autosave debounce, unpdf Buffer rejection,
flashcards JSON retry. Contract patches: GET /api/study/cards (Patch A), SM-2 new-card hard/easy (Patch B).
Carried forward: 1.5MB single bundle (no code-splitting); no eager loading state for AI modal.
