# Contributing to The Open Space

Thanks for helping build the game. This page covers how changes move from an idea to a release.

## Setup

```bash
nvm use            # Node 20, from .nvmrc
npm ci
npm run dev        # http://localhost:5173  (?dev=1 adds time-warp buttons in Settings)
npm run build      # must pass before you open a pull request
```

## Workflow

`main` is protected and **deploys to production on every merge**. Nobody pushes to it directly:

1. Branch off the latest `main`: `git switch -c feat/fleet-escorts` (prefixes: `feat/`, `fix/`, `perf/`,
   `docs/`, `chore/`, `refactor/`).
2. Commit in small, focused steps.
3. Open a pull request against `main` and fill in the template.
4. The **build** check must pass, and the PR title must follow the format below.
5. PRs are **squash-merged**, so the PR title becomes the single commit on `main`. History stays linear.

Force-pushing or deleting `main` is blocked, and so are merges while the build is red or the branch is behind
`main`.

## Commit and PR titles: Conventional Commits

PR titles (and so every commit on `main`) use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <summary in the imperative>

feat(fleet): let haulers escort a seed ship
fix(hud): stop ENTER EDEN covering BOARD SHIP on phones
perf(earth): stream terrain tiles at half resolution on LOW
docs: explain the release process
```

Types: `feat`, `fix`, `perf`, `refactor`, `style`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
Add `!` after the type (`feat!:`) for a change that breaks existing saves or URLs.

## Versioning and releases

The game follows [Semantic Versioning](https://semver.org/). `package.json` holds the version, and every
release is an annotated `vX.Y.Z` tag on `main`:

| Change since the last release | Bump |
|---|---|
| Breaks old saves, removes features, `feat!` / `fix!` | **major** (pre-1.0: minor) |
| Any `feat` | **minor** |
| Only `fix` / `perf` / other | **patch** |

To cut a release (maintainers):

1. Open a PR named `chore(release): vX.Y.Z` that runs `npm version X.Y.Z --no-git-tag-version` and moves the
   `Unreleased` notes in [CHANGELOG.md](CHANGELOG.md) under the new version.
2. Merge it, then tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. The **Release** workflow checks that the tag matches `package.json` and sits on `main`, builds the game and
   publishes a GitHub Release with the built `dist/` attached and notes generated from the merged PRs.

Release tags are protected: once pushed, a `v*` tag can't be moved or deleted. If a release is broken, ship a
new patch version instead of retagging.

## Code style

- ES modules, 2-space indent, LF line endings (`.editorconfig` and `.gitattributes` set this up).
- Match the style of the file you're editing. Keep comments to the *why*.
- Test UI changes on a phone-sized viewport too: most players are on Telegram mobile.

## Assets

Every model, texture, sound or data file needs a licence that allows redistribution. Credit it in the
`CREDITS.txt` in its folder (see [ASSETS.md](ASSETS.md)) in the same PR.

## Secrets

Never commit API keys. Local keys go in `.env.local` (gitignored). Deployed keys go in the App Platform
environment as encrypted variables (see `.do/app.yaml`).

## Conduct

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
