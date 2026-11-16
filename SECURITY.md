# Security policy

OpenCookie decides whether optional scripts and storage may run on a visitor's
page, so a flaw that lets them run without consent, or keeps them running after
withdrawal, counts as a security issue. So does anything that exposes consent
receipts, which are personal data.

## Supported versions

Fixes go into the latest published version of each package. Upgrade to it
before you report a problem.

| Package | Supported |
| --- | --- |
| `@opencookie-dev/*` and `opencookie`, latest version | yes |
| any earlier version | no |

## Reporting a vulnerability

Do not open a public issue. Report it privately through GitHub instead:
open the repository's **Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/jacksnxly/opencookie/security/advisories/new)).

Please include:

- the package and version;
- what an attacker or a misconfigured page can make OpenCookie do;
- the smallest page, policy or steps that reproduce it.

## What happens next

We aim to acknowledge a report within seven days and to agree on a fix and a
disclosure date with you. Once a fix is published, we publish a GitHub
security advisory that credits you, unless you prefer not to be named.
