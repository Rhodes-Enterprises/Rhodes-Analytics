---
name: Unit tests in artifact packages
description: Vitest config separation and validation wiring for artifact test suites.
---

**Rule:** A test-bearing artifact package needs its own vitest config; never let vitest fall back to the artifact's vite config. All suites share the single `test` validation command — extend it rather than adding parallel commands.

**Why:** Artifact vite configs require workflow-provided env vars and throw when loaded from a plain shell, which would kill any test or validation run before a single test is collected. The package tsconfigs exclude test files, so the vitest run is the only check that exercises tests — a passing typecheck says nothing about them.
