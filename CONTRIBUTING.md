# Contributing

Read [`SPEC.md`](SPEC.md) first: it is the source of truth for scope, the API
contract and the stage plan. Change the spec in the same pull request as the
code that needs the change.

## Branch model: trunk-based

```
main ──●──────●──────●──────●──  always green, always deployable
        ╲    ╱ ╲    ╱ ╲    ╱
         ●──●   ●──●   ●──●      short-lived branches, one change each
```

- `main` is the only long-lived branch. Nobody commits to it directly; every
  change arrives through a pull request.
- Branch from the latest `main`, keep the branch short-lived (aim to merge
  within 1–3 days) and delete it after merge.
- One logical change per branch. A stage from `SPEC.md` is usually several
  pull requests (for example: contract, server, UI), each leaving `main`
  green. Unfinished user-facing parts stay unreachable from the UI until the
  stage is complete.
- Never force-push a branch someone else is working on. Rewriting your own
  branch before review is fine (`git push --force-with-lease`).

### Branch names

```
feature/<short-description>    feature/stage-2-search
fix/<short-description>        fix/sse-reconnect
chore/<short-description>      chore/eslint-config
refactor/<short-description>   refactor/job-runner
docs/<short-description>       docs/api-errors
claude/<generated-name>        branches created by Claude Code sessions
```

Lowercase, words separated by `-`. `claude/*` branches follow every other
rule here; the prefix only says who opened them.

## Commits

Format:

```
<type>: <short description in the imperative, lower case, no period>

<optional body: why the change is needed, not what the diff already shows>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

- Each commit does one thing and leaves typecheck, lint and tests passing.
- Do not mix formatting or refactoring with behaviour changes.
- Aim for ~100 changed lines per commit and well under 1000 per pull request;
  split larger work.
- Write in English.

Before every commit:

```sh
git diff --staged          # look at what you are committing, no secrets, no data/
npm run typecheck
npm run lint
npm test
```

No npm script commits, pushes, tags or changes the version.

## Pull requests

1. Push the branch and open a pull request against `main`.
2. The description says what changed, why, which `SPEC.md` section it
   implements, and how it was verified. List anything intentionally left out.
3. Add a line under `## [Unreleased]` in `CHANGELOG.md` for any user-visible
   change (UI, API, configuration).
4. CI (lint, typecheck, test) must be green and the branch up to date with
   `main`.
5. Merge with **Rebase and merge** so `main` keeps the atomic commits in a
   linear history. Squash merges are disabled: they erase the commit story.
6. Delete the branch.

## Versions and releases

Semantic versioning, `MAJOR.MINOR.PATCH`. The HTTP API counts as the public
interface: a breaking API change is a major bump (and a new `/api/vN` path).

- While the stages in `SPEC.md` are being built, versions stay below 1.0:
  stage 1 → `v0.1.0`, stage 2 → `v0.2.0`, stage 3 → `v0.3.0`, stage 4 →
  `v0.4.0`; stage 5 ships `v1.0.0`. Fixes between stages bump the patch number.
- **The git tag is the source of truth for the version.** `package.json`
  files stay at `0.0.0` and are never edited for a release; build tooling
  (stage 5) reads the version from the tag.
- A release is cut by a maintainer from `main`, by hand:

  ```sh
  git switch main && git pull
  # in a release PR: move the [Unreleased] entries in CHANGELOG.md under
  # a new "## [x.y.z] - YYYY-MM-DD" heading, merge it, then:
  git tag -a vX.Y.Z -m "Release X.Y.Z"
  git push origin vX.Y.Z
  ```

- `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):
  newest on top, entries grouped under `Added`, `Changed`, `Fixed`,
  `Deprecated`, `Removed`, `Security`, written for users, not copied from
  `git log`.

## Repository settings (maintainer)

These are set on GitHub, not in the repository:

- Default branch `main`; branch protection on `main`: require a pull request,
  require status checks (CI) and an up-to-date branch, require linear
  history, block force pushes and deletions, include administrators.
- Merge buttons: only _Rebase and merge_ enabled; _Automatically delete head
  branches_ on.
- Tag protection (ruleset) for `v*`: only maintainers may create or delete.
