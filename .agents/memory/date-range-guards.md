---
name: Client-side date-range guards
description: Why dashboard date guards must cover lone (single-set) dates, not just complete pairs — the API fills missing dates from today.
---

# Client-side date-range guards must cover lone dates

The dashboards' committed-date hook refuses to apply ranges the API would 400 on
(inverted, or spanning two calendar years — goals are issued per fiscal year),
showing a gentle inline hint and keeping the last valid range applied instead.

**Rule:** when adding a new range validity rule client-side, also handle the
*single-set-date* state. The API defaults a missing start/end from today
(current quarter for overview/website/funnel, current year for leasing), so a
lone date can already violate the rule before the user picks the second date.

**Why:** a user picking "Dec 2025 → Feb 2026" sets the start first; with only
start=2025-12-01 committed, the server resolves end to a 2026 default and 400s
— flashing the destructive banner mid-flow, and leaving a stale error visible
even after the hint appears (the "last valid pair" latched by the hook was
itself a failing query). Guarding a lone date outside the current year fixes
this without replicating server defaults exactly.

**How to apply:** extend `useCommittedDateRange` (rhodes-analytics hooks) and
mirror the rules in `buildFilters`/`buildLeasingFilters` (api-server dashboards
routes). Known remaining gap: a lone *same-year* start after the current
quarter's end still 400s as inverted on quarter-defaulted pages.
