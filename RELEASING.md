# Releasing Tally

Versions follow semver. `package.json` `version`, `.claude-plugin/plugin.json` `version` and `.claude-plugin/marketplace.json` `plugins[0].version` move together; the plugin only updates for users when the manifest version changes.

## Every release

1. Bump the three versions, add a `CHANGELOG.md` section, run `npm test` (typecheck, bundle, suite), commit. `dist/` is committed: CI fails if it drifts from a fresh `npm run build`.
2. Tag: `git tag -a vX.Y.Z -m "Tally vX.Y.Z"`.
3. Push main, wait for `ci` to be green, then push the tag: `git push origin vX.Y.Z`.
4. The `publish` workflow runs `npm test` again and `npm publish --provenance --access public` through **npm trusted publishing** (OIDC). No token is stored anywhere. If the version already exists on the registry the workflow prints so and does nothing.
5. `gh release create vX.Y.Z --title "Tally vX.Y.Z" --notes-file CHANGELOG.md` (or the GitHub UI).

## One-time: configure trusted publishing on npmjs.com

Trusted publishing can only be configured for a package that already exists, so the very first version (0.1.0) is published by hand from a clean clone (`npm login`, then `npm ci && npm test && npm publish --access public`). After that:

1. Sign in at https://www.npmjs.com and open https://www.npmjs.com/package/@kru3ish/tally/access (Package → Settings).
2. Under **Trusted Publisher**, choose **GitHub Actions** and enter:
   - Organization or user: `kru3ish`
   - Repository: `tally`
   - Workflow filename: `publish.yml`
   - Environment name: leave blank
3. Save. Optionally set **Publishing access** to "Require two-factor authentication and disallow tokens" so only the workflow (and 2FA-protected manual publishes) can publish.
4. Confirm the workflow file still has `permissions: id-token: write` and a step that upgrades npm to 11.5.1 or newer (trusted publishing needs it; Node 22's bundled npm is older).
5. Test on the next tag: the run's publish step should log `npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access` and, on npmjs.com, the version shows a **Provenance** badge linking to the workflow run.

Status 2026-09-22: the trusted publisher was configured for 0.1.1 but the workflow got `403 OIDC permission denied for this action` on two fresh runs (npm 12.0.2, Node 22, `id-token: write`, provenance statement signed). 0.1.1 was published from a laptop with `--provenance=false`; the tag run then re-ran and no-op'd. Before the next tag, compare the four fields on npmjs.com against the workflow claim (`kru3ish` / `tally` / `publish.yml`, environment blank, all case-sensitive) and, if it still fails, delete and re-create the entry.

If a publish must happen from a laptop again (for example the workflow is broken), `npm publish --access public` with `npm login` still works unless "disallow tokens" was enabled; provenance is only available from the workflow.

## Website

`site/index.html` is the landing page, deployed to https://kru3ish.github.io/tally by `.github/workflows/pages.yml` on every push that touches `site/`. GitHub Pages must be enabled once with GitHub Actions as the source: Settings → Pages → Build and deployment → Source: GitHub Actions, or

```bash
curl -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json"   https://api.github.com/repos/kru3ish/tally/pages -d '{"build_type":"workflow"}'
```

The accuracy figures on the page are filled by `npx tsx scripts/fill-calibration.ts` together with the README and the launch drafts.

## Rollback

- Mark a bad version: `npm deprecate @kru3ish/tally@X.Y.Z "reason"` (unpublish is possible only within 72 hours and only as a last resort).
- Ship a fix as a new patch version rather than re-publishing the same one; the registry never accepts a version twice.
- GitHub: `gh release delete vX.Y.Z` and `git push --delete origin vX.Y.Z` remove the release and tag; the repo can be made private again with `gh repo edit kru3ish/tally --visibility private --accept-visibility-change-consequences`.
