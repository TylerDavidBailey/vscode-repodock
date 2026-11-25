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
  paths, last-opened timestamps, pins, and which rows are folded, in VS Code's local
  storage.
- The published bundle has no runtime npm dependencies.
- The only external program it runs is git, through `execFile` with no shell: a
  `git config` read, then `git status --porcelain=v2 --branch`, in each repository under
  the folders the user configured.
- It runs git in repositories the user has not opened, so it treats each repository's own
  config as untrusted. A repository unpacked from an archive carries whatever `.git/config`
  its author wrote, and git runs programs named there during an ordinary `git status`.
  Every git call therefore:
  - turns off `core.fsmonitor` and points `core.hooksPath` at nothing;
  - sets `protocol.allow=never`, so a repository declared as a partial clone cannot make
    git fetch through `core.sshCommand` or `remote.<name>.uploadpack`;
  - blanks every filter driver (`filter.<name>.clean` and `.process`) that the repository
    or its worktree config defines, leaving drivers from the user's own global and system
    config in place. A repository whose driver cannot be blanked by name gets no status;
  - passes `--ignore-submodules=dirty`, so git does not run inside a submodule under that
    submodule's config;
  - runs with `GIT_OPTIONAL_LOCKS=0`, so the index is never rewritten.
- Git is started by an absolute path found on `PATH`, never by the bare name `git`, and
  `PATH` entries that are empty or relative are skipped. A `git.exe` placed in a project
  folder therefore cannot be picked up in place of the real one.
- Repository names, paths, and branch names are shown as plain text. In tooltips they are
  appended as text rather than markdown, and tooltips are not trusted markdown, so a
  crafted name cannot produce a link or run a command.
- In Restricted Mode, which VS Code applies to an untrusted workspace, it ignores
  `repodock.directories`, `repodock.exclude`, and `repodock.maxDepth` when those settings
  come from workspace configuration. A checked-out repository therefore cannot redirect or
  deepen scanning.
- Symlinked directories are not followed while scanning.

What is out of scope: a repository's working tree is still read by git, so RepoDock
inherits git's own handling of a malformed index or object. Keep git up to date.
