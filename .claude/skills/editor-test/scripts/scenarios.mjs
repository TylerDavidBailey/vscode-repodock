// The scenario catalog: what RepoDock is expected to do in a real editor. This is the file
// a PR edits. Each scenario runs in VS Code and in VSCodium against the fixtures that
// make-fixtures.sh builds, and starts from the base settings plus its own `settings`.
//
//   kind 'normal'  a path every user takes
//   kind 'edge'    unusual input, unusual state, or a failure the UI has to survive
//
// A scenario's `run(ui, assert, P)` gets the UI helpers, node's strict assert, and the
// names of the tree's two parts: the pinned repos above the gap row, and the rest below
// it. Assert through `ui.eventually`, because every update reaches the view
// asynchronously, and end with `ui.shot(id)` when the state is worth a picture.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// functions handed to page.evaluate run inside the editor window
/* global document, getComputedStyle */

/** The pinned repos under the base settings, as [label, description] rows. */
const PINNED = [
  ['infrastructure', 'main'],
  ['payments-api', 'fix/retry-webhooks ↑1'],
];

/**
 * The folder layout below the gap under the base settings, as [level, label, description]
 * rows. The two pinned repos have moved up, out of services/ and ~/work.
 */
const FOLDER_TREE = [
  [1, '~/projects', ''],
  [2, 'services', ''],
  [3, 'api-gateway', 'main'],
  [3, 'user-service', 'main ↓4'],
  [2, 'tools', ''],
  [3, 'experiments', ''],
  [4, 'playground', /^[0-9a-f]{7} \(detached\)$/],
  [3, 'deploy-cli', 'develop'],
  [2, 'web', ''],
  [3, 'admin-dashboard', 'release/v2.1.0'],
  [3, 'playground', 'main'],
  [3, 'storefront', 'feat/checkout-redesign ↑2 ↓1'],
  [2, 'dev-setup', 'main ↑3'],
  [1, '~/work', ''],
  [2, 'clients', ''],
  [3, 'client-portal', 'feature/sso-login-redirect-handling'],
  [3, 'reporting-api', 'main ↓2'],
];

/**
 * The recent layout below the gap under the base settings: the seeded last-opened times,
 * newest first, then the repos never opened, by name.
 */
const RECENT_LIST = [
  [1, 'storefront', /^feat\/checkout-redesign ↑2 ↓1 · (now|\dm)$/],
  [1, 'user-service', 'main ↓4 · 5h'],
  [1, 'client-portal', 'feature/sso-login-redirect-handling · 1d'],
  [1, 'admin-dashboard', 'release/v2.1.0 · 3d'],
  [1, 'deploy-cli', 'develop · 1w'],
  [1, 'dev-setup', 'main ↑3 · 1mo'],
  [1, 'api-gateway', 'main'],
  [1, 'playground (experiments)', /^[0-9a-f]{7} \(detached\)$/],
  [1, 'playground (web)', 'main'],
  [1, 'reporting-api', 'main ↓2'],
  [1, 'shared-utils', 'main'],
];

/** Asserts a part's rows against [level, label, description] triples. */
async function expectTree(ui, assert, expected, part) {
  const rows = await ui.rows(part);
  assert.deepEqual(
    rows.map((row) => [row.level, row.label]),
    expected.map(([level, label]) => [level, label]),
  );
  for (const [index, [, label, description]] of expected.entries()) {
    if (description instanceof RegExp) assert.match(rows[index].description, description, label);
    else assert.equal(rows[index].description, description, label);
  }
}

const find = async (ui, label, part) => (await ui.rows(part)).find((row) => row.label === label);

/** The playground repo under web/, as opposed to its namesake under tools/experiments/. */
const findWebPlayground = async (ui) =>
  (await ui.rows()).find((row) => row.label === 'playground' && row.level === 3);

/** Notifications that are RepoDock's own, leaving out the editor's (running as root, etc.). */
const ownNotifications = async (ui) =>
  (await ui.notifications()).filter((message) => /repodock/i.test(message));

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });

export const scenarios = [
  // ---------------------------------------------------------------- normal cases
  {
    id: 'sidebar',
    kind: 'normal',
    title: 'Pinned repos lead, one blank row follows, then the folders, all one row apart',
    async run(ui, assert, P) {
      await ui.eventually(async () => {
        const tree = await ui.tree();
        assert.deepEqual(
          tree.slice(0, 4).map((row) => [row.level, row.label]),
          [
            [1, 'infrastructure'],
            [1, 'payments-api'],
            [1, ''],
            [1, '~/projects'],
          ],
        );
        // the gap is one ordinary row high: no section takes more height than its rows
        const rowHeight = tree[1].top - tree[0].top;
        for (const [index, row] of tree.entries()) {
          if (index > 0) assert.equal(row.top - tree[index - 1].top, rowHeight, row.label);
        }
        const gap = await ui.gap();
        assert.equal(gap.description, '');
        assert.equal(gap.expanded, null);
        await expectTree(ui, assert, FOLDER_TREE, P.rest);
      });
      await ui.shot('sidebar', { sidebarOnly: true });
    },
  },
  {
    id: 'pinned-repos',
    kind: 'normal',
    title: 'Pinned repos are listed by name with branch and sync arrows, above the gap',
    async run(ui, assert, P) {
      await ui.eventually(async () => {
        assert.deepEqual(
          (await ui.rows(P.pinned)).map((row) => [row.label, row.description]),
          PINNED,
        );
        // pinning moves a repo; it is not repeated below
        assert.ok(!(await ui.labels(P.rest)).includes('payments-api'));
        assert.ok(!(await ui.labels(P.rest)).includes('infrastructure'));
      });
    },
  },
  {
    id: 'folder-layout',
    kind: 'normal',
    title: 'Below the gap the folder layout mirrors the disk: scan folder, folders, then repos',
    async run(ui, assert, P) {
      // Compared row by row on purpose. VSCodium 1.143 once drew the rows of services/
      // under ~/work here, when the extension revealed a row while the tree was loading.
      await ui.eventually(() => expectTree(ui, assert, FOLDER_TREE, P.rest));
      await ui.shot('folder-layout');
    },
  },
  {
    id: 'recent-layout',
    kind: 'normal',
    title: 'The recent layout lists every unpinned repo flat, newest-opened first, with times',
    settings: { 'repodock.layout': 'recent' },
    async run(ui, assert, P) {
      await ui.eventually(async () => {
        assert.deepEqual(
          (await ui.rows(P.pinned)).map((row) => [row.label, row.description]),
          PINNED,
        );
        await expectTree(ui, assert, RECENT_LIST, P.rest);
        assert.equal((await ui.titleButtons())[0], 'Show Folders');
      });
      await ui.shot('recent-layout', { sidebarOnly: true });
    },
  },
  {
    id: 'quiet-rows',
    kind: 'normal',
    title: 'No row carries an icon, a count, or a badge, dirty or clean, folder or repo',
    async run(ui, assert) {
      await ui.eventually(async () => {
        const tree = await ui.tree();
        assert.ok(tree.length > 10);
        for (const row of tree) {
          assert.equal(row.hasIcon, false, `${row.label} has an icon`);
          assert.equal(row.badge, '', `${row.label} has a badge`);
        }
        // storefront has uncommitted files; they are in its tooltip, not on its row
        assert.equal((await find(ui, 'storefront')).badge, '');
        assert.equal((await find(ui, 'web')).description, '');
      });
    },
  },
  {
    id: 'current-repo',
    kind: 'normal',
    title: 'The repo open in this window looks like any other row, and nothing is selected',
    async run(ui, assert) {
      await ui.eventually(async () => {
        // only its tooltip says it is open here (see 'tooltip'); the row is unmarked
        const current = await find(ui, 'storefront');
        const other = await find(ui, 'admin-dashboard');
        assert.equal(current.color, other.color);
        assert.equal(current.hasIcon, false);
        // a selection would mean the view scrolled itself to some row on load
        assert.deepEqual(
          (await ui.tree()).filter((row) => row.selected),
          [],
        );
        assert.equal((await ui.tree())[0].label, 'infrastructure');
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
    title: 'The row menu lists every repo action in order, pinned or not',
    async run(ui, assert, P) {
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
      assert.deepEqual(await ui.openContextMenu('payments-api', P.pinned), [
        'Unpin Repository',
        ...actions,
      ]);
    },
  },
  {
    id: 'folder-and-gap-rows',
    kind: 'normal',
    title: 'Folder rows and the gap row offer no repo actions: no buttons, no repo menu',
    async run(ui, assert) {
      await ui.eventually(async () => assert.ok(await find(ui, 'web')));
      const menu = () =>
        ui.page.locator('.context-view .monaco-menu .action-label').allInnerTexts();
      for (const label of ['web', '']) {
        assert.deepEqual(await ui.rowButtons(label), [], `buttons on "${label}"`);
        await (await ui.row(label)).click({ button: 'right' });
        // the menu VS Code may show is its own; none of ours may be on it
        assert.ok(!(await menu()).some((item) => /Repository|Open in/.test(item)), label);
        await ui.dismiss();
      }
      // clicking the gap opens nothing
      const title = await ui.page.title();
      await (await ui.row('')).click();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(await ui.page.title(), title);
    },
  },
  {
    id: 'row-buttons',
    kind: 'normal',
    title: 'Hovering a repo offers Pin or Unpin, and Open in New Window',
    async run(ui, assert, P) {
      await ui.eventually(async () => assert.ok(await find(ui, 'user-service')));
      assert.deepEqual(await ui.rowButtons('user-service'), [
        'Pin Repository',
        'Open in New Window',
      ]);
      assert.deepEqual(await ui.rowButtons('payments-api', P.pinned), [
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
    title: 'Pinning moves a repo above the gap; unpinning puts it back in its folder',
    async run(ui, assert, P) {
      await ui.eventually(async () => assert.ok(await find(ui, 'reporting-api')));
      await ui.clickRowButton('reporting-api', 'Pin Repository');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(P.pinned), [
          'infrastructure',
          'payments-api',
          'reporting-api',
        ]);
        assert.ok(!(await ui.labels(P.rest)).includes('reporting-api'));
      });
      await ui.shot('pin-unpin');
      await ui.openContextMenu('reporting-api', P.pinned);
      await ui.chooseMenuItem('Unpin Repository');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(P.pinned), ['infrastructure', 'payments-api']);
        await expectTree(ui, assert, FOLDER_TREE, P.rest);
      });
    },
  },
  {
    id: 'hide-unhide',
    kind: 'normal',
    title: 'Hiding removes a repo from the view and records it; Unhide All restores it',
    async run(ui, assert) {
      await ui.eventually(async () => assert.ok(await find(ui, 'dev-setup')));
      await ui.openContextMenu('dev-setup');
      await ui.chooseMenuItem('Hide Repository');
      await ui.eventually(async () => {
        assert.ok(!(await ui.labels()).includes('dev-setup'));
      });
      assert.deepEqual(ui.readSettings()['repodock.hiddenRepos'], ['~/projects/dev-setup']);
      await ui.command('RepoDock: Unhide All Repositories');
      await ui.eventually(async () => {
        assert.ok((await ui.labels()).includes('dev-setup'));
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
    title: 'The title bar offers the layout toggle, Add Folder, Refresh, and Collapse All',
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.deepEqual((await ui.titleButtons()).slice(0, 4), [
          'Show Recently Opened First',
          'Add Folder',
          'Refresh',
          'Collapse All',
        ]);
      });
    },
  },
  {
    id: 'layout-toggle',
    kind: 'normal',
    title: 'The title-bar toggle switches layouts, swaps itself, and saves the choice',
    async run(ui, assert, P) {
      await ui.eventually(() => expectTree(ui, assert, FOLDER_TREE, P.rest));
      await ui.clickTitleButton('Show Recently Opened First');
      await ui.eventually(async () => {
        await expectTree(ui, assert, RECENT_LIST, P.rest);
        assert.equal((await ui.titleButtons())[0], 'Show Folders');
        assert.equal(ui.readSettings()['repodock.layout'], 'recent');
      });
      await ui.clickTitleButton('Show Folders');
      await ui.eventually(async () => {
        await expectTree(ui, assert, FOLDER_TREE, P.rest);
        assert.equal((await ui.titleButtons())[0], 'Show Recently Opened First');
        assert.equal(ui.readSettings()['repodock.layout'], 'folders');
      });
    },
  },
  {
    id: 'collapse-folders',
    kind: 'normal',
    title: 'Folding a folder moves the next one up, and Collapse All folds every folder',
    async run(ui, assert, P) {
      await ui.eventually(() => expectTree(ui, assert, FOLDER_TREE, P.rest));
      await ui.toggle('~/projects');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(P.rest), [
          '~/projects',
          '~/work',
          'clients',
          'client-portal',
          'reporting-api',
        ]);
      });
      await ui.shot('collapse-folders', { sidebarOnly: true });

      await ui.clickTitleButton('Collapse All');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(), [
          'infrastructure',
          'payments-api',
          '',
          '~/projects',
          '~/work',
        ]);
      });

      // Alt-click reopens a folder and everything below it
      for (const folder of ['~/projects', '~/work']) {
        await ui.toggle(folder, P.rest, { recursive: true });
      }
      // A recursive expand may or may not open api-gateway too, depending on whether VS
      // Code has resolved its children yet. Let it settle, then put it back the way it starts.
      await ui.eventually(async () => assert.ok(await find(ui, 'reporting-api')));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if ((await find(ui, 'api-gateway')).expanded === 'true') await ui.toggle('api-gateway');
      await ui.eventually(() => expectTree(ui, assert, FOLDER_TREE, P.rest));
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
    title: 'Removing a folder in Manage Folders drops its repos, pinned ones included',
    async run(ui, assert, P) {
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
        assert.deepEqual(await ui.labels(P.pinned), ['payments-api']);
        // one folder left, so its own row goes and its contents move to the top level
        assert.equal((await ui.rows(P.rest))[0].label, 'services');
        assert.ok(!(await ui.labels()).includes('clients'));
      });
    },
  },
  {
    id: 'add-folder',
    kind: 'normal',
    title: 'Add Folder on the toolbar adds the chosen folder and scans it',
    settings: { 'repodock.directories': ['~/work'] },
    async run(ui, assert, P) {
      await ui.eventually(async () => assert.equal((await ui.rows(P.rest))[0]?.label, 'clients'));
      await ui.clickTitleButton('Add Folder');
      const input = ui.page.locator('.quick-input-widget input.input');
      await input.waitFor({ state: 'visible' });
      await input.fill(ui.fixture('projects'));
      await ui.page
        .locator('.quick-input-widget .monaco-button', { hasText: 'Add to RepoDock' })
        .click();
      await ui.eventually(async () => {
        assert.deepEqual(ui.readSettings()['repodock.directories'], ['~/work', '~/projects']);
        const roots = (await ui.rows(P.rest)).filter((row) => row.level === 1);
        assert.deepEqual(
          roots.map((row) => row.label),
          ['~/work', '~/projects'],
        );
      });
    },
  },
  {
    id: 'live-git-status',
    kind: 'normal',
    title: 'A change made on disk shows in the tooltip after Refresh, and clears when undone',
    async run(ui, assert, P) {
      const scratch = ui.fixture('projects/web/admin-dashboard/scratch-from-scenario.txt');
      // the whole tree first: the scenario before may have left another folder order, and
      // a row looked up mid-redraw is hovered at the index it no longer has
      await ui.eventually(() => expectTree(ui, assert, FOLDER_TREE, P.rest));
      assert.match((await ui.tooltip('admin-dashboard')).text, /Working tree clean/);
      await ui.dismiss();
      fs.writeFileSync(scratch, 'new\n');
      try {
        await ui.command('RepoDock: Refresh');
        await ui.eventually(async () => {
          assert.match((await ui.tooltip('admin-dashboard')).text, /0 modified, 1 untracked/);
          // the row itself stays quiet
          assert.equal((await find(ui, 'admin-dashboard')).badge, '');
        });
      } finally {
        await ui.dismiss();
        fs.rmSync(scratch, { force: true });
      }
      await ui.command('RepoDock: Refresh');
      await ui.eventually(async () => {
        assert.match((await ui.tooltip('admin-dashboard')).text, /Working tree clean/);
      });
      await ui.dismiss();
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
        });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
      await ui.command('RepoDock: Refresh');
      await ui.eventually(async () => {
        assert.equal(await find(ui, 'zz-fresh-clone'), undefined);
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
    title: 'In a light theme the rows follow the theme like the rest of the sidebar',
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
          // dark text on the light background: the rows took the theme's colors
          const [red, green, blue] = ((await find(ui, 'storefront')).color.match(/\d+/g) ?? [])
            .slice(0, 3)
            .map(Number);
          assert.ok((red + green + blue) / 3 < 128, 'row text is still light');
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
    title: 'A folder with no repos gets the "none found" message, and no stray gap row',
    settings: { 'repodock.directories': ['~/empty'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        // the seeded pins point outside ~/empty, so there is no row at all
        assert.deepEqual(await ui.tree(), []);
        const welcome = await ui.welcome();
        assert.match(welcome.text, /No git repositories found in the folders you added/);
        assert.deepEqual(welcome.buttons, ['Add Another Folder']);
      });
      await ui.shot('empty-no-repos', { sidebarOnly: true });
    },
  },
  {
    id: 'no-pins-no-gap',
    kind: 'edge',
    title: 'With nothing pinned there is no gap row: the tree starts with the folders',
    settings: { 'repodock.directories': ['~/edge'] },
    async run(ui, assert) {
      await ui.eventually(async () => {
        // nothing under ~/edge is pinned
        assert.equal(await ui.gap(), undefined);
        assert.equal((await ui.tree())[0].label, 'deep/a/b');
      });
    },
  },
  {
    id: 'everything-pinned',
    kind: 'edge',
    title: 'With every repo pinned there is no gap row below the pins',
    settings: { 'repodock.directories': ['~/work'] },
    async run(ui, assert, P) {
      await ui.eventually(async () => assert.ok(await find(ui, 'client-portal')));
      await ui.clickRowButton('client-portal', 'Pin Repository');
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(P.pinned), ['client-portal', 'infrastructure']);
      });
      await ui.clickRowButton('reporting-api', 'Pin Repository');
      try {
        await ui.eventually(async () => {
          assert.deepEqual(await ui.labels(), ['client-portal', 'infrastructure', 'reporting-api']);
          assert.equal(await ui.gap(), undefined);
        });
      } finally {
        for (const label of ['client-portal', 'reporting-api']) {
          await ui.clickRowButton(label, 'Unpin Repository');
        }
      }
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(), [
          'infrastructure',
          '',
          'clients',
          'client-portal',
          'reporting-api',
        ]);
      });
    },
  },
  {
    id: 'missing-folder',
    kind: 'edge',
    title: 'A configured folder that does not exist is skipped without an error',
    settings: { 'repodock.directories': ['~/does-not-exist', '~/work'] },
    async run(ui, assert, P) {
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(P.pinned), ['infrastructure']);
        // one folder with repos, so its own row is dropped
        await expectTree(
          ui,
          assert,
          [
            [1, 'clients', ''],
            [2, 'client-portal', 'feature/sso-login-redirect-handling'],
            [2, 'reporting-api', 'main ↓2'],
          ],
          P.rest,
        );
      });
      assert.deepEqual(await ownNotifications(ui), []);
    },
  },
  {
    id: 'stale-pins',
    kind: 'edge',
    title: 'Pins outside the configured folders drop out, and return with their folder',
    settings: { 'repodock.directories': ['~/work'], 'repodock.layout': 'recent' },
    async run(ui, assert, P) {
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(P.pinned), ['infrastructure']);
        // the recent order keeps only what is still scanned
        assert.deepEqual(await ui.labels(P.rest), ['client-portal', 'reporting-api']);
      });
      ui.setSettings({ 'repodock.layout': 'recent' });
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(P.pinned), ['infrastructure', 'payments-api']);
        await expectTree(ui, assert, RECENT_LIST, P.rest);
      });
    },
  },
  {
    id: 'overlapping-folders',
    kind: 'edge',
    title: 'A folder nested inside another configured folder lists each repo once',
    settings: { 'repodock.directories': ['~/projects', '~/projects/services'] },
    async run(ui, assert, P) {
      await ui.eventually(async () => {
        const rows = await ui.rows(P.rest);
        assert.deepEqual(
          rows.filter((row) => row.level === 1).map((row) => row.label),
          ['~/projects', '~/projects/services'],
        );
        assert.equal(rows.filter((row) => row.label === 'user-service').length, 1);
        assert.equal(rows.filter((row) => row.label === 'services').length, 0);
        assert.equal((await ui.labels()).filter((label) => label === 'payments-api').length, 1);
      });
      await ui.shot('overlapping-folders');
    },
  },
  {
    id: 'folder-that-is-a-repo',
    kind: 'edge',
    title: 'A configured folder that is itself a repository shows as a repo row',
    settings: { 'repodock.directories': ['~/projects/dev-setup', '~/work'] },
    async run(ui, assert, P) {
      await ui.eventually(async () => {
        const top = (await ui.rows(P.rest)).filter((row) => row.level === 1);
        // with no icons, the twistie and the branch are what tell a repo from a folder
        assert.deepEqual(
          top.map((row) => [row.label, row.description, row.expanded]),
          [
            ['dev-setup', 'main ↑3', null],
            ['~/work', '', 'true'],
          ],
        );
      });
    },
  },
  {
    id: 'same-name-repos',
    kind: 'edge',
    title: 'Same-named repos get their folder once pinned side by side, and stay bare in folders',
    async run(ui, assert, P) {
      await ui.eventually(async () => {
        assert.equal((await ui.labels(P.rest)).filter((label) => label === 'playground').length, 2);
      });
      await ui.clickRowButton('playground', 'Pin Repository', P.rest, 0);
      await ui.eventually(async () =>
        assert.ok((await ui.labels(P.pinned)).includes('playground')),
      );
      // the other one is now the only playground below the gap
      await ui.clickRowButton('playground', 'Pin Repository', P.rest, 0);
      await ui.eventually(async () => {
        // name order, with the path settling the tie: tools/experiments sorts ahead of web
        assert.deepEqual(await ui.labels(P.pinned), [
          'infrastructure',
          'payments-api',
          'playground (experiments)',
          'playground (web)',
        ]);
      });
      await ui.shot('same-name-repos');
      await ui.clickRowButton('playground (experiments)', 'Unpin Repository', P.pinned);
      await ui.eventually(async () => {
        // alone again, it needs no folder to tell it apart
        assert.deepEqual(await ui.labels(P.pinned), [
          'infrastructure',
          'payments-api',
          'playground',
        ]);
      });
      await ui.clickRowButton('playground', 'Unpin Repository', P.pinned);
      await ui.eventually(async () => {
        assert.deepEqual(await ui.labels(P.pinned), ['infrastructure', 'payments-api']);
      });
    },
  },
  {
    id: 'nested-repos-off',
    kind: 'edge',
    title: 'showNestedRepos: false drops nested repos and the twistie that led to them',
    settings: { 'repodock.showNestedRepos': false, 'repodock.layout': 'recent' },
    async run(ui, assert) {
      await ui.eventually(async () => {
        assert.equal((await find(ui, 'api-gateway')).expanded, null);
        assert.ok(!(await ui.labels()).includes('shared-utils'));
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
            [1, 'deep/a/b', ''],
            [2, 'c/d', ''],
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
      'repodock.layout': 'sideways',
      'repodock.maxDepth': -5,
      'repodock.exclude': 'node_modules',
      'repodock.showNestedRepos': 'no',
      'repodock.hiddenRepos': { not: 'a list' },
    },
    async run(ui, assert) {
      await ui.eventually(async () => {
        // maxDepth clamps to 1, so only the repo directly inside ~/work is found. It is
        // pinned, and with nothing below it there is no gap.
        assert.deepEqual(await ui.labels(), ['infrastructure']);
        // an unknown layout reads as folders, so the toggle offers the other one
        assert.equal((await ui.titleButtons())[0], 'Show Recently Opened First');
      });
      assert.deepEqual(await ownNotifications(ui), []);
    },
  },
  {
    id: 'long-branch-names',
    kind: 'edge',
    title: 'A long branch name is cut short before the repo name ever is',
    async run(ui, assert) {
      await ui.eventually(async () => {
        const row = await find(ui, 'client-portal');
        assert.equal(row.isNameWhole, true);
      });
      ui.setSettings({ 'repodock.layout': 'recent' });
      await ui.eventually(async () => {
        // the recent layout adds a time to the same long description
        const row = await find(ui, 'client-portal');
        assert.match(row.description, / · 1d$/);
        assert.equal(row.isNameWhole, true);
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
  {
    id: 'hostile-repo-config',
    kind: 'edge',
    title: 'A repo whose own config names a program to run is listed without running it',
    settings: { 'repodock.directories': ['~/hostile'] },
    async run(ui, assert) {
      // An unpacked archive can carry a .git/config like these. The program each one
      // names only creates a marker file, so "did it run" is "does the marker exist".
      const root = ui.fixture('hostile');
      const marker = path.join(root, 'RAN');
      const identity = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
      };
      const make = (name) => {
        const repo = path.join(root, name);
        fs.mkdirSync(repo, { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'main', repo]);
        fs.writeFileSync(path.join(repo, 'tracked.txt'), 'content\n');
        execFileSync('git', ['-C', repo, 'add', '-A'], { env: identity });
        execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { env: identity });
        return repo;
      };
      fs.rmSync(root, { recursive: true, force: true });
      try {
        const monitored = make('fsmonitor-trap');
        git(monitored, 'config', 'core.fsmonitor', `touch '${marker}'; false`);
        const filtered = make('filter-trap');
        git(filtered, 'config', 'filter.evil.clean', `touch '${marker}'; cat`);
        fs.writeFileSync(path.join(filtered, '.gitattributes'), '* filter=evil\n');
        // an old timestamp makes git re-read the file, which is when a filter runs
        fs.utimesSync(path.join(filtered, 'tracked.txt'), new Date(0), new Date(0));

        // the control: an ordinary git status does run the trap
        try {
          git(monitored, 'status');
        } catch {
          // git's own verdict is beside the point
        }
        assert.ok(fs.existsSync(marker), 'the trap does not work, so this proves nothing');
        fs.rmSync(marker);

        await ui.command('RepoDock: Refresh');
        await ui.eventually(async () => {
          assert.deepEqual(
            (await ui.rows()).map((row) => [row.label, row.description]),
            [
              ['filter-trap', 'main'],
              ['fsmonitor-trap', 'main'],
            ],
          );
        });
        // one more full load, so both git calls per repo have certainly happened
        await ui.command('RepoDock: Refresh');
        await ui.eventually(async () => assert.equal((await ui.rows()).length, 2));
        assert.ok(!fs.existsSync(marker), 'RepoDock ran a program named in a repo config');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },

  // Last on purpose: opening a repo reloads the window onto another folder, and every
  // scenario above assumes the window it was launched with.
  {
    id: 'open-repo',
    kind: 'normal',
    title: 'Clicking a repo opens it here; after the reload pins, folds, and the recent order hold',
    async run(ui, assert, P) {
      await ui.eventually(async () => assert.ok(await find(ui, 'dev-setup')));
      // folded now, to see whether the reload keeps it that way
      await ui.toggle('~/work');
      await ui.eventually(async () => assert.ok(!(await ui.labels()).includes('clients')));
      await (await ui.row('dev-setup')).click();
      await ui.eventually(async () => {
        assert.match(await ui.page.title(), /dev-setup/);
      }, 60_000);
      await ui.command('RepoDock: Focus on Repositories View');
      await ui.eventually(async () => {
        assert.deepEqual(
          (await ui.rows(P.pinned)).map((row) => [row.label, row.description]),
          PINNED,
        );
        // ~/work is still folded; everything above it is drawn as before
        const folded = FOLDER_TREE.slice(
          0,
          FOLDER_TREE.findIndex(([, label]) => label === '~/work') + 1,
        );
        await expectTree(ui, assert, folded, P.rest);
        assert.equal((await find(ui, '~/work')).expanded, 'false');
      }, 60_000);
      // the tooltip follows the window: dev-setup is open here now
      assert.match((await ui.tooltip('dev-setup', P.rest)).text, /dev-setup — open in this window/);
      await ui.dismiss();
      await ui.shot('open-repo');
      ui.setSettings({ 'repodock.layout': 'recent' });
      await ui.eventually(async () => {
        const [first, second] = await ui.rows(P.rest);
        assert.equal(first?.label, 'dev-setup');
        assert.match(first?.description ?? '', /^main ↑3 · (now|\dm)$/);
        // the window it came from was opened moments earlier, so it is next
        assert.equal(second?.label, 'storefront');
      }, 30_000);
    },
  },
];
