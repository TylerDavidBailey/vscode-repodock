// The scenario catalog: what RepoDock is expected to do in a real editor. This is the file
// a PR edits. Each scenario runs in VS Code and in VSCodium against the fixtures that
// make-fixtures.sh builds, and starts from the base settings plus its own `settings`.
//
//   kind 'normal'  a path every user takes
//   kind 'edge'    unusual input, unusual state, or a failure the UI has to survive
//
// A scenario's `run(ui, assert, S)` gets the UI helpers, node's strict assert, and the
// section titles. Assert through `ui.eventually`, because every update reaches the views
// asynchronously, and end with `ui.shot(id)` when the state is worth a picture.

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// functions handed to page.evaluate run inside the editor window
/* global document, getComputedStyle */

/** All Repositories under the base settings, as [level, label, description] rows. */
const ALL_TREE = [
  [1, '~/projects', '10'],
  [2, 'services', '4'],
  [3, 'api-gateway', 'main'],
  [3, 'payments-api', 'fix/retry-webhooks ↑1'],
  [3, 'user-service', 'main ↓4'],
  [2, 'tools', '2'],
  [3, 'experiments', '1'],
  [4, 'playground', /^[0-9a-f]{7} \(detached\)$/],
  [3, 'deploy-cli', 'develop'],
  [2, 'web', '3'],
  [3, 'admin-dashboard', 'release/v2.1.0'],
  [3, 'playground', 'main'],
  [3, 'storefront', 'feat/checkout-redesign ↑2 ↓1'],
  [2, 'dev-setup', 'main ↑3'],
  [1, '~/work', '3'],
  [2, 'clients', '2'],
  [3, 'client-portal', 'feature/sso-login-redirect-handling'],
  [3, 'reporting-api', 'main ↓2'],
  [2, 'infrastructure', 'main'],
];

/** Asserts a section's rows against [level, label, description] triples. */
async function expectTree(ui, assert, expected, section) {
  const rows = await ui.rows(section);
  assert.deepEqual(
    rows.map((row) => [row.level, row.label]),
    expected.map(([level, label]) => [level, label]),
  );
  for (const [index, [, label, description]] of expected.entries()) {
    if (description instanceof RegExp) assert.match(rows[index].description, description, label);
    else assert.equal(rows[index].description, description, label);
  }
}

const find = async (ui, label, section) =>
  (await ui.rows(section)).find((row) => row.label === label);

/** The playground repo under web/, as opposed to its namesake under tools/experiments/. */
const findWebPlayground = async (ui) =>
  (await ui.rows()).find((row) => row.label === 'playground' && row.level === 3);

const sectionCounts = async (ui) =>
  Object.fromEntries((await ui.sections()).map((section) => [section.title, section.count]));

/** Notifications that are RepoDock's own, leaving out the editor's (running as root, etc.). */
const ownNotifications = async (ui) =>
  (await ui.notifications()).filter((message) => /repodock/i.test(message));

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });

export const scenarios = [
  // ---------------------------------------------------------------- normal cases
  {
    id: 'sections',
    kind: 'normal',
    title: 'One tree holds three sections, each with its count, packed with no gaps between',
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.deepEqual(
          (await ui.sections()).map((section) => [section.title, section.count]),
          [
            ['Pinned', '2'],
            ['Recent', '7'],
            ['All Repositories', '13'],
          ],
        );
        // each heading sits directly under the last row of the section above it, one
        // row height down: a section takes the height of its rows and nothing more
        const tree = await ui.tree();
        const rowHeight = tree[1].top - tree[0].top;
        for (const [index, row] of tree.entries()) {
          if (index > 0) assert.equal(row.top - tree[index - 1].top, rowHeight, row.label);
        }
        assert.deepEqual(
          tree.slice(0, 4).map((row) => row.label),
          ['Pinned', 'infrastructure', 'payments-api', 'Recent'],
        );
      });
      await ui.shot('sections', { sidebarOnly: true });
    },
  },
  {
    id: 'pinned-section',
    kind: 'normal',
    title: 'Pinned lists pinned repos by name with branch, sync arrows, and change count',
    async run(ui, assert, S) {
      await ui.eventually(async () => {
        assert.deepEqual(
          (await ui.rows(S.pinned)).map((row) => [row.label, row.description, row.badge]),
          [
            ['infrastructure', 'main', ''],
            ['payments-api', 'fix/retry-webhooks ↑1', '6'],
          ],
        );
      });
    },
  },
  {
    id: 'recent-section',
    kind: 'normal',
    title: 'Recent lists opened repos newest first, each with when it was opened',
    async run(ui, assert, S) {
      await ui.eventually(async () => {
        await expectTree(
          ui,
          assert,
          [
            [1, 'storefront', /^feat\/checkout-redesign ↑2 ↓1 · (now|\dm)$/],
            [1, 'payments-api', /^fix\/retry-webhooks ↑1 · \d\dm$/],
            [1, 'user-service', 'main ↓4 · 5h'],
            [1, 'client-portal', 'feature/sso-login-redirect-handling · 1d'],
            [1, 'admin-dashboard', 'release/v2.1.0 · 3d'],
            [1, 'deploy-cli', 'develop · 1w'],
            [1, 'dev-setup', 'main ↑3 · 1mo'],
          ],
          S.recent,
        );
      });
    },
  },
  {
    id: 'all-hierarchy',
    kind: 'normal',
    title: 'All Repositories mirrors the disk: scan folder, folders, then repos',
    async run(ui, assert) {
      // Compared row by row on purpose. VSCodium 1.143 once drew the rows of services/
      // under ~/work here, when the extension revealed a row while the tree was loading.
      await ui.eventually(() => expectTree(ui, assert, ALL_TREE));
      await ui.shot('all-hierarchy');
    },
  },
  {
    id: 'row-status',
    kind: 'normal',
    title: 'A row shows uncommitted files as a count at its right edge, and none when clean',
    async run(ui, assert) {
      await ui.eventually(async () => {
        const badges = Object.fromEntries(
          (await ui.rows()).filter((row) => row.level > 2).map((row) => [row.label, row.badge]),
        );
        assert.equal(badges['storefront'], '5');
        assert.equal(badges['payments-api'], '6');
        assert.equal(badges['deploy-cli'], '3');
        assert.equal(badges['client-portal'], '2');
        // one modified file plus the untracked vendor/ folder holding the nested repo
        assert.equal(badges['api-gateway'], '2');
        assert.equal(badges['admin-dashboard'], '');
        assert.equal(badges['user-service'], '');
      });
    },
  },
  {
    id: 'current-repo',
    kind: 'normal',
    title: 'The repo open in this window is colored in every section, and nothing is selected',
    async run(ui, assert, S) {
      await ui.eventually(async () => {
        const current = await find(ui, 'storefront');
        const other = await find(ui, 'admin-dashboard');
        assert.notEqual(current.color, other.color);
        const recent = await find(ui, 'storefront', S.recent);
        assert.equal(recent.color, current.color);
        // it heads Recent, which is what keeps it on screen without a reveal
        assert.equal((await ui.rows(S.recent))[0].label, 'storefront');
        // a selection would mean the view scrolled itself to some row on load
        assert.deepEqual(
          (await ui.tree()).filter((row) => row.selected),
          [],
        );
        assert.equal((await ui.tree())[0].label, 'Pinned');
      });
    },
  },
  {
    id: 'row-icons',
    kind: 'normal',
    title: 'Repos carry the git icon, and a pin wherever a pinned repo appears',
    async run(ui, assert, S) {
      await ui.eventually(async () => {
        assert.equal((await find(ui, 'admin-dashboard')).icon, 'source-control');
        assert.equal((await find(ui, 'user-service', S.recent)).icon, 'source-control');
        for (const section of [S.pinned, S.recent, S.all]) {
          assert.equal((await find(ui, 'payments-api', section)).icon, 'pinned', section);
        }
        assert.equal((await find(ui, 'web')).icon, 'folder');
      });
    },
  },
  {
    id: 'tooltip',
    kind: 'normal',
    title: 'The tooltip reports path, branch, changes, and upstream distance',
    async run(ui, assert) {
      await ui.eventually(async () => assert.ok(await find(ui, 'storefront')));
      const { text } = await ui.tooltip('storefront');
      assert.match(text, /storefront — open in this window/);
      assert.match(text, /~\/projects\/web\/storefront/);
      assert.match(text, /Branch: feat\/checkout-redesign/);
      assert.match(text, /Changes: 3 modified, 2 untracked/);
      assert.match(text, /Upstream: 2 ahead, 1 behind/);
      assert.match(text, /Last opened: just now|Last opened: \dm ago/);
      await ui.shot('tooltip');
    },
  },
  {
    id: 'context-menu',
    kind: 'normal',
    title: 'The row menu lists every repo action in order, in every section',
    async run(ui, assert, S) {
      const actions = [
        'Open in Current Window',
        'Open in New Window',
        'Add to Workspace',
        'Open in Integrated Terminal',
        'Reveal in File Explorer',
        'Copy Path',
        'Hide Repository',
      ];
      assert.deepEqual(await ui.openContextMenu('admin-dashboard'), ['Pin Repository', ...actions]);
      await ui.shot('context-menu');
      assert.deepEqual(await ui.openContextMenu('user-service', S.recent), [
        'Pin Repository',
        ...actions,
      ]);
      assert.deepEqual(await ui.openContextMenu('payments-api', S.pinned), [
        'Unpin Repository',
        ...actions,
      ]);
    },
  },
  {
    id: 'folder-and-heading-rows',
    kind: 'normal',
    title: 'Folder rows and section headings offer no repo actions: no buttons, no repo menu',
    async run(ui, assert, S) {
      await ui.eventually(async () => assert.ok(await find(ui, 'web')));
      assert.deepEqual(await ui.rowButtons('web'), []);
      await (await ui.row('web')).click({ button: 'right' });
      // the menu VS Code may show is its own; none of ours may be on it
      const menu = () =>
        ui.page.locator('.context-view .monaco-menu .action-label').allInnerTexts();
      assert.ok(!(await menu()).some((label) => /Repository|Open in/.test(label)));
      await ui.dismiss();

      await ui.heading(S.pinned).hover();
      assert.deepEqual(
        await ui
          .heading(S.pinned)
          .locator('.actions a.action-label')
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
        [],
      );
      await ui.heading(S.pinned).click({ button: 'right' });
      assert.ok(!(await menu()).some((label) => /Repository|Open in/.test(label)));
    },
  },
  {
    id: 'row-buttons',
    kind: 'normal',
    title: 'Hovering a repo offers Pin or Unpin, and Open in New Window',
    async run(ui, assert, S) {
      await ui.eventually(async () => assert.ok(await find(ui, 'user-service')));
      assert.deepEqual(await ui.rowButtons('user-service'), [
        'Pin Repository',
        'Open in New Window',
      ]);
      assert.deepEqual(await ui.rowButtons('payments-api', S.pinned), [
        'Unpin Repository',
        'Open in New Window',
      ]);
      await (await ui.row('user-service')).hover();
      await ui.shot('row-buttons');
    },
  },
  {
    id: 'pin-unpin',
    kind: 'normal',
    title: 'Pinning adds a repo to Pinned and marks it; unpinning from Pinned removes it',
    async run(ui, assert, S) {
      await ui.eventually(async () => assert.ok(await find(ui, 'reporting-api')));
      await ui.clickRowButton('reporting-api', 'Pin Repository');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(S.pinned), [
          'infrastructure',
          'payments-api',
          'reporting-api',
        ]);
        assert.equal((await sectionCounts(ui))['Pinned'], '3');
        assert.equal((await find(ui, 'reporting-api')).icon, 'pinned');
      });
      await ui.shot('pin-unpin');
      await ui.openContextMenu('reporting-api', S.pinned);
      await ui.chooseMenuItem('Unpin Repository');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(S.pinned), ['infrastructure', 'payments-api']);
        assert.equal((await find(ui, 'reporting-api')).icon, 'source-control');
      });
    },
  },
  {
    id: 'hide-unhide',
    kind: 'normal',
    title: 'Hiding removes a repo from every section and records it; Unhide All restores it',
    async run(ui, assert, S) {
      await ui.eventually(async () => assert.ok(await find(ui, 'dev-setup')));
      await ui.openContextMenu('dev-setup');
      await ui.chooseMenuItem('Hide Repository');
      await ui.eventually(async () => {
        assert.ok(!(await ui.labels()).includes('dev-setup'));
        assert.ok(!(await ui.labels(S.recent)).includes('dev-setup'));
        assert.deepEqual(await sectionCounts(ui), {
          Pinned: '2',
          Recent: '6',
          'All Repositories': '12',
        });
      });
      assert.deepEqual(ui.readSettings()['repodock.hiddenRepos'], ['~/projects/dev-setup']);
      await ui.command('RepoDock: Unhide All Repositories');
      await ui.eventually(async () => {
        assert.ok((await ui.labels()).includes('dev-setup'));
        assert.ok((await ui.labels(S.recent)).includes('dev-setup'));
      });
    },
  },
  {
    id: 'nested-repos',
    kind: 'normal',
    title: 'A repo holding nested repos starts collapsed and expands to show them',
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.equal((await find(ui, 'api-gateway')).expanded, 'false');
        assert.ok(!(await ui.labels()).includes('vendor/shared-utils'));
      });
      await ui.toggle('api-gateway');
      await ui.eventually(async () => {
        const nested = await find(ui, 'vendor/shared-utils');
        assert.equal(nested.level, 4);
        assert.equal(nested.description, 'main');
      });
      await ui.shot('nested-repos');
      await ui.toggle('api-gateway');
      await ui.eventually(async () => {
        assert.ok(!(await ui.labels()).includes('vendor/shared-utils'));
      });
    },
  },
  {
    id: 'title-buttons',
    kind: 'normal',
    title: 'The title bar offers Add Folder, Refresh, and Collapse All, always visible',
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.deepEqual((await ui.titleButtons()).slice(0, 3), [
          'Add Folder',
          'Refresh',
          'Collapse All',
        ]);
      });
    },
  },
  {
    id: 'collapse-sections',
    kind: 'normal',
    title: 'Collapsing a section moves the next one up, and Collapse All folds every section',
    async run(ui, assert, S) {
      await ui.eventually(() => expectTree(ui, assert, ALL_TREE));
      await ui.toggleSection(S.recent);
      await ui.eventually(async () => {
        const tree = await ui.tree();
        assert.deepEqual(await ui.labels(S.recent), []);
        // All Repositories now starts right under the Recent heading
        const recent = tree.findIndex((row) => row.label === 'Recent');
        assert.equal(tree[recent + 1].label, 'All Repositories');
      });
      await ui.shot('collapse-sections', { sidebarOnly: true });

      await ui.clickTitleButton('Collapse All');
      await ui.eventually(async () => {
        assert.deepEqual(
          (await ui.tree()).map((row) => row.label),
          ['Pinned', 'Recent', 'All Repositories'],
        );
      });

      // Alt-click reopens a section and everything below it
      for (const section of [S.pinned, S.recent, S.all]) {
        await ui.toggleSection(section, { recursive: true });
      }
      // a recursive expand opens repos too, so put api-gateway back the way it starts
      await ui.toggle('api-gateway');
      await ui.eventually(async () => {
        await expectTree(ui, assert, ALL_TREE);
        assert.equal((await ui.labels(S.recent)).length, 7);
        assert.equal((await ui.labels(S.pinned)).length, 2);
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
          { label: '~/projects', description: '10 repos' },
          { label: '~/work', description: '3 repos' },
          { label: 'Add Folder…', description: '' },
        ]);
      });
      await ui.shot('manage-folders', { full: true });
    },
  },
  {
    id: 'remove-folder',
    kind: 'normal',
    title: 'Removing a folder in Manage Folders drops its repos from every section',
    async run(ui, assert, S) {
      await ui.command('RepoDock: Manage Folders');
      const row = ui.quickPickRow('~/work');
      await row.hover();
      await row.locator('a.action-label[aria-label="Remove Folder"]').click();
      await ui.eventually(async () => {
        assert.deepEqual(ui.readSettings()['repodock.directories'], ['~/projects']);
        assert.deepEqual(await ui.quickPickItems(), [
          { label: '~/projects', description: '10 repos' },
          { label: 'Add Folder…', description: '' },
        ]);
      });
      await ui.dismiss();
      await ui.eventually(async () => {
        // one folder left, so its own row goes and its contents move to the top level
        assert.equal((await ui.rows())[0].label, 'services');
        assert.deepEqual(await ui.labels(S.pinned), ['payments-api']);
        assert.equal((await sectionCounts(ui))['All Repositories'], '10');
      });
    },
  },
  {
    id: 'add-folder',
    kind: 'normal',
    title: 'Add Folder on the toolbar adds the chosen folder and scans it',
    settings: { 'repodock.directories': ['~/work'] },
    async run(ui, assert) {
      await ui.eventually(async () => assert.equal((await ui.rows())[0]?.label, 'clients'));
      await ui.clickTitleButton('Add Folder');
      const input = ui.page.locator('.quick-input-widget input.input');
      await input.waitFor({ state: 'visible' });
      await input.fill(ui.fixture('projects'));
      await ui.page
        .locator('.quick-input-widget .monaco-button', { hasText: 'Add to RepoDock' })
        .click();
      await ui.eventually(async () => {
        assert.deepEqual(ui.readSettings()['repodock.directories'], ['~/work', '~/projects']);
        const roots = (await ui.rows()).filter((row) => row.level === 1);
        assert.deepEqual(
          roots.map((row) => [row.label, row.description]),
          [
            ['~/work', '3'],
            ['~/projects', '10'],
          ],
        );
      });
    },
  },
  {
    id: 'recent-count',
    kind: 'normal',
    title: 'recentCount caps how many repos Recent lists',
    settings: { 'repodock.recentCount': 3 },
    async run(ui, assert, S) {
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(S.recent), ['storefront', 'payments-api', 'user-service']);
        assert.equal((await sectionCounts(ui))['Recent'], '3');
      });
    },
  },
  {
    id: 'live-git-status',
    kind: 'normal',
    title: 'A change made on disk shows up as a count after Refresh, and clears when undone',
    async run(ui, assert) {
      const scratch = ui.fixture('projects/web/admin-dashboard/scratch-from-scenario.txt');
      await ui.eventually(async () => assert.equal((await find(ui, 'admin-dashboard')).badge, ''));
      fs.writeFileSync(scratch, 'new\n');
      try {
        await ui.command('RepoDock: Refresh');
        await ui.eventually(async () => {
          assert.equal((await find(ui, 'admin-dashboard')).badge, '1');
        });
      } finally {
        fs.rmSync(scratch, { force: true });
      }
      await ui.command('RepoDock: Refresh');
      await ui.eventually(async () => assert.equal((await find(ui, 'admin-dashboard')).badge, ''));
    },
  },
  {
    id: 'new-repo-appears',
    kind: 'normal',
    title: 'A repo cloned after the scan appears on Refresh, and leaves when deleted',
    async run(ui, assert) {
      const repo = ui.fixture('projects/web/zz-fresh-clone');
      await ui.eventually(async () => assert.ok(await find(ui, 'web')));
      fs.mkdirSync(repo, { recursive: true });
      try {
        execFileSync('git', ['init', '-q', '-b', 'trunk', repo]);
        await ui.command('RepoDock: Refresh');
        await ui.eventually(async () => {
          const row = await find(ui, 'zz-fresh-clone');
          assert.equal(row.level, 3);
          assert.equal(row.description, 'trunk');
          assert.equal((await sectionCounts(ui))['All Repositories'], '14');
        });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
      await ui.command('RepoDock: Refresh');
      await ui.eventually(async () => {
        assert.equal(await find(ui, 'zz-fresh-clone'), undefined);
        assert.equal((await sectionCounts(ui))['All Repositories'], '13');
      });
    },
  },
  {
    id: 'branch-switch',
    kind: 'normal',
    title: 'Switching branch in a terminal shows the new branch after Refresh',
    async run(ui, assert) {
      const repo = ui.fixture('projects/web/playground');
      await ui.eventually(async () =>
        assert.equal((await findWebPlayground(ui)).description, 'main'),
      );
      git(repo, 'checkout', '-q', '-b', 'scenario/temp-branch');
      try {
        await ui.command('RepoDock: Refresh');
        await ui.eventually(async () => {
          // no upstream yet, so no arrows
          assert.equal((await findWebPlayground(ui)).description, 'scenario/temp-branch');
        });
      } finally {
        git(repo, 'checkout', '-q', 'main');
        git(repo, 'branch', '-q', '-D', 'scenario/temp-branch');
      }
      await ui.command('RepoDock: Refresh');
      await ui.eventually(async () =>
        assert.equal((await findWebPlayground(ui)).description, 'main'),
      );
    },
  },
  {
    id: 'light-theme',
    kind: 'normal',
    title: 'In a light theme the current repo is still set apart and rows stay legible',
    async run(ui, assert) {
      const toggle = 'Preferences: Toggle between Light/Dark Themes';
      // read off the sidebar's own background, which holds for any theme, built in or not
      const isDark = () =>
        ui.page.evaluate(() => {
          const sidebar = document.querySelector('.part.sidebar');
          const [red, green, blue] = (getComputedStyle(sidebar).backgroundColor.match(/\d+/g) ?? [])
            .slice(0, 3)
            .map(Number);
          return (red + green + blue) / 3 < 128;
        });
      assert.equal(await isDark(), true);
      await ui.command(toggle);
      try {
        await ui.eventually(async () => {
          assert.equal(await isDark(), false);
          const current = await find(ui, 'storefront');
          const other = await find(ui, 'admin-dashboard');
          assert.notEqual(current.color, other.color);
          assert.equal(current.badge, '5');
        });
        await ui.shot('light-theme', { sidebarOnly: true });
      } finally {
        await ui.command(toggle);
      }
      await ui.eventually(async () => assert.equal(await isDark(), true));
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
        assert.deepEqual(await ui.tree(), []);
        const welcome = await ui.welcome();
        assert.match(welcome.text, /Add a folder and RepoDock will find every git repository/);
        assert.deepEqual(welcome.buttons, ['Add Folder']);
      });
      await ui.shot('empty-no-folders', { sidebarOnly: true });
    },
  },
  {
    id: 'empty-no-repos',
    kind: 'edge',
    title: 'A folder with no repos gets the "none found" message, and no empty sections',
    settings: { 'repodock.directories': ['~/empty'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        // the seeded pins and recents point outside ~/empty, so no section has a row
        assert.deepEqual(await ui.tree(), []);
        const welcome = await ui.welcome();
        assert.match(welcome.text, /No git repositories found in the folders you added/);
        assert.deepEqual(welcome.buttons, ['Add Another Folder']);
      });
      await ui.shot('empty-no-repos', { sidebarOnly: true });
    },
  },
  {
    id: 'no-pins-no-recents',
    kind: 'edge',
    title: 'Sections with nothing in them are left out instead of shown empty',
    settings: { 'repodock.directories': ['~/edge'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        // nothing under ~/edge is pinned or was ever opened
        assert.deepEqual(
          (await ui.sections()).map((section) => [section.title, section.count]),
          [['All Repositories', '6']],
        );
      });
    },
  },
  {
    id: 'missing-folder',
    kind: 'edge',
    title: 'A configured folder that does not exist is skipped without an error',
    settings: { 'repodock.directories': ['~/does-not-exist', '~/work'] },
    async run(ui, assert) {
      await ui.eventually(() =>
        // one folder with repos, so its own row is dropped
        expectTree(ui, assert, [
          [1, 'clients', '2'],
          [2, 'client-portal', 'feature/sso-login-redirect-handling'],
          [2, 'reporting-api', 'main ↓2'],
          [1, 'infrastructure', 'main'],
        ]),
      );
      assert.deepEqual(await ownNotifications(ui), []);
    },
  },
  {
    id: 'stale-pins-and-recents',
    kind: 'edge',
    title: 'Pins and recents outside the configured folders drop out, and return with them',
    settings: { 'repodock.directories': ['~/work'] },
    async run(ui, assert, S) {
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(S.pinned), ['infrastructure']);
        assert.deepEqual(await ui.labels(S.recent), ['client-portal']);
        assert.deepEqual(await sectionCounts(ui), {
          Pinned: '1',
          Recent: '1',
          'All Repositories': '3',
        });
      });
      ui.setSettings();
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(S.pinned), ['infrastructure', 'payments-api']);
        assert.equal((await ui.labels(S.recent)).length, 7);
      });
    },
  },
  {
    id: 'overlapping-folders',
    kind: 'edge',
    title: 'A folder nested inside another configured folder lists each repo once',
    settings: { 'repodock.directories': ['~/projects', '~/projects/services'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const rows = await ui.rows();
        assert.deepEqual(
          rows.filter((row) => row.level === 1).map((row) => [row.label, row.description]),
          [
            ['~/projects', '6'],
            ['~/projects/services', '4'],
          ],
        );
        assert.equal(rows.filter((row) => row.label === 'payments-api').length, 1);
        assert.equal(rows.filter((row) => row.label === 'services').length, 0);
        assert.equal((await sectionCounts(ui))['All Repositories'], '10');
      });
      await ui.shot('overlapping-folders');
    },
  },
  {
    id: 'folder-that-is-a-repo',
    kind: 'edge',
    title: 'A configured folder that is itself a repository shows as a repo row',
    settings: { 'repodock.directories': ['~/projects/dev-setup', '~/work'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const top = (await ui.rows()).filter((row) => row.level === 1);
        assert.deepEqual(
          top.map((row) => [row.label, row.icon, row.description]),
          [
            ['dev-setup', 'source-control', 'main ↑3'],
            ['~/work', 'folder', '3'],
          ],
        );
      });
    },
  },
  {
    id: 'same-name-repos',
    kind: 'edge',
    title: 'Same-named repos get their folder in flat sections and stay bare in the tree',
    async run(ui, assert, S) {
      await ui.eventually(async () => {
        assert.equal((await ui.labels()).filter((label) => label === 'playground').length, 2);
      });
      await ui.clickRowButton('playground', 'Pin Repository', S.all, 0);
      await ui.eventually(async () =>
        assert.ok((await ui.labels(S.pinned)).includes('playground')),
      );
      await ui.clickRowButton('playground', 'Pin Repository', S.all, 1);
      await ui.eventually(async () => {
        // name order, with the path settling the tie: tools/experiments sorts ahead of web
        assert.deepEqual(await ui.labels(S.pinned), [
          'infrastructure',
          'payments-api',
          'playground (experiments)',
          'playground (web)',
        ]);
      });
      await ui.shot('same-name-repos');
      await ui.clickRowButton('playground (experiments)', 'Unpin Repository', S.pinned);
      await ui.eventually(async () => {
        // alone again, it needs no folder to tell it apart
        assert.deepEqual(await ui.labels(S.pinned), [
          'infrastructure',
          'payments-api',
          'playground',
        ]);
      });
      await ui.clickRowButton('playground', 'Unpin Repository', S.pinned);
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(S.pinned), ['infrastructure', 'payments-api']);
      });
    },
  },
  {
    id: 'nested-repos-off',
    kind: 'edge',
    title: 'showNestedRepos: false drops nested repos and the twistie that led to them',
    settings: { 'repodock.showNestedRepos': false },
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.equal((await find(ui, 'api-gateway')).expanded, null);
        assert.equal((await sectionCounts(ui))['All Repositories'], '12');
        assert.equal((await find(ui, 'services')).description, '3');
      });
    },
  },
  {
    id: 'unusual-names',
    kind: 'edge',
    title: 'Spaces, non-ASCII, and markdown in names render literally; exclusions hold',
    settings: { 'repodock.directories': ['~/edge'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const rows = await ui.rows();
        // the deep/a/b chain holds one repo, so it is one merged row
        assert.deepEqual(
          rows.slice(0, 2).map((row) => [row.level, row.label]),
          [
            [1, 'deep/a/b'],
            [2, 'at-limit'],
          ],
        );
        assert.deepEqual(
          rows
            .slice(2)
            .map((row) => row.label)
            .sort(),
          [
            '*not-bold*_[link](x)',
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
    id: 'unusual-git-states',
    kind: 'edge',
    title: 'A repo with no commits and a linked worktree each show their branch',
    settings: { 'repodock.directories': ['~/edge'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.equal((await find(ui, 'empty-repo')).description, 'main');
        assert.equal((await find(ui, 'linked-worktree')).description, 'worktree-branch');
      });
    },
  },
  {
    id: 'max-depth',
    kind: 'edge',
    title: 'Raising maxDepth reveals a repo below the limit, splitting the merged folder row',
    settings: { 'repodock.directories': ['~/edge'], 'repodock.maxDepth': 8 },
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.deepEqual(
          (await ui.rows()).slice(0, 4).map((row) => [row.level, row.label, row.description]),
          [
            [1, 'deep/a/b', '2'],
            [2, 'c/d', '1'],
            [3, 'too-deep', 'main'],
            [2, 'at-limit', 'main'],
          ],
        );
      });
    },
  },
  {
    id: 'malformed-settings',
    kind: 'edge',
    title: 'Hand-edited settings of the wrong type fall back safely instead of breaking the view',
    settings: {
      'repodock.directories': [42, '', 'relative/path', '~/work'],
      'repodock.recentCount': 'lots',
      'repodock.maxDepth': -5,
      'repodock.exclude': 'node_modules',
      'repodock.showNestedRepos': 'no',
      'repodock.hiddenRepos': { not: 'a list' },
    },
    async run(ui, assert, S) {
      await ui.eventually(async () => {
        // maxDepth clamps to 1, so only the repo directly inside ~/work is found
        assert.deepEqual(await ui.labels(), ['infrastructure']);
        assert.deepEqual(await ui.labels(S.pinned), ['infrastructure']);
      });
      assert.deepEqual(await ownNotifications(ui), []);
    },
  },
  {
    id: 'long-branch-names',
    kind: 'edge',
    title: 'A long branch name is cut short before the repo name ever is',
    async run(ui, assert, S) {
      await ui.eventually(async () => {
        for (const section of [S.all, S.recent]) {
          const row = await find(ui, 'client-portal', section);
          assert.equal(row.isNameWhole, true, section);
          assert.equal(row.badge, '2', section);
        }
      });
    },
  },
  {
    id: 'many-repos',
    kind: 'edge',
    title: '150 repositories all load, and the tree stays scrollable',
    settings: { 'repodock.directories': ['~/many'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        const rows = await ui.rows();
        assert.equal(rows[0]?.total, 150);
        assert.equal(rows[0]?.label, 'repo-001');
        assert.equal(rows[0]?.description, 'main');
        assert.equal((await sectionCounts(ui))['All Repositories'], '150');
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
      await (await ui.row('soon-deleted')).click();
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
    title:
      'Clicking a repo opens it here; after the reload it heads Recent and view state survives',
    async run(ui, assert, S) {
      await ui.eventually(async () => assert.ok(await find(ui, 'dev-setup')));
      // collapsed now, to see whether the reload keeps it that way
      await ui.toggleSection(S.pinned);
      await ui.eventually(async () => assert.deepEqual(await ui.labels(S.pinned), []));
      await (await ui.row('dev-setup')).click();
      await ui.eventually(async () => {
        assert.match(await ui.page.title(), /dev-setup/);
      }, 60_000);
      await ui.command('RepoDock: Focus on Repositories View');
      await ui.eventually(async () => {
        const [first, second] = await ui.rows(S.recent);
        assert.equal(first?.label, 'dev-setup');
        assert.match(first?.description ?? '', /^main ↑3 · (now|\dm)$/);
        // the window it came from was opened moments earlier, so it is next
        assert.equal(second?.label, 'storefront');
        // pins are stored, so the count is intact; the section is still folded away
        const pinned = (await ui.sections()).find((section) => section.title === 'Pinned');
        assert.equal(pinned.count, '2');
        assert.equal(pinned.isExpanded, false);
        // the highlight follows the window: dev-setup is current now, storefront no longer is
        const current = await find(ui, 'dev-setup');
        assert.notEqual(current.color, (await find(ui, 'storefront')).color);
        // the tree drawn by a window that loads with the sidebar already open
        await expectTree(ui, assert, ALL_TREE);
      }, 60_000);
      await ui.shot('open-repo');
    },
  },
];
