# Releasing

A release is one action by the owner: pushing a version tag. The tag starts
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which checks, tests, builds and publishes the npm
package with a provenance statement. Nothing else publishes: there is no npm token in the repository, and the
workflow runs on `v*` tags only.

The Claude Code plugin is not published anywhere: `/plugin marketplace add sabotage-dev/sabotage-council` reads
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) and [`plugin/`](../plugin/) from this
repository on GitHub, so the plugin a user gets is the one on the repository.

## What the workflow does

On a pushed tag `vX.Y.Z`, on `ubuntu-latest` with Node 24:

1. checks that the tag is `v` + `package.json`'s `version`, that `package.json` is not private, that
   `plugin/.claude-plugin/plugin.json` has the same version, and that the skill pins `sabotage-council@X.Y.Z`;
2. checks that npm is 11.5.1 or later (trusted publishing needs it; Node 24 bundles npm 11);
3. runs `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`, then the built CLI's
   `--version`;
4. runs `npm publish`. npm exchanges the job's OIDC token (`id-token: write`) for a short-lived publish token, and
   attaches a provenance statement (`publishConfig.provenance` in `package.json`); `publishConfig.access` is `public`.

The workflow publishes under the `latest` dist-tag. It does not create a GitHub release.

## One-time setup (owner)

Trusted publishing needs npm CLI 11.5.1 or later, Node 22.14.0 or later, a GitHub-hosted runner, and a public
repository whose URL matches `package.json`'s `repository.url` exactly (`git+https://github.com/sabotage-dev/sabotage-council.git`);
provenance is not generated from a private repository. npm attaches a trusted publisher only to a package that
already exists on the registry, so the very first version needs a bootstrap.

1. **npm account.** Use the npm account that will own `sabotage-council`, with two-factor authentication on. Check
   that the name is still free: `npm view sabotage-council` should answer 404.
2. **Repository.** Make `sabotage-dev/sabotage-council` public. Add a tag ruleset that lets only you create tags
   matching `v*`: whoever can push such a tag can publish. Turn on **private vulnerability reporting** (Settings,
   Security), which [SECURITY.md](../SECURITY.md) points reporters to.
3. **The first release (0.1.0), with a one-day token.**
   1. On npmjs.com, create a granular access token: read and write on packages (all packages, since
      `sabotage-council` does not exist yet), expiring in one day (the shortest npm allows), with "bypass two-factor
      authentication" on, because the workflow cannot answer a 2FA prompt.
   2. Add it to the repository as the Actions secret `NPM_BOOTSTRAP_TOKEN`.
   3. Release 0.1.0 as below (tag `v0.1.0`). The workflow publishes with that token; the provenance statement still
      comes from the job's ID token.
   4. Delete the `NPM_BOOTSTRAP_TOKEN` secret, and revoke the token on npmjs.com.

   If you would rather not create a token, publish 0.1.0 from your own machine instead (`npm publish` from a clean
   checkout of the tag, after `npm ci && npm run build`); that version then has no provenance statement.
4. **The trusted publisher.** On npmjs.com, open the `sabotage-council` package's **Settings**, then **Trusted
   publishing**, and add a GitHub Actions publisher: organization or user `sabotage-dev`, repository
   `sabotage-council`, workflow filename `release.yml`, no environment, and allow `npm publish`.
5. **Lock it down.** In the package's **Settings**, **Publishing access**, choose "Require two-factor authentication
   and disallow tokens". Trusted publishing keeps working (it uses OIDC, not a token), and a leftover token cannot
   publish.

## Each release

1. On a branch, set the new version in:
   - `package.json` and `package-lock.json` (`npm version X.Y.Z --no-git-tag-version` sets both);
   - `plugin/.claude-plugin/plugin.json`;
   - the install pin in `plugin/skills/sabotage-council/SKILL.md` (`sabotage-council@X.Y.Z`) and in
     `plugin/README.md`;
   - a new entry at the top of [CHANGELOG.md](../CHANGELOG.md).
2. Merge it, with CI green.
3. Tag the merge commit and push the tag:

   ```sh
   git tag vX.Y.Z <merge commit>
   git push origin vX.Y.Z
   ```

4. Watch the Release workflow. If it fails before `npm publish`, nothing was published: fix it on a branch and tag
   the fix with the same version only after deleting the failed tag, or tag a new patch version.
5. Check the result: `npm view sabotage-council@X.Y.Z` shows the version, and in a project that installed it,
   `npm audit signatures` verifies its registry signature and provenance attestation.
