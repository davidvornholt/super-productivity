import { _electron, expect, test, ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Backup {
  data: {
    task: {
      ids: string[];
      entities: Record<
        string,
        { timeSpent: number; timeSpentOnDay: Record<string, number> }
      >;
    };
  };
}

const exportBackup = async (
  app: ElectronApplication,
  page: Page,
  directory: string,
): Promise<Backup> => {
  await page.evaluate(() => (location.hash = '/config'));
  await page
    .locator('mat-tab-header [role=tab]')
    .filter({ hasText: 'cloud_sync' })
    .click();
  const section = page.locator('collapsible').filter({ hasText: 'Import/Export' });
  const exportButton = section.getByRole('button', { name: 'Export Data', exact: true });
  if (!(await exportButton.isVisible())) {
    await section.locator('.collapsible-header').click();
  }
  const file = path.join(directory, `export-${Date.now()}.json`);
  await app.evaluate(({ session }, target) => {
    session.defaultSession.once('will-download', (_event, item) =>
      item.setSavePath(target),
    );
  }, file);
  await exportButton.click();
  await expect
    .poll(() =>
      readFile(file, 'utf8')
        .then(JSON.parse)
        .catch(() => null),
    )
    .not.toBeNull();
  return JSON.parse(await readFile(file, 'utf8')) as Backup;
};

test('resume before the next tracking tick preserves work recorded before sleep', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sp-electron-resume-'));
  const profile = path.join(directory, 'profile');
  let app: ElectronApplication | undefined;
  const launch = async (): Promise<Page> => {
    app = await _electron.launch({
      executablePath: process.env.ELECTRON_PATH,
      args: [
        path.resolve(__dirname, '../..'),
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--ozone-platform=x11',
      ],
      env: { ...process.env, NODE_ENV: 'PROD', LIBGL_ALWAYS_SOFTWARE: '1' },
    });
    const page = await app.firstWindow();
    page.on('dialog', (dialog) => void dialog.accept());
    return page;
  };
  const quit = async (): Promise<void> => {
    const closingApp = app!;
    const closed = closingApp.waitForEvent('close');
    await closingApp.evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0);
    });
    await closed;
    app = undefined;
  };

  try {
    let page = await launch();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      for (const key of [
        'SUP_ONBOARDING_PRESET_DONE',
        'SUP_ONBOARDING_HINTS_DONE',
        'SUP_IS_SHOW_TOUR',
        'SUP_EXAMPLE_TASKS_CREATED',
      ]) {
        localStorage.setItem(key, 'true');
      }
    });
    await page.reload();
    await page.locator('task-list').first().waitFor();
    await expect(page.locator('.loading-full-page-wrapper')).not.toBeVisible();
    const input = page.locator('add-task-bar.global .main-input');
    if (!(await input.isVisible())) await page.locator('.tour-addBtn').click();
    await input.fill('Synthetic resume regression');
    await page.locator('.e2e-add-task-submit').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('task')).toHaveCount(1);
    const backup = await exportBackup(app!, page, directory);
    const id = backup.data.task.ids[0];
    const today = await page.evaluate(() => new Date().toLocaleDateString('en-CA'));
    const previousWork = 2 * 60 * 60 * 1000;
    backup.data.task.entities[id].timeSpent = previousWork;
    backup.data.task.entities[id].timeSpentOnDay = { [today]: previousWork };
    const seed = path.join(directory, 'seed.json');
    await writeFile(seed, JSON.stringify(backup));
    const imported = page.waitForEvent('console', {
      predicate: (message) => message.text().includes('Load(import) all data'),
    });
    await page.locator('file-imex input[type=file]').setInputFiles(seed);
    await imported;
    await expect(page.locator('.loading-full-page-wrapper')).not.toBeVisible();
    await page.evaluate(() => (location.hash = '/tag/TODAY/tasks'));
    const task = page.locator(`[data-task-id="${id}"]`);
    await task.hover();
    await task.locator('.start-task-btn').click();
    await expect(task).toHaveClass(/isCurrent/);
    // Let ordinary second ticks establish active tracking before the sleep gap.
    await page.waitForTimeout(1500);

    // Exercise the real main-process power listeners and renderer IPC, not a
    // mocked idle service. Only this app's clocks move; the host never suspends.
    await app!.evaluate(async ({ powerMonitor, BrowserWindow }) => {
      powerMonitor.emit('suspend');
      const originalNow = Date.now;
      const sleepMs = 10 * 60 * 1000;
      Date.now = () => originalNow() + sleepMs;
      try {
        await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`
          window.__resumeOriginalDate = Date;
          const OriginalDate = Date;
          window.Date = class extends OriginalDate {
            constructor(...args) {
              super(...(args.length ? args : [OriginalDate.now() + ${sleepMs}]));
            }
            static now() { return OriginalDate.now() + ${sleepMs}; }
          };
          void 0;
        `);
        powerMonitor.emit('resume');
      } finally {
        Date.now = originalNow;
      }
    });
    const idleDialog = page.locator('dialog-idle');
    await idleDialog.waitFor();
    await idleDialog.getByRole('button', { name: /Don.t track/i }).click();
    await page.evaluate(() => {
      const testWindow = window as unknown as { __resumeOriginalDate: DateConstructor };
      window.Date = testWindow.__resumeOriginalDate;
    });
    const afterResume = await exportBackup(app!, page, directory);
    const after = afterResume.data.task.entities[id].timeSpent;
    expect(after).toBeGreaterThanOrEqual(previousWork);
    expect(after).toBeLessThan(previousWork + 15_000);

    await quit();
    page = await launch();
    await page.locator('task-list').first().waitFor();
    const restarted = await exportBackup(app!, page, directory);
    expect(restarted.data.task.entities[id].timeSpent).toBe(after);
    await quit();
  } finally {
    if (app) {
      await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  }
});
