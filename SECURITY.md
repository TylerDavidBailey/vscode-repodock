# Security Policy

## Supported versions

Only the latest release on the VS Code Marketplace is supported with security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
vulnerability reporting instead: go to the repository's **Security** tab →
**Report a vulnerability**. You'll get a response within a few days.

## Design notes for reviewers

- RepoDock makes no network requests and collects no telemetry; all data
  (folder paths, last-opened timestamps) stays in VS Code's local storage.
- The only external process it runs is `git status` via `execFile` (no shell) against
  repositories found under folders the user explicitly configured.
- The published bundle has no runtime npm dependencies.
- In Restricted Mode (untrusted workspaces), the `repodock.directories` and
  `repodock.exclude` settings are ignored from workspace configuration, so a checked-out
  repository cannot redirect scanning.
