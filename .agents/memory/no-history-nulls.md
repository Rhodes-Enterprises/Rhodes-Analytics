---
name: No-history nulls ("no data yet" vs true zero)
description: Months before a data source's history began are null in payloads, never 0; how to compute the cutoff and audit the pattern
---

Some sources have a hard history start (e.g. Google Analytics traffic begins late Oct 2025). Months before that start are "no data yet", not zero — payloads must report them as `null` so charts draw gaps instead of a fake flatline, while true zeros after history began stay `0`.

**Why:** a zero line for pre-tracking months reads as "traffic grew from nothing" — a data-honesty bug, distinct from outage detection (data that STOPS flowing).

**How to apply:**
- Cutoff is data-driven: `MIN(<date col>)` under the same row predicate the counts use — never a hardcoded date. Query it UNFILTERED (history start is a pipeline property, not a view property) and cache it under one global key; a filtered view with no rows after the start is a true 0.
- Compare at month granularity (`year*12 + month0 < startYear*12 + startMonth0`) so the partial first month keeps its real value. Source table empty ⇒ every point of that measure is null.
- Null only the measures fed by that source; other measures keep plain zeros. Expose the cutoff (e.g. `gaHistoryStart`) so the UI can phrase a note.
- Frontend: recharts leaves gaps for nulls only while `connectNulls` stays off; tooltip formatters must be null-safe (recharts `ValueType` rejects `number | null` params — use an inferred param + `Number(v)`); CSV cells become empty (CsvValue already allows null).
- Audits: recompute the cutoff independently, assert the API field equals it, require null on EXACTLY the pre-history months (all 12 points, both years) and numbers everywhere else — this kills both hardcoded cutoffs and null-everything regressions. Pre-history checks pass iff `api === null && baseline === 0`; nulls must NOT count toward vacuity/non-zero guards.
