## What this changes

<!-- What does this do for an operator or a player, and why? Link the issue if there is one. -->

## Checklist

- [ ] `npm test` passes
- [ ] If shell scripts changed: `shellcheck --severity=warning install.sh deploy.sh scripts/install.sh scripts/iptvhub` passes
- [ ] No new npm dependencies, and no build step
- [ ] Schema changes are a new migration appended to `MIGRATIONS`, not an edit to an existing one
- [ ] Comments, logs and CLI output are in English; new Arabic UI copy has an English comment
- [ ] No real provider URLs, accounts, playlists or databases anywhere in the diff
- [ ] User-visible changes have a line under `[Unreleased]` in `CHANGELOG.md`
