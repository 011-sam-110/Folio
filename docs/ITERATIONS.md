# Folio iteration log

Rule: after the first full build, run ≥10 critique→fix→test iterations. Each iteration records:
critic findings (holes, missing features, bugs), what was fixed, test results, and what carries forward.
An iteration only counts when the full test suite (vitest + playwright) is green at its end.

| # | Focus | Critic findings | Fixed | Tests | Carried forward |
|---|-------|----------------|-------|-------|-----------------|

## Iteration entries

### Iteration 0 — Integration (2026-07-16, commit 84a1206)
Opus captain drove wave-1 output to green: 57/57 vitest, 23/23 e2e ×2 (0 flaky), real-gateway AI smokes,
single-port SPA mode, zero console errors. Notable product bugs fixed: StrictMode-stranded autosave,
wikilink alias pipe breaking link extraction, navigation racing the autosave debounce, unpdf Buffer rejection,
flashcards JSON retry. Contract patches: GET /api/study/cards (Patch A), SM-2 new-card hard/easy (Patch B).
Carried forward: 1.5MB single bundle (no code-splitting); no eager loading state for AI modal.
