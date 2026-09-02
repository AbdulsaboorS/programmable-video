# Security Policy

## Reporting

Please report vulnerabilities privately through GitHub's security advisory flow rather than a public issue.

## Deployment Responsibility

This repository is an experimental reference implementation, not a hosted multi-tenant service. Operators are responsible for authentication, authorization, quotas, retention, Sandbox egress, secrets, and the cost of Cloudflare resources they provision.

Keep the Studio behind Cloudflare Access. Restrict Access bypasses to the documented capability-only paths. Never commit `.dev.vars`, API tokens, signing keys, account identifiers, or generated agent credentials.
