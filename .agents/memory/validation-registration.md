---
name: setValidationCommand Run-button side effect
description: Validation registration can hijack the Run button via a "Project" wrapper workflow.
---

**Rule:** After registering a validation command, verify no "Project" wrapper workflow appeared around it; if one did, delete the wrapper and keep only the workflow marked as validation.

**Why:** The Run button targets the "Project" workflow. Registration sometimes auto-creates that wrapper around the new validation command, silently turning the user's Run button into a one-shot test/audit run instead of launching the app. This has recurred across tasks and fails completion code review.
