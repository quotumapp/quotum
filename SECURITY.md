# Security Policy

## Reporting a vulnerability

Please do not open public issues for security problems.

Report vulnerabilities privately through GitHub's private vulnerability reporting:
open the repository's **Security** tab and choose **Report a vulnerability**. Reports go only
to the maintainers.

Include the affected version or commit, the component (for example a route, worker, migration,
provider integration, or the SDK), reproduction steps, and the impact you believe it has. Proof of
concept code is welcome; please do not test against systems you do not own.

You will receive an acknowledgement within three business days. We aim to confirm or dismiss the
report within ten business days and to publish a fix for confirmed issues as soon as it is safely
possible. We will credit reporters in the release notes unless you ask us not to.

## Supported versions

This project is pre-1.0. Security fixes are published for the latest release line only, as a new
patch release on `main`. Older minor versions do not receive backported fixes; upgrade by applying
the forward-only migrations described in the README and the CHANGELOG entry for each version.

## Scope

In scope: this service's HTTP API, workers, migrations, credential and connection handling,
provider webhook verification, the backend SDK, and the catalog CLI.

Out of scope: vulnerabilities in third-party providers (Apple, Google, Stripe) themselves,
issues that require a compromised operator credential or database, and reports produced only by
automated scanners without a demonstrated impact.

## Handling secrets

Never include real credentials, database URLs, or customer data in a report. Provider keys,
project credentials, and the `QUOTUM_SECRETS_KEY_BASE64` encryption key must stay outside the
repository and outside database backups; see the README configuration section.
