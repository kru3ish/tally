# Add Windows install note to README

Windows PowerShell blocks npm's launcher scripts by default, so `tally` and `npm`
fail with "running scripts is disabled on this system".

## Acceptance criteria
1. The README install section has a short "Windows" note describing this error.
2. The note shows the fix: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`.
3. The note shows the no-settings alternative: run `tally.cmd` (and `npm.cmd`) instead.
4. CHANGELOG.md has an entry for this under the unreleased section.

## Constraints
- Only README.md and CHANGELOG.md change.
