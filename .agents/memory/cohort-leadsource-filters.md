---
name: Cohort & lead-source filter semantics
description: Data semantics that decide how marketing-dashboard filters must bind and how to pick representative audit filter values.
---

# Cohort & lead-source filter semantics

- EHI_COHORT_QUARTER equals the contact's create quarter, so for a date range inside one quarter a cohort filter is a NO-OP for create-date metrics (leads); only tour/sale-date metrics discriminate. Never judge cohort-filter behavior by lead counts alone.
- The filters are asymmetric by design: cohortQuarter applies to contacts only; leadSource applies to contacts (LEAD_SOURCE_OVERVIEW) AND deals (DEAL_LEAD_SOURCE_OVERVIEW); GA/web-traffic never gets either filter. Independent baselines must bind exactly this way or they report fake divergence.
- When picking a representative lead source dynamically, prefer a busy one that also has ratified deals in range: a deal-side check against zero rows passes even when bound to the wrong column.

**Why:** verified empirically against live data — a same-quarter cohort filter left lead counts unchanged while tour counts diverged, and deal-side divergence was only detectable for sources that actually had deals.

**How to apply:** any filtered dashboard, audit, or report over these tables — bind baselines with the same asymmetry and pick filter values that hit non-trivial rows on every table the filter touches.
