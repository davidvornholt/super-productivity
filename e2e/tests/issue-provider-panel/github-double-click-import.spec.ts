import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test.fixture';
import type { RootState } from '../../../src/app/root-store/root-state';
import type { Task } from '../../../src/app/features/tasks/task.model';

const state = (page: Page): Promise<RootState> =>
  page.evaluate(() => {
    const h = (
      window as unknown as {
        __e2eTestHelpers: {
          store: {
            subscribe: (fn: (s: RootState) => void) => { unsubscribe: () => void };
          };
        };
      }
    ).__e2eTestHelpers;
    let result!: RootState;
    h.store
      .subscribe((s) => {
        result = s;
      })
      .unsubscribe();
    return result;
  });
const linked = async (page: Page): Promise<Task[]> =>
  Object.values((await state(page)).tasks.entities).filter(
    (t): t is Task => !!t && t.issueId === '43',
  );
const flush = (page: Page): Promise<void> =>
  page.evaluate(() =>
    (
      window as unknown as {
        __e2eTestHelpers: { flushPendingWrites: () => Promise<void> };
      }
    ).__e2eTestHelpers.flushPendingWrites(),
  );

const setup = async (page: Page): Promise<void> => {
  await page.route('https://api.github.com/**', async (route) => {
    const issue = {
      id: 43,
      number: 43,
      title: 'Synthetic import issue',
      body: 'Synthetic remote body',
      state: 'open',
      html_url: 'https://github.com/e2e/import/issues/43',
      created_at: '2026-09-01T12:00:00Z',
      updated_at: '2026-09-01T12:00:00Z',
      comments: 0,
      labels: [],
    };
    await route.fulfill({
      json: route.request().url().includes('/search/issues') ? { items: [issue] } : issue,
    });
  });
  await page.locator('.e2e-toggle-issue-provider-panel').click();
  await page.locator('issue-panel .mat-mdc-tab').last().click();
  await page.getByRole('button', { name: 'GitHub Issues', exact: true }).click();
  const dialog = page.locator('dialog-edit-issue-provider');
  await dialog.locator('input[id*="repo"]').fill('e2e/import');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.locator('issue-panel .mat-mdc-tab').first().click();
  await page.locator('issue-provider-tab input[name="search"]').fill('Synthetic import');
  await expect(page.locator('issue-preview-item')).toHaveCount(1);
};

test('double-clicking an issue add button creates one linked task', async ({
  page,
  workViewPage,
}) => {
  await workViewPage.waitForTaskList();
  await setup(page);
  await page.locator('issue-preview-item').getByRole('button').first().dblclick();
  await expect.poll(async () => (await linked(page)).length).toBe(1);
  await flush(page);
  await page.reload();
  await workViewPage.waitForTaskList();
  expect((await linked(page)).length).toBe(1);
});
