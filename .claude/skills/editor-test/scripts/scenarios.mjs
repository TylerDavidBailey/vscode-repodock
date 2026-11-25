// The scenario catalog: what RepoDock is expected to do in a real editor. This is the file
// a PR edits. Each scenario runs in VS Code and in VSCodium against the fixtures that
// make-fixtures.sh builds, and starts from the base settings plus its own `settings`.
//
//   kind 'normal'  a path every user takes
//   kind 'edge'    unusual input, unusual state, or a failure the UI has to survive
//
// Assert through `ui.eventually`, because every update reaches the tree asynchronously.
// End a scenario with `ui.shot(id)` so the report carries a picture of the state it checked.

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/** The flat list under the base settings: pins, then most recently opened, then by name. */
const FLAT_RECENT = [
  'billing-api (services)',
  'infra-terraform',
  'aurora-web (frontend)',
  'auth-service (services)',
  'acme-portal (clients)',
  'design-system (frontend)',
  'cli (tools)',
  'dotfiles',
  'gateway (services)',
  'ginkgo (frontend)',
  'ginkgo (tools/abc)',
  'northwind-api (clients)',
  'payments-sdk (services/gateway/vendor)',
];

const descriptionOf = async (ui, label) =>
  (await ui.rows()).find((row) => row.label === label)?.description;

export const scenarios = [
  // ---------------------------------------------------------------- normal cases
  {
    id: 'flat-recent',
    kind: 'normal',
    title: 'Flat list puts pins first, then orders by last opened',
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(), FLAT_RECENT);
      });
      await ui.eventually(async () => {
        assert.equal(await descriptionOf(ui, 'auth-service (services)'), 'main · 5h');
        assert.equal(await descriptionOf(ui, 'cli (tools)'), 'develop · 1w');
        assert.equal(await descriptionOf(ui, 'gateway (services)'), 'main');
      });
      await ui.shot('flat-recent');
    },
  },
  {
    id: 'current-repo',
    kind: 'normal',
    title: 'The repo open in this window is listed as just opened',
    async run(ui, assert) {
      await ui.eventually(async () => {
        const description = await descriptionOf(ui, 'aurora-web (frontend)');
        assert.match(description ?? '', /^feat\/dark-mode · (now|\dm)$/);
      });
    },
  },
  {
    id: 'flat-alphabetical',
    kind: 'normal',
    title: 'Alphabetical sort keeps pins on top',
    settings: { 'repodock.sortOrder': 'alphabetical' },
    async run(ui, assert) {
      const pinned = FLAT_RECENT.slice(0, 2);
      const rest = FLAT_RECENT.slice(2).sort((a, b) => a.localeCompare(b));
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(), [...pinned, ...rest]);
      });
      await ui.shot('flat-alphabetical');
    },
  },
  {
    id: 'grouped',
    kind: 'normal',
    title: 'Group by Folder makes one section per configured folder',
    settings: { 'repodock.groupByFolder': true },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const rows = await ui.rows();
        const sections = rows.filter((row) => row.level === 1);
        assert.deepEqual(
          sections.map((row) => [row.label, row.description]),
          [
            ['~/code', '10'],
            ['~/work', '3'],
          ],
        );
        assert.equal(rows.filter((row) => row.level === 2).length, 13);
      });
      await ui.shot('grouped');
    },
  },
  {
    id: 'title-actions',
    kind: 'normal',
    title: 'The view title offers group, sort, refresh, and manage folders',
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.deepEqual(await ui.titleActions(), [
          'Group by Folder',
          'Sort Alphabetically',
          'Refresh',
          'Manage Folders',
        ]);
      });
    },
  },
  {
    id: 'tooltip',
    kind: 'normal',
    title: 'The tooltip reports path, branch, changes, and upstream distance',
    async run(ui, assert) {
      await ui.eventually(async () => assert.ok((await ui.labels()).length > 0));
      const { text } = await ui.tooltip('aurora-web (frontend)');
      assert.match(text, /aurora-web — open in this window/);
      assert.match(text, /~\/code\/frontend\/aurora-web/);
      assert.match(text, /Branch: feat\/dark-mode/);
      assert.match(text, /Changes: 3 modified, 2 untracked/);
      assert.match(text, /Upstream: 2 ahead, 1 behind/);
      await ui.shot('tooltip');
    },
  },
  {
    id: 'context-menu',
    kind: 'normal',
    title: 'The row menu lists every repo action in order',
    async run(ui, assert) {
      const items = await ui.openContextMenu('design-system (frontend)');
      assert.deepEqual(items, [
        'Pin Repository',
        'Open in Current Window',
        'Open in New Window',
        'Add to Workspace',
        'Open in Integrated Terminal',
        'Reveal in File Explorer',
        'Copy Path',
        'Hide Repository',
      ]);
      await ui.shot('context-menu');
      assert.equal((await ui.openContextMenu('billing-api (services)'))[0], 'Unpin Repository');
    },
  },
  {
    id: 'pin-unpin',
    kind: 'normal',
    title: 'Pinning floats a repo to the top and unpinning puts it back',
    async run(ui, assert) {
      await ui.openContextMenu('northwind-api (clients)');
      await ui.chooseMenuItem('Pin Repository');
      await ui.eventually(async () => {
        assert.ok((await ui.labels()).indexOf('northwind-api (clients)') < 3);
      });
      await ui.shot('pin-unpin');
      await ui.openContextMenu('northwind-api (clients)');
      await ui.chooseMenuItem('Unpin Repository');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(), FLAT_RECENT);
      });
    },
  },
  {
    id: 'hide-unhide',
    kind: 'normal',
    title: 'Hiding removes a repo and records it in settings; Unhide All restores it',
    async run(ui, assert) {
      await ui.openContextMenu('dotfiles');
      await ui.chooseMenuItem('Hide Repository');
      await ui.eventually(async () => {
        assert.ok(!(await ui.labels()).includes('dotfiles'));
      });
      assert.deepEqual(ui.readSettings()['repodock.hiddenRepos'], ['~/code/dotfiles']);
      await ui.command('RepoDock: Unhide All Repositories');
      await ui.eventually(async () => {
        assert.ok((await ui.labels()).includes('dotfiles'));
      });
    },
  },
  {
    id: 'manage-folders',
    kind: 'normal',
    title: 'Manage Folders lists each folder with its repo count and an add row',
    async run(ui, assert) {
      await ui.command('RepoDock: Manage Folders');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.quickPickItems(), [
          { label: '~/code', description: '10 repos' },
          { label: '~/work', description: '3 repos' },
          { label: 'Add Folder…', description: '' },
        ]);
      });
      await ui.shot('manage-folders', { full: true });
    },
  },

  // ---------------------------------------------------------------- edge cases
  {
    id: 'empty-no-folders',
    kind: 'edge',
    title: 'With no folders configured the view explains itself and offers Add Folder',
    settings: { 'repodock.directories': [] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const welcome = await ui.welcome();
        assert.match(welcome.text, /Add a folder and RepoDock will find every git repository/);
        assert.deepEqual(welcome.buttons, ['Add Folder']);
      });
      await ui.shot('empty-no-folders');
    },
  },
  {
    id: 'empty-no-repos',
    kind: 'edge',
    title: 'A folder holding no repositories gets the "none found" message',
    settings: { 'repodock.directories': ['~/empty'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const welcome = await ui.welcome();
        assert.match(welcome.text, /No git repositories found in the folders you added/);
        assert.deepEqual(welcome.buttons, ['Add Another Folder']);
      });
      await ui.shot('empty-no-repos');
    },
  },
  {
    id: 'missing-folder',
    kind: 'edge',
    title: 'A configured folder that does not exist is skipped without an error',
    settings: { 'repodock.directories': ['~/does-not-exist', '~/work'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(), [
          'infra-terraform',
          'acme-portal (clients)',
          'northwind-api (clients)',
        ]);
      });
      assert.deepEqual(
        (await ui.notifications()).filter((message) => /repodock/i.test(message)),
        [],
      );
    },
  },
  {
    id: 'overlapping-folders',
    kind: 'edge',
    title: 'A folder nested inside another configured folder lists each repo once',
    settings: { 'repodock.directories': ['~/code', '~/code/services'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const labels = await ui.labels();
        assert.equal(labels.length, 10);
        assert.equal(labels.filter((label) => label.startsWith('billing-api')).length, 1);
        assert.equal(labels.filter((label) => label.startsWith('payments-sdk')).length, 1);
      });
    },
  },
  {
    id: 'same-name-repos',
    kind: 'edge',
    title: 'Two repos with one name are told apart by their folders',
    async run(ui, assert) {
      await ui.eventually(async () => {
        const ginkgo = (await ui.labels()).filter((label) => label.startsWith('ginkgo'));
        assert.deepEqual(ginkgo, ['ginkgo (frontend)', 'ginkgo (tools/abc)']);
      });
    },
  },
  {
    id: 'detached-head',
    kind: 'edge',
    title: 'A detached HEAD shows a short hash marked as detached',
    async run(ui, assert) {
      await ui.eventually(async () => {
        const description = await descriptionOf(ui, 'ginkgo (tools/abc)');
        assert.match(description ?? '', /^[0-9a-f]{7} \(detached\)$/);
      });
    },
  },
  {
    id: 'nested-repos-off',
    kind: 'edge',
    title: 'showNestedRepos: false drops a repo that sits inside another repo',
    settings: { 'repodock.showNestedRepos': false },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const labels = await ui.labels();
        assert.equal(labels.length, 12);
        assert.ok(!labels.some((label) => label.startsWith('payments-sdk')));
      });
    },
  },
  {
    id: 'unusual-names',
    kind: 'edge',
    title: 'Spaces, non-ASCII, and markdown in names render literally; exclusions hold',
    settings: { 'repodock.directories': ['~/edge'], 'repodock.sortOrder': 'alphabetical' },
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.deepEqual(
          (await ui.labels()).sort(),
          [
            '*not-bold*_[link](x)',
            'at-limit (deep/a/b)',
            'empty-repo',
            'linked-worktree',
            'name with spaces',
            'ünïcødé-repo',
          ].sort(),
        );
      });
      // absent from that list, and each for its own reason: inside-excluded (under
      // node_modules), too-deep (past maxDepth), bare.git (no .git entry), and everything
      // under link-to-work (symlinks are not followed)
      const { text, html } = await ui.tooltip('*not-bold*_[link](x)');
      assert.match(text, /\*not-bold\*_\[link\]\(x\)/);
      assert.ok(!/<a\b|<em>|<strong>not-bold/.test(html), 'the name was rendered as markdown');
      await ui.shot('unusual-names');
    },
  },
  {
    id: 'unborn-branch',
    kind: 'edge',
    title: 'A repo with no commits still shows the branch it will commit to',
    settings: { 'repodock.directories': ['~/edge'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.equal(await descriptionOf(ui, 'empty-repo'), 'main');
      });
    },
  },
  {
    id: 'max-depth',
    kind: 'edge',
    title: 'Raising maxDepth reveals a repo that sat below the limit',
    settings: { 'repodock.directories': ['~/edge'], 'repodock.maxDepth': 8 },
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.ok((await ui.labels()).includes('too-deep (deep/a/b/c/d)'));
      });
    },
  },
  {
    id: 'many-repos',
    kind: 'edge',
    title: '150 repositories all load, and the tree stays scrollable',
    settings: { 'repodock.directories': ['~/many'], 'repodock.sortOrder': 'alphabetical' },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const rows = await ui.rows();
        assert.equal(rows[0]?.total, 150);
        assert.equal(rows[0]?.label, 'repo-001');
        assert.equal(rows[0]?.description, 'main');
      }, 30_000);
      await ui.shot('many-repos');
    },
  },
  {
    id: 'deleted-after-scan',
    kind: 'edge',
    title: 'Opening a repo deleted since the scan warns and drops the row',
    settings: { 'repodock.directories': ['~/vanishing'] },
    async run(ui, assert) {
      const repo = ui.fixture('vanishing/soon-deleted');
      fs.mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      await ui.command('RepoDock: Refresh');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(), ['soon-deleted']);
      });
      fs.rmSync(repo, { recursive: true });
      await ui.row('soon-deleted').click();
      await ui.eventually(async () => {
        const warnings = (await ui.notifications()).join('\n');
        assert.match(warnings, /could not open soon-deleted: .* no longer exists/);
      });
      await ui.shot('deleted-after-scan', { full: true });
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(), []);
      });
    },
  },

  // Last on purpose: opening a repo reloads the window onto another folder, and every
  // scenario above assumes the window it was launched with.
  {
    id: 'open-repo',
    kind: 'normal',
    title: 'Clicking a repo opens it in this window and stamps it as just opened',
    async run(ui, assert) {
      await ui.eventually(async () => assert.ok((await ui.labels()).includes('dotfiles')));
      await ui.row('dotfiles').click();
      await ui.eventually(async () => {
        assert.match(await ui.page.title(), /dotfiles/);
      }, 60_000);
      await ui.command('RepoDock: Focus on Repositories View');
      await ui.eventually(async () => {
        const rows = await ui.rows();
        // the two pins stay on top, so the repo just opened is the third row
        assert.equal(rows[2]?.label, 'dotfiles');
        assert.match(rows[2]?.description ?? '', /^main · (now|\dm)$/);
      }, 60_000);
      await ui.shot('open-repo');
    },
  },
];
