/**
 * Parse a time-budget environment value into milliseconds.
 *
 * The pitfall this guards: Number("") is 0, NOT NaN — so a naive
 * `Number(process.env.X ?? "")` silently turns "env var not set" into
 * "budget disabled", which is how a watchdog rots without anyone noticing.
 *
 * Contract:
 *  - unset / empty / whitespace / unparseable / negative → `fallbackMs`
 *  - explicit "0" → 0 (deliberately disables the budget)
 *  - any other finite non-negative number → itself
 */
export function resolveBudgetMs(raw, fallbackMs) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
}
