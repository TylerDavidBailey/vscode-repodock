#!/usr/bin/env node
// Runs the scenarios in scenarios.mjs against RepoDock, loaded from this checkout into a
// real VS Code and a real VSCodium. Writes screenshots, report.json, and report.md to
// <work dir>/out and exits non-zero when any scenario fails.
//
//   node run-scenarios.mjs [--editor vscode|vscodium|both] [--only id,id] [--list]

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { scenarios } from './scenarios.mjs';

// functions handed to page.evaluate run inside the editor window, where `document` exists
/* global document, getComputedStyle */

const REPO = path.resolve(import.meta.dirname, '../../../..');
const E2E_DIR = process.env.REPODOCK_E2E_DIR ?? '/tmp/repodock-e2e';
const HOME = path.join(E2E_DIR, 'home');
const OUT = path.join(E2E_DIR, 'out');
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

const EDITORS = {
  vscode: {
    label: 'VS Code',
    binary: path.join(E2E_DIR, 'editors/vscode', `VSCode-linux-${ARCH}`, 'code'),
  },
  vscodium: {
    label: 'VSCodium',
    binary: path.join(E2E_DIR, 'editors/vscodium/usr/share/codium/codium'),
  },
};

/** The repository the editor window opens on, which RepoDock marks as current. */
const CURRENT_REPO = 'projects/web/storefront';

/** Every scenario starts from these, plus whatever its own `settings` adds. */
const BASE_SETTINGS = {
  'repodock.directories': ['~/projects', '~/work'],
  'workbench.startupEditor': 'none',
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  // Linux can hand menus to the OS, where they exist in no DOM and no screenshot
  'window.titleBarStyle': 'custom',
  'window.commandCenter': false,
  'chat.commandCenter.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.tips.enabled': false,
  'extensions.ignoreRecommendations': true,
  'git.openRepositoryInParentFolders': 'never',
  // the folder dialog as an in-window prompt the scenarios can drive, not an OS window
  'files.simpleDialog.enable': true,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Pins and last-opened times written into the profile before launch, as fixture paths. */
const SEED = {
  pins: ['projects/services/payments-api', 'work/infrastructure'],
  openedAgo: {
    'projects/services/payments-api': 42 * MINUTE,
    'projects/services/user-service': 5 * HOUR,
    'work/clients/client-portal': DAY,
    'projects/web/admin-dashboard': 3 * DAY,
    'projects/tools/deploy-cli': 9 * DAY,
    'projects/dev-setup': 40 * DAY,
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { editor: 'both', only: undefined, list: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--list') args.list = true;
    else if (arg === '--editor') args.editor = argv[++index];
    else if (arg === '--only') args.only = argv[++index].split(',');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['vscode', 'vscodium', 'both'].includes(args.editor)) {
    throw new Error(`--editor must be vscode, vscodium, or both (got ${args.editor})`);
  }
  return args;
}

function loadPlaywright() {
  // require, not import: the cloud image installs Playwright globally and exposes it
  // through NODE_PATH, which ES module resolution ignores
  const require = createRequire(import.meta.url);
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require(name);
    } catch {
      // try the next package name
    }
  }
  throw new Error(
    'Playwright is not installed. Cloud sessions ship it; elsewhere run `npm install -g playwright-core`.',
  );
}

function checkPrerequisites(editorIds) {
  // The editor creates a unix socket inside its profile directory, and socket paths are
  // capped at 107 bytes. A longer work dir makes the editor exit right after launch with
  // nothing more than a warning in its log.
  if (path.join(E2E_DIR, 'profiles', 'vscodium').length > 80) {
    throw new Error(
      `The work dir ${E2E_DIR} is too long for the editor's IPC socket. ` +
        'Symlink a short path to it and set REPODOCK_E2E_DIR to that path.',
    );
  }
  for (const id of editorIds) {
    if (!fs.existsSync(EDITORS[id].binary)) {
      throw new Error(`${EDITORS[id].label} is not unpacked. Run install-editors.sh first.`);
    }
  }
  if (!fs.existsSync(path.join(HOME, '.repodock-fixtures'))) {
    throw new Error('Fixtures are missing. Run make-fixtures.sh first.');
  }
}

/**
 * Writes the extension's global state before the editor first opens the profile, so pins
 * and a spread of last-opened times exist without clicking through the UI to create them.
 * The editor keeps extension state in an SQLite table keyed by extension id.
 */
async function seedGlobalState(profile) {
  const { DatabaseSync } = await import('node:sqlite');
  const now = Date.now();
  const state = {
    'repodock.pins': SEED.pins.map((repo) => path.join(HOME, repo)),
    'repodock.recency': Object.fromEntries(
      Object.entries(SEED.openedAgo).map(([repo, ago]) => [path.join(HOME, repo), now - ago]),
    ),
  };
  const directory = path.join(profile, 'User', 'globalStorage');
  fs.mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, 'state.vscdb'));
  database.exec(
    'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)',
  );
  database
    .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    .run('tylerdavidbailey.repodock', JSON.stringify(state));
  database.close();
}

/**
 * The two parts of RepoDock's tree, as scenarios name them: the pinned repos above the
 * blank gap row, and the rest below it.
 */
export const PARTS = { pinned: 'pinned', rest: 'rest' };

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The helpers a scenario drives the editor with. Everything reads the live DOM. Helpers
 * that take a `part` look at the rows above or below the gap row, and default to the
 * whole tree.
 */
function createUi(page, editorId, profile) {
  const settingsFile = path.join(profile, 'User', 'settings.json');
  const view = '.part.sidebar';
  const rowSelector = `${view} .pane-body .monaco-list-row`;

  const ui = {
    page,
    editorId,
    /** Absolute path of a fixture, given its path below the fake home. */
    fixture: (relative) => path.join(HOME, relative),

    /** Replaces the user settings with the base settings plus `overrides`. */
    setSettings(overrides = {}) {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ ...BASE_SETTINGS, ...overrides }, null, 2));
    },

    /** What the extension itself last wrote to user settings. */
    readSettings: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),

    /**
     * Retries `check` until it stops throwing. Every assertion about the UI goes through
     * this: scans, git loads, and settings reloads all land asynchronously, so a single
     * read right after an action races them.
     */
    async eventually(check, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          return await check();
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await sleep(250);
        }
      }
    },

    /**
     * Every rendered row of the view, top to bottom, the gap row included. Only rows
     * scrolled into view exist. `index` is the row's position in the whole tree. `badge` is
     * the count at the right edge of the row and `color` the label's computed color: both
     * come from a file decoration, which VS Code draws with CSS rather than text.
     */
    tree: () =>
      page.evaluate((selector) => {
        const text = (row, part) => row.querySelector(part)?.textContent ?? '';
        return [...document.querySelectorAll(selector)]
          .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
          .map((row) => {
            const label = row.querySelector('.monaco-icon-label');
            const badge = label ? getComputedStyle(label, '::after').content : 'none';
            const icon = row.querySelector('.custom-view-tree-node-item-icon');
            const name = row.querySelector('.label-name');
            return {
              index: Number(row.dataset.index),
              label: text(row, '.label-name'),
              description: text(row, '.label-description'),
              level: Number(row.getAttribute('aria-level')),
              total: Number(row.getAttribute('aria-setsize')),
              selected: row.getAttribute('aria-selected') === 'true',
              expanded: row.getAttribute('aria-expanded'),
              badge: badge === 'none' ? '' : badge.replace(/^"|"$/g, ''),
              icon: /codicon-(?!colored)([\w-]+)/.exec(icon?.className ?? '')?.[1] ?? '',
              // any icon at all: a codicon, an image, or the file-icon theme's glyph, which
              // VS Code draws for a row that has a resourceUri and no icon of its own
              hasIcon:
                /(^|\s)(file|folder)-icon(\s|$)/.test(label?.className ?? '') ||
                /codicon-/.test(icon?.className ?? '') ||
                (icon !== null && getComputedStyle(icon).backgroundImage !== 'none'),
              // the color an icon is drawn in, which is how the open repo's dot stands out
              iconColor: icon ? getComputedStyle(icon).color : '',
              // a label highlight carries its own color, so read that when there is one
              color: name ? getComputedStyle(name.querySelector('.highlight') ?? name).color : '',
              // false when the name itself is cut off with an ellipsis
              isNameWhole: name ? name.scrollWidth <= name.clientWidth : true,
              top: row.getBoundingClientRect().top,
            };
          });
      }, rowSelector),

    /** The blank row between the pinned repos and the rest, or undefined when there is none. */
    gap: async () => (await ui.tree()).find((row) => row.level === 1 && row.label === ''),

    /**
     * The rows of one part of the tree, top to bottom, or every row without a `part`.
     * Without a gap row there is nothing to split on: every row counts as the rest, and
     * the pinned part is empty, which is right whenever something is left unpinned.
     */
    async rows(part) {
      const tree = await ui.tree();
      if (part === undefined) return tree;
      const gap = tree.findIndex((row) => row.level === 1 && row.label === '');
      if (part === PARTS.pinned) return gap === -1 ? [] : tree.slice(0, gap);
      return gap === -1 ? tree : tree.slice(gap + 1);
    },

    labels: async (part) => (await ui.rows(part)).map((row) => row.label),

    /**
     * One row, by its exact label. `nth` picks among rows sharing a label. Resolved against
     * the tree as it is now, so look a row up again after anything that adds or removes
     * rows above it.
     */
    async row(label, part, nth = 0) {
      const matches = (await ui.rows(part)).filter((row) => row.label === label);
      assert.ok(matches[nth], `no "${label}" row in ${part ?? 'the tree'}`);
      return page.locator(`${rowSelector}[data-index="${matches[nth].index}"]`);
    },

    /** Runs a command by its Command Palette title, the way a user would. */
    async command(title) {
      await page.keyboard.press('F1');
      const input = page.locator('.quick-input-widget input.input');
      await input.waitFor({ state: 'visible' });
      await input.fill(`>${title}`);
      await sleep(400);
      await page.keyboard.press('Enter');
      await sleep(400);
    },

    /** Hovers a row until its tooltip shows, and returns the tooltip's text and HTML. */
    async tooltip(label, part, nth) {
      const hover = page.locator('.monaco-hover:not(.hidden) .hover-contents').last();
      // a tooltip still showing for another row would be read in place of this one
      await page.mouse.move(1000, 600);
      await hover.waitFor({ state: 'hidden', timeout: 4_000 }).catch(() => undefined);
      // A row that is redrawn while the pointer rests on it drops its pending tooltip,
      // and rows are redrawn as each git result lands. Moving off and back on asks again.
      for (let attempt = 1; ; attempt++) {
        await (await ui.row(label, part, nth)).hover();
        try {
          await hover.waitFor({ state: 'visible', timeout: 4_000 });
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          await page.mouse.move(1000, 600);
          await sleep(500);
        }
      }
      return { text: await hover.innerText(), html: await hover.innerHTML() };
    },

    /** Right-clicks a row and returns the labels of its context menu, top to bottom. */
    async openContextMenu(label, part) {
      // an open menu covers the tree with a click shield, so a second right-click never lands
      if (await page.locator('.context-view .monaco-menu').isVisible()) await ui.dismiss();
      await (await ui.row(label, part)).click({ button: 'right' });
      const items = page.locator('.context-view .monaco-menu .action-item:not(.disabled)');
      await items.first().waitFor({ state: 'visible' });
      return (await items.locator('.action-label').allInnerTexts()).filter(Boolean);
    },

    /** Runs an item of the open context menu, matched by its exact label. */
    async chooseMenuItem(text) {
      // Hover then Enter, not a click: a menu ignores the mouse for a moment after it
      // opens, so that releasing the right button cannot pick an item by accident.
      await page
        .locator('.context-view .monaco-menu .action-label')
        .getByText(text, { exact: true })
        .hover();
      await page.keyboard.press('Enter');
      await sleep(300);
    },

    /** Hovers a row and returns the tooltips of the buttons that appear on it, left to right. */
    async rowButtons(label, part, nth) {
      const row = await ui.row(label, part, nth);
      await row.hover();
      await sleep(200);
      return row
        .locator('.actions a.action-label')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    },

    /** Clicks one of the buttons a row shows on hover, matched by its tooltip. */
    async clickRowButton(label, button, part, nth) {
      const row = await ui.row(label, part, nth);
      await row.hover();
      await row.locator(`.actions a.action-label[aria-label="${button}"]`).click();
      await sleep(300);
    },

    /**
     * Expands or collapses a row by its twistie, without triggering the row's click.
     * `recursive` holds Alt, which makes VS Code expand everything below the row too.
     */
    async toggle(label, part, { recursive = false } = {}) {
      await (
        await ui.row(label, part)
      )
        .locator('.monaco-tl-twistie')
        .click({ modifiers: recursive ? ['Alt'] : [] });
      await sleep(300);
    },

    /**
     * Tooltips of the buttons in the view's title bar, left to right. VS Code adds its own
     * overflow button after the ones the extension contributes.
     */
    titleButtons: () =>
      page.evaluate(
        (selector) =>
          [
            // a view alone in its container puts its buttons in the container's title; a
            // view sharing one keeps them in its own header. The Set covers a build that
            // renders both.
            ...new Set(
              [
                ...document.querySelectorAll(
                  `${selector} .title-actions a.action-label, ${selector} .pane-header a.action-label`,
                ),
              ].map((action) => action.getAttribute('aria-label') ?? ''),
            ),
          ].filter(Boolean),
        view,
      ),

    async clickTitleButton(button) {
      await page
        .locator(
          `${view} .title-actions a.action-label[aria-label="${button}"], ${view} .pane-header a.action-label[aria-label="${button}"]`,
        )
        .first()
        .click();
      await sleep(300);
    },

    /** Closes whatever menu, picker, or tooltip is open and parks the pointer off the tree. */
    async dismiss() {
      await page.keyboard.press('Escape');
      await page.mouse.move(1000, 600);
      await sleep(300);
    },

    /** Text and button labels of the welcome content the view shows while it has no rows. */
    async welcome() {
      const content = page.locator(`${view} .welcome-view-content`).first();
      if (!(await content.isVisible())) return { text: '', buttons: [] };
      return {
        text: await content.innerText(),
        buttons: await content.locator('.monaco-button').allInnerTexts(),
      };
    },

    notifications: () => page.locator('.notification-list-item-message').allInnerTexts(),

    /** Label and description of every row in the open quick pick. */
    quickPickItems: () =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row'),
        ].map((row) => ({
          label: (row.querySelector('.label-name')?.textContent ?? '').trim(),
          description: row.querySelector('.label-description')?.textContent ?? '',
        })),
      ),

    /** One row of the open quick pick, by its exact label. */
    quickPickRow: (label) =>
      page.locator('.quick-input-widget .quick-input-list .monaco-list-row').filter({
        has: page.locator('.label-name', { hasText: new RegExp(`^\\s*${escapeRegExp(label)}$`) }),
      }),

    /**
     * Saves a screenshot for the report, framed from the top of the sidebar down so the
     * window's title bar stays out of it. The default frame is the sidebar plus room for
     * a menu or tooltip beside it, `sidebarOnly` stops at the sidebar's right edge, and
     * `full` captures the whole window.
     */
    async shot(name, { full = false, sidebarOnly = false } = {}) {
      const file = path.join(OUT, editorId, `${name}.png`);
      const sidebar = await page.evaluate((selector) => {
        const activityBar = document.querySelector('.part.activitybar')?.getBoundingClientRect();
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box && activityBar
          ? { top: Math.min(box.top, activityBar.top), right: box.right, bottom: box.bottom }
          : undefined;
      }, view);
      const clip =
        full || !sidebar
          ? undefined
          : {
              x: 0,
              y: sidebar.top,
              width: sidebarOnly ? sidebar.right : 700,
              height: sidebar.bottom - sidebar.top,
            };
      await page.screenshot({ path: file, clip });
      return file;
    },
  };
  return ui;
}

async function launchEditor(playwright, editorId, profile) {
  const app = await playwright._electron.launch({
    executablePath: EDITORS[editorId].binary,
    args: [
      // cloud sessions run as root, and Chromium refuses to sandbox a root process
      '--no-sandbox',
      '--disable-gpu',
      // 2x, so the screenshots stay sharp when a person reads them in a PR
      '--force-device-scale-factor=2',
      `--user-data-dir=${profile}`,
      `--extensions-dir=${path.join(profile, 'extensions')}`,
      `--extensionDevelopmentPath=${REPO}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--disable-telemetry',
      '--disable-updates',
      path.join(HOME, CURRENT_REPO),
    ],
    // HOME moves "~" to the fixtures; the git variables keep the machine's own git
    // config (signing, hooks, aliases) from changing what `git status` reports
    env: { ...process.env, HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    timeout: 120_000,
  });
  const page = await app.firstWindow({ timeout: 120_000 });
  await page.waitForSelector('.monaco-workbench', { timeout: 120_000 });
  const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
  return { app, page, version };
}

async function runEditor(playwright, editorId, selected) {
  const profile = path.join(E2E_DIR, 'profiles', editorId);
  // a fresh profile per run: pins, recency, and settings from an earlier run would
  // otherwise decide what this one sees
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(path.join(OUT, editorId), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, editorId), { recursive: true });
  await seedGlobalState(profile);

  let ui = createUi(undefined, editorId, profile);
  ui.setSettings();
  const { app, page, version } = await launchEditor(playwright, editorId, profile);
  ui = createUi(page, editorId, profile);
  console.log(`\n${EDITORS[editorId].label} ${version}`);

  const results = [];
  try {
    await sleep(3000);
    await ui.command('RepoDock: Focus on Repositories View');
    await ui.eventually(async () => {
      assert.ok((await ui.tree()).length > 0, 'the RepoDock view never rendered a row');
    }, 60_000);

    for (const scenario of selected) {
      const started = Date.now();
      const result = { id: scenario.id, kind: scenario.kind, title: scenario.title };
      try {
        await ui.dismiss();
        ui.setSettings(scenario.settings);
        await scenario.run(ui, assert, PARTS);
        result.status = 'pass';
      } catch (error) {
        result.status = 'fail';
        result.error = error instanceof Error ? error.message : String(error);
        await ui.shot(`${scenario.id}-FAILED`, { full: true }).catch(() => undefined);
      }
      result.ms = Date.now() - started;
      console.log(
        `  ${result.status === 'pass' ? 'pass' : 'FAIL'}  ${scenario.id}` +
          (result.error ? `\n        ${result.error.split('\n')[0]}` : ''),
      );
      results.push(result);
    }
  } finally {
    await app.close().catch(() => undefined);
  }
  return { editor: EDITORS[editorId].label, version, results };
}

function writeReports(runs) {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(runs, null, 2));
  const mark = (run, id) => {
    const result = run.results.find((candidate) => candidate.id === id);
    return result ? (result.status === 'pass' ? 'pass' : '**FAIL**') : 'not run';
  };
  const ids = runs[0].results.map((result) => result.id);
  const lines = [
    `| Scenario | Kind | ${runs.map((run) => `${run.editor} ${run.version}`).join(' | ')} |`,
    `| --- | --- | ${runs.map(() => '---').join(' | ')} |`,
    ...ids.map((id) => {
      const { kind } = runs[0].results.find((result) => result.id === id);
      return `| \`${id}\` | ${kind} | ${runs.map((run) => mark(run, id)).join(' | ')} |`;
    }),
  ];
  const failures = runs.flatMap((run) =>
    run.results
      .filter((result) => result.status === 'fail')
      .map((result) => `- ${run.editor} \`${result.id}\`: ${result.error.split('\n')[0]}`),
  );
  if (failures.length > 0) lines.push('', 'Failures:', ...failures);
  fs.writeFileSync(path.join(OUT, 'report.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const scenario of scenarios) {
      console.log(`${scenario.id.padEnd(24)} ${scenario.kind.padEnd(7)} ${scenario.title}`);
    }
    return 0;
  }

  // The editors need a display. Cloud sessions have none, so the run restarts itself
  // under a virtual one, sized for a 1440x900 window at the 2x scale factor.
  if (!process.env.DISPLAY) {
    const rerun = spawnSync(
      'xvfb-run',
      ['-a', '-s', '-screen 0 2880x1800x24', process.execPath, ...process.argv.slice(1)],
      { stdio: 'inherit' },
    );
    return rerun.status ?? 1;
  }

  const editorIds = args.editor === 'both' ? ['vscode', 'vscodium'] : [args.editor];
  checkPrerequisites(editorIds);
  const selected = args.only
    ? scenarios.filter((scenario) => args.only.includes(scenario.id))
    : scenarios;
  if (selected.length === 0) throw new Error('no scenario matches --only');

  // always test the bundle built from the working tree, never a stale dist/
  execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'ignore' });

  const playwright = loadPlaywright();
  fs.mkdirSync(OUT, { recursive: true });
  const runs = [];
  for (const editorId of editorIds) {
    runs.push(await runEditor(playwright, editorId, selected));
  }
  writeReports(runs);

  const failed = runs.flatMap((run) => run.results).filter((result) => result.status === 'fail');
  console.log(`\n${failed.length === 0 ? 'All scenarios passed' : `${failed.length} failed`}.`);
  console.log(`Report and screenshots: ${OUT}`);
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
