---
name: Env-var number parsing
description: Number("") === 0 pitfall — how unset env vars silently disable timeouts/budgets, and how to parse them safely.
---

# Parsing numeric env vars

**Rule:** Never parse a numeric env var with `Number(process.env.X ?? "")` (or `Number(X)` where X may be unset) when `0` is a meaningful value. `Number("")`, `Number(null)`, and `Number(" ")` are all `0`, NOT `NaN` — so an "is finite and >= 0" guard accepts them and an unset variable becomes an explicit zero.

**Why:** This silently disabled the audit runner's per-audit watchdog: unset `AUDIT_TIMEOUT_MS` parsed to `0`, `0 >= 0` passed, and "0 = disabled" semantics meant no timer was ever armed. Nothing failed loudly; a code review caught it. The synthetic tests missed it because they always set the env var explicitly — the UNSET path was the broken one.

**How to apply:**
- Treat unset/empty/whitespace as "absent" BEFORE calling `Number()`: `if (raw == null || String(raw).trim() === "") return fallback;`
- Reserve `0` for an explicit opt-out only (`"0"` string present).
- Shared resolver lives in the api-server scripts lib (timeout-config.mjs); the audit runner self-checks its contract at startup so the config cannot rot silently. Reuse the resolver instead of re-inlining `Number(...)`.
- When testing config defaults, always include a run with the variable genuinely unset (`env -u NAME`), not just explicit values.
