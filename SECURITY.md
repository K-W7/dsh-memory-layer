# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in dsh-memory-layer, please report it **privately** before public disclosure:

- Open a [private security advisory](https://github.com/KLRSL/dsh-memory-layer/security/advisories/new) (preferred), or
- Email the maintainer through your GitHub contact

Please include a description of the vulnerability, steps to reproduce, and affected versions. You should receive a response within 7 days.

Please do **not** open public issues for security vulnerabilities.

## Security Notes

dsh-memory-layer is **local-first**:

- All memory data is stored in a local SQLite database (`~/.dsh/biomemory/biomemory.db` via `node:sqlite`, WAL mode, zero external DB dependency) — nothing is ever sent over the network.
- Important memory writes require human approval; the plugin fails closed when no approval channel is available.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.11.x  | ✅         |

## Deletion and auditability

There is no separate audit log: every memory is a row in the local SQLite database, and deletions leave
tombstones (`status = deleted`) that `restore` can revive. `purge` is the only irreversible operation.
