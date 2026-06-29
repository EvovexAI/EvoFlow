# Security Policy

## Supported Versions

EvoFlow is under active development. Please use the latest release for security updates.

| Version | Supported          |
|---------|--------------------|
| latest  | ✅ Active support  |
| < 0.2.x | ❌ Not supported   |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please **do not** open a public GitHub issue.

### How to Report

1. **Email**: Send details to [cloud@evovexai.com](mailto:cloud@evovexai.com)
2. **GitHub Security Advisory**: Use [GitHub Private Vulnerability Reporting](https://github.com/EvovexAI/EvoFlow/security/advisories/new)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

| Stage | Target |
|-------|--------|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 7 days |
| Fix or mitigation | Within 30 days (severity-dependent) |

## Security Best Practices for Local Installations

Since EvoFlow runs as a local desktop application, users should be aware of the following:

- **API Keys**: Model API keys are stored in the local SQLite database. Ensure your machine is physically secured.
- **Network Binding**: The desktop Gateway binds to `127.0.0.1` (localhost only) by default — not exposed to the network.
- **Guardrails**: Tool-call guardrails are enabled by default in desktop builds to prevent dangerous operations.
- **Sandbox**: `LocalSandboxProvider` is used by default. Host bash execution is disabled unless explicitly enabled.
- **CORS**: Restricted to Tauri desktop and local dev origins by default.
- **Docker Deployments**: When using Docker, ports are mapped to `127.0.0.1` only. Do not expose ports to `0.0.0.0` unless behind a reverse proxy with authentication.

## Dependency Scanning

We recommend running periodic dependency scans:

```bash
# Python dependencies
pip install pip-audit && pip-audit

# Node.js dependencies
cd evopanel && npm audit
```
