# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/twinkling-reality/rotyl/security/advisories/new)
to send the report privately to the maintainers.

Include the affected release, reproduction steps, expected impact, and any
suggested mitigation. Please avoid including personal media or other sensitive
data in the report. The maintainers will acknowledge the report through the
private advisory and coordinate disclosure there.

## Supported releases

Security fixes are made against the current tagged application release.
Pre-releases stop receiving fixes when a final release supersedes them. Model
assets have their own immutable release version and are never replaced in
place.

Rotyl processes media locally. A report that shows media, credentials, or model
bytes leaving the documented same-origin boundary is treated as a security and
privacy issue.
