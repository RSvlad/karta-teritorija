# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and the affected file or workflow.
You can expect a first reply within a few days.

## Scope notes

- The published site is static; it holds no secrets. Data comes from a private Google Sheet read only at
  build time with a read-only service account (`GOOGLE_SERVICE_ACCOUNT`, `SHEETS_ID` repository secrets).
- The Sheet must never contain private home addresses (see README, "Тачке").
- If you find a leaked credential, report it privately so it can be rotated.
