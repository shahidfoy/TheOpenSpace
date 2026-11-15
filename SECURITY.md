# Security policy

## Supported versions

Only the latest release (and what's live on `main`) gets security fixes.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately instead:
**Security** tab → **Report a vulnerability** on this repository (GitHub private vulnerability reporting).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within
7 days, and we'll agree a disclosure date once a fix is ready.

In scope: the game client, the serverless functions in `functions/` (`/api/threats/feed`,
`/api/weather/storms`), and the build and deploy configuration. Third-party data feeds and hosted services
belong to their providers.
