# Releasing

- Document kind: Current behavior
- Sources: [CI](../.github/workflows/ci.yml), [image publishing](../.github/workflows/docker-publish.yml), [release script](../scripts/release.ts).

## Release verification

Run the API quality, OpenAPI, unit, PostgreSQL integration and process E2E gates from the selected
source revision. Record the image digest and migration checksums; test the chosen UI/API revisions
together before rollout. A health probe alone does not verify onboarding, step-up, catalog, provider
events or signed projections. Verify only the providers enabled for the environment; native-only
projects do not require an unused Stripe connection.

## Release and support policy

Quotum is pre-1.0. Each release must be tagged `vX.Y.Z` and published as a container image and a
GitHub Release with the same version using the checklist below. Its pull requests carry the
migrations and upgrade order. Only the latest release line receives fixes, published as a new patch on
`main`. Security issues are handled privately; see [SECURITY.md](../SECURITY.md).

## Publish a container release

The [Publish image workflow](../.github/workflows/docker-publish.yml) publishes
`ghcr.io/quotumapp/quotum` for `linux/amd64` and `linux/arm64`:

| GitHub push | Container tags | GitHub Release |
| --- | --- | --- |
| Commit on `main` | `main` (rolling development image) | None; the run summary lists changes since the last release |
| Stable release tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, and `latest` when it is the highest stable version | Published, marked latest when it is the highest stable version |
| Prerelease tag `vX.Y.Z-rc.N` | `X.Y.Z-rc.N` only | Published as a prerelease |

The Git tag is the release version; no release branch, version-bump commit or release PR is
required. `package.json` and the committed OpenAPI snapshot keep `0.0.0-dev`. Release builds
use the tag version for `BUILD_VERSION`, OCI metadata and the attached OpenAPI `info.version`.
Branch builds use `0.0.0-dev.<commit>`; each `main` run lists changes since the last stable release.
Both publishing and ordinary
[CI](../.github/workflows/ci.yml) call the same [standalone validation](../.github/workflows/validate.yml).
The publish job requires successful validation of its exact source commit. Validation checks out
only this public repository, requires no private siblings or corporate credentials, and has read-only
repository permissions; registry write access is limited to the publishing job, and release write
access to the release job that runs after it. Validation also scans the built amd64 container with
Trivy. After publication, [image scanning](../.github/workflows/trivy-image.yml) checks the exact
published digest for both amd64 and arm64; the GitHub Release waits for both scans. A failed scan
leaves the image and tags in GHCR but prevents release creation. The daily security workflow also
rescans both architectures of `latest`. See [security scanning](security-scanning.md) for the
severity policy, local commands and source analysis.

The release job creates the GitHub Release only after the image is pushed and both image scans
pass. Its notes are GitHub's generated list of the pull requests merged since
the previous release tag (the previous stable tag, or the closest lower tag for a prerelease),
grouped by label through [`.github/release.yml`](../.github/release.yml), with a compare link.
Details and upgrade notes stay in the pull request descriptions. PRs changing baseline migrations
must name every changed SQL file under `Upgrade notes` and describe the upgrade; `None` fails
the migration notes check. A release that changes a baseline since the previous tag opens its
notes with an `Upgrade requires backup and restore` notice that names the changed files and links
[upgrade transitions](upgrade-transitions.md) at the released tag, so an operator sees it before
running the migration job; the generated list follows. `bun scripts/release.ts meta vX.Y.Z` lists changed baselines since the
previous tag and warns when a patch changes them. `bun scripts/release.ts unreleased` lists the
same changes for HEAD; set `NEXT_VERSION=X.Y.Z` to also check a planned version. A warning does
not authorize a populated database reset or bypass checksum verification. Labels come from pull request
titles; see [CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests). The release attaches
`openapi.json` (copied from `contracts/v1/` with only `info.version` stamped), the unchanged
`errors.json`, and an `image.json` that records the image
digest, commit and publishing run. Releases are immutable once published: assets and the tag cannot
change, so correct a bad release with a new patch release. Release notes can still be edited.

1. Review the pull requests merged since the last release; the latest `main` publishing run
   summary lists them. Choose the version: before 1.0, a minor release for breaking changes or
   features and a patch release for fixes only. Select the existing `main` commit to release and
   complete [release verification](#release-verification) for that revision. Do not bump
   `package.json` or create a release PR.
2. From a clean checkout of that `main` revision, verify the GitHub remote and CI for the merged
   commit. These examples use `github` for `quotumapp/quotum`; substitute the actual GitHub remote
   name if different. In the multi-repository workspace, a GitLab remote does not trigger GitHub
   image publishing. The commands use Git, `jq`, GitHub CLI and Docker Buildx. Keep the release
   variables in the same shell through the remaining steps.

   ```sh
   git remote -v
   git fetch github main --tags
   release_commit=$(git rev-parse github/main)
   gh run list --repo quotumapp/quotum --workflow ci.yml --commit "$release_commit"
   ```

   Wait for CI to succeed for this exact commit before continuing. A successful `main` image
   build alone is not the release verification gate.
3. Set the chosen version, create its annotated tag on the verified commit, and
   push that one tag to GitHub:

   ```sh
   release_version=X.Y.Z # Replace with the chosen version, without the v prefix
   git tag -a "v$release_version" "$release_commit" -m "Release v$release_version"
   git push github "refs/tags/v$release_version"
   ```

   Push release tags individually: GitHub does not emit tag push events when more than three
   tags are pushed together. See [GitHub's push event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).
   A tag ruleset limits creating, moving and deleting `v*` tags to repository administrators. Do
   not move an existing release tag to another commit.
4. Find the `Publish image` run for the new `vX.Y.Z` tag and wait for both the `Build and push`
   and `GitHub Release` jobs to succeed. The same commit can also have a `main` publishing run, so
   check the run's ref:

   ```sh
   gh run list --repo quotumapp/quotum --workflow docker-publish.yml --commit "$release_commit"
   ```

   If the release job fails after the image is pushed, re-run that job. It replaces an unpublished
   draft and leaves an already published release unchanged.
5. Confirm the image tags in [GHCR package versions](https://github.com/quotumapp/quotum/pkgs/container/quotum/versions)
   and check the release against the registry:

   ```sh
   gh release view "v$release_version" --repo quotumapp/quotum
   gh release download "v$release_version" --repo quotumapp/quotum -p image.json -O - | jq -r .digest
   gh release verify "v$release_version" --repo quotumapp/quotum
   docker buildx imagetools inspect "ghcr.io/quotumapp/quotum:$release_version"
   ```

   Verify both target platforms, that the digest in the release's `image.json` matches the
   inspected top-level digest, and that `X.Y` and, for the highest stable version, `latest` resolve
   to the same digest at publication time. Use the recorded digest to pin deployments; `main`, `X.Y`
   and `latest` move as subsequent builds are published. A release is published only after the
   GitHub Release and the versioned image are verified. Follow [Upgrade](operations.md#upgrade) separately to
   deploy it.
