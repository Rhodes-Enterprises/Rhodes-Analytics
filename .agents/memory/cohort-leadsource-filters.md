---
name: Cohort & lead-source filter semantics
description: Data semantics that decide how marketing-dashboard filters must bind and how to pick representative audit filter values.
---

# Cohort & lead-source filter semantics

- EHI_COHORT_QUARTER equals the contact's create quarter, so for a date range inside one quarter a cohort filter is a NO-OP for create-date metrics (leads); only tour/sale-date metrics discriminate. Never judge cohort-filter behavior by lead counts alone.
- The filters are asymmetric by design: cohortQuarter applies to contacts only; leadSource applies to contacts (LEAD_SOURCE_OVERVIEW) AND deals (DEAL_LEAD_SOURCE_OVERVIEW); GA/web-traffic never gets either filter. Independent baselines must bind exactly this way or they report fake divergence.
- When picking a representative lead source dynamically, prefer a busy one that also has ratified deals in range: a deal-side check against zero rows passes even when bound to the wrong column.
- The busiest development by leads can be the "General" catch-all bucket, which has no GA-matched traffic, no goal rows, and almost no deals — a representative development pick must require data on every series the filter binds (including a goal type) in the exact checked grid, or the GA/goal bindings are only ever compared 0 vs 0.
- In a two-year × month grid (YoY charts), cohort filters get leads-series discrimination for free: a cohort belongs to exactly one year, so every same-month cell of the OTHER year must go to zero under the filter (plus non-quarter months of its own year). Tour-date series still adds cross-quarter signal.
- Rank representative picks over the exact (year, month) grid the checks query, so at least one non-zero filtered baseline cell is structurally guaranteed — then enforce it with a per-filtered-series vacuity guard. Scenario-wide "all points zero" guards are toothless for asymmetric filters: the GA/goal series stay unfiltered and non-zero, so a dead filter would pass 0=0 forever. (GA history in this project begins 2025-10; earlier GA cells are legitimately 0=0.)

**Why:** verified empirically against live data — a same-quarter cohort filter left lead counts unchanged while tour counts diverged, and deal-side divergence was only detectable for sources that actually had deals.

**How to apply:** any filtered dashboard, audit, or report over these tables — bind baselines with the same asymmetry and pick filter values that hit non-trivial rows on every table the filter touches.
