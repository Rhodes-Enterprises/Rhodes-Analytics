---
name: Headless browser automation in this workspace
description: Working recipe for browser-driven checks (UI audits, screenshots) on Replit/NixOS, and the durable principles behind the last-mile UI-binding audit.
---

# Headless browser automation (playwright)

Use `playwright-core` (pure JS, no postinstall download) plus the Nix `chromium`
system dependency, launched with an explicit `executablePath` (`which chromium`)
and `--no-sandbox --disable-dev-shm-usage --disable-gpu`.

**Why:** Playwright's own downloaded browser builds are linked for Debian-ish
distros and do not run on NixOS; the Nix chromium works headless out of the box
(dbus stderr noise is harmless).

**How to apply:** any check that needs a real browser. Keep the binary path
env-overridable rather than hardcoding a /nix/store path.

# Filter-wiring & render-lifecycle audit principles

- Judge wiring by the **exact query-param multiset** of the page's own next
  request after driving one control (missing/extra/duplicated/renamed/
  wrong-valued all fail, naming the control + actual query string) — and
  assert reset-to-All *omits* the sentinel (an `__all__` leak is a wiring
  bug too).
- A value-equality "re-rendered" check is **vacuous** whenever a filter
  legitimately leaves the audited cells unchanged (e.g. contact-scoped
  filters vs a sales headline): stale mounted DOM passes it. Prove the
  DOM↔request binding instead: withhold the response at the route layer and
  require the loading state while held; only then trust value equality
  against the released payload.
- Never fail on the first transient 5xx/429 from the shared proxy: keep
  judging the page's own retry requests (their params must match too). 4xx
  is never transient.
- Data-gated UI must be audited in both directions: required when the
  payload says present, required-absent when it says empty — anything else
  goes red on data drift or passes vacuously.
- Mutation-test wiring audits both ways: planted miswirings AND a planted
  stale mount (headline frozen to the first payload) must each fail with
  correct attribution before the audit is trusted.

# UI-binding audit principles

- Compare rendered DOM values against the **page's own captured response**
  (via response interception), never a separately issued request — otherwise
  you may compare against different data.
- Anchor cells by **column header**, and require the rendered header multiset
  to equal the audited binding map **exactly** — an added, renamed, or
  duplicated column must fail (it is an unaudited binding), and cell checks
  must not run against an unrecognized layout.
- Normalize formatting (thousands separators, %, null placeholders, fraction
  vs percent units) and tolerate only display rounding: half a unit of the
  last rendered decimal place.
- Mutation-test every new audit before trusting it: swapped columns,
  wrong-field bindings, and an injected duplicate/extra column must each
  exit non-zero. (Swapping two numerically equal values is invisible by
  construction and harmless — same digits shown.)
- The binding map must move WITH the page: adding rows/captions to an audited
  page without extending the UI audit's binding map turns the audit red for
  every downstream task (unbound rows fail by design). Land both in one change.
- Conditionally rendered rows must be bound presence-iff the page's own
  visibility rule (e.g. section hidden when its bucket is empty): expected
  present AND checked when the condition holds, expected absent otherwise —
  and derived sub-lines (shares) must mirror the page's exact formatting,
  including special cases like "<1" for sub-1% values.
## Conditional page sections (hidden-when-zero)

UI-binding audits must gate conditional sections on the SAME payload condition the page uses (e.g. unknown-channel matrix rows render only when that bucket is non-zero): expect the rows when the condition holds, fail if they render when it doesn't, and fail if they're missing when it does.

**Why:** a binding map of always-on rows breaks later — a page feature merged after the audit was written, plus a data shift that first makes the condition true, surfaces as "unknown row label" failures on a perfectly green page (this actually happened with the overview unknown-channel rows).

**How to apply:** when adding rows/sections to an audited page, mirror the visibility predicate into the UI audit's binding map in the same change; recompute derived sub-labels (shares, "<1%" special cases) exactly as the page does.
