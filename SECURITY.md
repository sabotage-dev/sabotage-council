# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**
(<https://github.com/sabotage-dev/sabotage-council/security/advisories/new>). Do not open a public issue or pull
request for a vulnerability.

Useful in a report: the version (`sabotage-council --version`), your OS and Node version, the backend and CLI version
involved (`sabotage-council doctor` prints them), what you did, what happened, and what you expected. A reproduction
on a throwaway repository is the most helpful thing you can send. Leave out credentials and private code.

## Scope

In scope: the engine (the npm package `sabotage-council`), the Claude Code plugin in [plugin/](plugin/), and the
release workflow. Examples: a way for reviewed content to make a seat or the adjudicator act on the machine, a read
outside the review root that ratification does not catch, a credential reaching a leg, a stored record or a posted
review, a posted review the validator should have refused, or a round that approves when it should not.

Out of scope: vulnerabilities in the third-party CLIs themselves (Codex, Claude Code, Grok, Antigravity, Kiro,
opencode, Cursor, Muse); please report those to their vendors. How sabotage-council relies on them is in scope. The
enforcement gaps already documented (each backend's label and what its canary did not prove) are known; a way past a
`strong` seat's enforcement is in scope.

## Supported versions

Fixes go into the latest release. sabotage-council is at 0.x: there are no backports to earlier versions.

## How the tool defends itself

[docs/security.md](docs/security.md) describes the security model: what a seat can and cannot do per enforcement
label, how the review root is built and sanitized, prompt injection, the headless adjudicator, credentials, opt-in PR
tests and the run store.
