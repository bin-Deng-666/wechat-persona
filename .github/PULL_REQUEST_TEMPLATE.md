<!--
Keep pull requests focused. Small, single-purpose changes are reviewed faster
and are much easier to revert if something regresses.
-->

## What and why

<!-- One or two sentences. What changes, and what problem does it solve? -->

## Related issues

<!-- e.g. Closes #12, Refs #34. Delete if not applicable. -->

## Type of change

- [ ] Bug fix (no behaviour change beyond the fix)
- [ ] New feature (adds capability)
- [ ] Refactor (no behaviour change)
- [ ] Documentation only
- [ ] Build, CI or tooling
- [ ] Breaking change (existing sessions, config or stored data change meaning)

## Checklist

- [ ] I read `CONTRIBUTING.md` and `docs/structure.md`.
- [ ] The change is in the module that owns the responsibility.
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass locally.
- [ ] I added or updated tests for the behaviour I changed.
- [ ] I updated docs when user-visible behaviour, paths or commands changed.
- [ ] No credentials, QR payloads, private chat content or real account ids are committed.
- [ ] The package version and `CHANGELOG.md` are updated if a release is intended.

## How it was verified

<!--
Real steps, not "should work". For message-path changes, say what you sent and
what came back. State clearly what you could only verify locally, and what still
needs an actual WeChat client.
-->

## Notes for reviewers

<!-- Trade-offs, alternatives rejected, follow-up work, or areas you want a second opinion on. -->
