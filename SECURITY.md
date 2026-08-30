# Security Policy

## Supported versions

Only the latest release gets security fixes. Each release ships at the same version to
both the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tylerdavidbailey.repodock)
and [Open VSX](https://open-vsx.org/extension/tylerdavidbailey/repodock), so upgrading on
either registry gets you the fix.

## Report a vulnerability

Do not open a public issue for a security problem. Use GitHub's private vulnerability
reporting instead: open the repository's **Security** tab, then choose
**Report a vulnerability**. You get a response within a few days.

## Design notes for reviewers

- RepoDock makes no network requests and collects no telemetry. It stores only folder
  paths and last-opened timestamps, in VS Code's local storage.
- The only external process it runs is `git status --porcelain=v2 --branch`, through
  `execFile` with no shell, against repositories under the folders the user configured.
- The published bundle has no runtime npm dependencies.
- In Restricted Mode, which VS Code applies to an untrusted workspace, it ignores
  `repodock.directories` and `repodock.exclude` when those settings come from workspace
  configuration. A checked-out repository therefore cannot redirect scanning.
