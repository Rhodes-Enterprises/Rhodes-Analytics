---
name: Client-side date-range guards
description: Dashboard date guards must cover lone (single-set) dates AND derive "today" from America/Chicago like the server — viewer-clock guards fail at boundaries.
---

# Client-side date-range guards

**Rule 1 — guard lone dates, not just complete pairs.** The API fills a
missing start/end from a server-side default range, so a single committed
date can already form a range the server will reject (cross-year, or
inverted against the default) before the user picks the second date. Every
client-side range-validity rule needs a lone-date arm, or the destructive
error banner flashes mid-pick.

**Rule 2 — client guards must use the company calendar, not the viewer's
clock.** The server computes "today" in America/Chicago. Any client-side
mirror of a server default must anchor to that same tz-database date
(Intl.DateTimeFormat en-CA with timeZone America/Chicago) instead of the
local clock, or viewers in other timezones disagree with the server around
quarter/year boundaries — over-holding valid picks or letting a
guaranteed-400 through. A code review rejected a viewer-clock version for
exactly this; "approximate within hours of midnight" is not acceptable for
a guard whose whole job is making the 400 impossible.

**How to apply:** keep the client's default-range math (quarter/year
bounds) in one pure helper with an injectable YYYY-MM-DD "today" (string
arithmetic only — calendar-quarter bounds are fixed dates, so no Date/tz
math), shared by the guards and any "current quarter/year" buttons, with
`node --test` boundary tests injecting dates on both sides of each
transition. If the server's default-filling rules ever change, that helper
and the pages' default-range arguments must change in lockstep.
