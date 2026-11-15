# Releasing

A release is one action by the owner: pushing a version tag on a commit of `main`. The tag starts
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which checks, tests, builds, installs and runs
the packed package, and publishes that package to npm with a provenance statement. Nothing else publishes: there is
no npm token in the repository, and the workflow runs on `v*` tags only.

The Claude Code plugin is not published anywhere: `/plugin marketplace add sabotage-dev/sabotage-council` reads
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) and [`plugin/`](../plugin/) from this
repository on GitHub, so the plugin a user gets is the one on the repository.

## What the workflow does

On a pushed tag `vX.Y.Z`, in the `release` environment, on `ubuntu-latest` with Node 24:

1. checks out every branch's history and refuses a tag whose commit is not on `main` (`git merge-base --is-ancestor
   HEAD origin/main`): a tag on a feature branch publishes nothing;
2. checks that the tag is `v` + `package.json`'s `version`, that `package.json` is not private, that
   `plugin/.claude-plugin/plugin.json` has the same version, and that the skill pins `sabotage-council@X.Y.Z`;
3. checks that npm is 11.5.1 or later (trusted publishing needs it; Node 24 bundles npm 11);
4. runs `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`, then the built CLI's
   `--version`;
5. packs the package (`npm pack`), installs that tarball into an empty npm prefix with an empty `HOME` and empty XDG
   directories, and runs the installed `sabotage-council --version` (it must print the version) and
   `sabotage-council doctor` (with no config it must exit 1, report the missing config, and still create the run
   store, which applies the migrations from the tarball);
6. publishes that same tarball: `npm publish <tarball>`, with `--tag next` when the version holds a `-` (a prerelease
   such as `0.2.0-rc.1`), else under `latest`. npm authenticates through trusted publishing: it "automatically detects
   OIDC environments and uses them for authentication before falling back to traditional tokens"
   ([npm: trusted publishing](https://docs.npmjs.com/trusted-publishers/)), exchanging the job's ID token
   (`id-token: write`) for a short-lived publish token, and attaches a provenance statement
   (`publishConfig.provenance` in `package.json`); `publishConfig.access` is `public`.

The workflow does not create a GitHub release.

## One-time setup (owner)

Trusted publishing needs npm CLI 11.5.1 or later, Node 22.14.0 or later, a GitHub-hosted runner, and a public
repository whose URL matches `package.json`'s `repository.url` exactly (`git+https://github.com/sabotage-dev/sabotage-council.git`);
provenance is not generated from a private repository. npm attaches a trusted publisher only to a package that
already exists on the registry, so the very first version needs a bootstrap.

1. **npm account.** Use the npm account that will own `sabotage-council`, with two-factor authentication on. Check
   that the name is still free: `npm view sabotage-council` should answer 404. The bootstrap token below can write
   every package its account owns, so prefer an account that owns no other package: then the token can touch
   nothing but `sabotage-council`.
2. **Repository.** Make `sabotage-dev/sabotage-council` public. Add a tag ruleset that lets only you create tags
   matching `v*`: whoever can push such a tag can publish. Turn on **private vulnerability reporting** (Settings,
   Security), which [SECURITY.md](../SECURITY.md) points reporters to.
3. **The `release` environment.** In Settings, Environments, create an environment named `release`. Under
   **Deployment branches and tags**, choose "Selected branches and tags" and add one rule: ref type **Tag**, name
   pattern `v*`. The release job names this environment, so GitHub starts it only for a `v*` tag, and the
   environment's secrets reach only that job (a repository secret would be readable by any workflow).
4. **The first release (0.1.0), with a one-day token.**
   1. On npmjs.com, create a granular access token: read and write on packages (all packages, since
      `sabotage-council` does not exist yet), expiring in one day (the shortest npm allows), with "bypass two-factor
      authentication" on, because the workflow cannot answer a 2FA prompt.
   2. Add it as a secret of the `release` environment named `NPM_BOOTSTRAP_TOKEN` (an environment secret, not a
      repository secret).
   3. Release 0.1.0 as below (tag `v0.1.0`). The publish step hands that token to npm as `NODE_AUTH_TOKEN`; with no
      trusted publisher attached yet, npm falls back to it. The provenance statement still comes from the job's ID
      token.
   4. Delete the `NPM_BOOTSTRAP_TOKEN` secret, and revoke the token on npmjs.com.

   If you would rather not create a token, publish 0.1.0 from your own machine instead: from a clean checkout of the
   tag, `npm ci && npm run build`, then `npm publish --provenance=false`. The flag is needed because `package.json`
   asks for provenance (`publishConfig.provenance`) and npm generates a provenance statement only on a supported
   cloud CI runner such as GitHub Actions
   ([npm: provenance limitations](https://docs.npmjs.com/generating-provenance-statements/)); a flag on the command
   line takes precedence over `publishConfig`. That version then has no provenance statement.
5. **The trusted publisher.** On npmjs.com, open the `sabotage-council` package's **Settings**, then **Trusted
   publishing**, and add a GitHub Actions publisher: organization or user `sabotage-dev`, repository
   `sabotage-council`, workflow filename `release.yml`, environment `release`, and allow `npm publish`.
6. **Lock it down.** In the package's **Settings**, **Publishing access**, choose "Require two-factor authentication
   and disallow tokens". Trusted publishing keeps working (it uses OIDC, not a token), and a leftover token cannot
   publish.

### Confirming the trusted publisher

After steps 4.4, 5 and 6 nothing can publish with a token: the secret is gone, and the package refuses tokens. With
the secret deleted, the publish step sets no `NODE_AUTH_TOKEN` at all (and `actions/setup-node` v7 sets none of its
own), so npm can only authenticate through OIDC, as in npm's own trusted-publishing workflow, which publishes with no
token. The next release therefore confirms it: a green Release run, whose publish step logs npm's "Signed provenance
statement" notice, was published through the trusted publisher. If the publisher form is wrong, that step fails and
nothing is published; correct the form, delete the tag, and push it again.

To confirm it before a real release, release a prerelease first (for example `0.1.1-rc.0`, versioned as below): it is
published under the `next` dist-tag, so `npm install sabotage-council` still installs the latest release.

## Each release

1. On a branch, set the new version (a version with a `-`, such as `0.2.0-rc.1`, is a prerelease and goes to `next`)
   in:
   - `package.json` and `package-lock.json` (`npm version X.Y.Z --no-git-tag-version` sets both);
   - `plugin/.claude-plugin/plugin.json`;
   - the install pin in `plugin/skills/sabotage-council/SKILL.md` (`sabotage-council@X.Y.Z`) and in
     `plugin/README.md`;
   - a new entry at the top of [CHANGELOG.md](../CHANGELOG.md).
2. Merge it to `main`, with CI green.
3. Tag the merge commit on `main` and push the tag (the workflow refuses a tag whose commit is not on `main`):

   ```sh
   git tag vX.Y.Z <merge commit>
   git push origin vX.Y.Z
   ```

4. Watch the Release workflow. If it fails before the publish step, nothing was published: fix it on a branch and tag
   the fix with the same version only after deleting the failed tag, or tag a new patch version.
5. Check the result: `npm view sabotage-council dist-tags` shows the version under `latest` (or `next` for a
   prerelease), and in a project that installed it, `npm audit signatures` verifies its registry signature and
   provenance attestation.
