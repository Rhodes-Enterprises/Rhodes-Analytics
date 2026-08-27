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
