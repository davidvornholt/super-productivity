import type { Page } from '@playwright/test';
import type { Task } from '../../../src/app/features/tasks/task.model';
import { expect, test } from '../../fixtures/test.fixture';

const readTasks = (page: Page): Promise<Task[]> =>
  page.evaluate(() => {
    const helpers = (
      window as unknown as {
        __e2eTestHelpers: {
          store: {
            subscribe: (
              next: (s: { tasks: { entities: Record<string, Task> } }) => void,
            ) => {
              unsubscribe: () => void;
            };
          };
        };
      }
    ).__e2eTestHelpers;
    let result: Task[] = [];
    helpers.store
      .subscribe((s) => (result = Object.values(s.tasks.entities)))
      .unsubscribe();
    return result;
  });

const updateTask = (
  page: Page,
  taskId: string,
  taskChanges: Partial<Task>,
): Promise<void> =>
  page.evaluate(
    async ({ id, changes }) => {
      const helpers = (
        window as unknown as {
          __e2eTestHelpers: {
            store: { dispatch: (action: unknown) => void };
            flushPendingWrites: () => Promise<void>;
          };
        }
      ).__e2eTestHelpers;
      helpers.store.dispatch({
        type: '[Task Shared] updateTask',
        task: { id, changes },
        isIgnoreShortSyntax: true,
        meta: { isPersistent: true, entityType: 'TASK', entityId: id, opType: 'UPD' },
      });
      await helpers.flushPendingWrites();
    },
    { id: taskId, changes: taskChanges },
  );

const flush = (page: Page): Promise<void> =>
  page.evaluate(() =>
    (
      window as unknown as {
        __e2eTestHelpers: { flushPendingWrites: () => Promise<void> };
      }
    ).__e2eTestHelpers.flushPendingWrites(),
  );

const importGithubTask = async (page: Page): Promise<string> => {
  await page.locator('.e2e-toggle-issue-provider-panel').click();
  await page.locator('issue-panel .mat-mdc-tab').last().click();
  await page.getByRole('button', { name: 'GitHub Issues', exact: true }).click();
  const dialog = page.locator('dialog-edit-issue-provider');
  await dialog.locator('input[id*="repo"]').fill('e2e/audit');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.locator('issue-panel .mat-mdc-tab').first().click();
  await page.locator('issue-provider-tab input[name="search"]').fill('Audit issue');
  await page
    .locator('issue-preview-item', { hasText: 'Audit issue' })
    .getByRole('button')
    .first()
    .click();
  await page.locator('.e2e-toggle-issue-provider-panel').click();
  const task = page.locator('task', { hasText: '#42 Audit issue' });
  await expect(task).toBeVisible();
  return (await task.getAttribute('data-task-id'))!;
};

const refresh = async (page: Page, id: string): Promise<void> => {
  await page
    .locator(`task[data-task-id="${id}"]`)
    .first()
    .locator('task-title')
    .first()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Update issue data' }).click();
};

test.describe('GitHub refresh preserves local work', () => {
  test.setTimeout(90000);

  for (const status of [404, 410]) {
    test(`HTTP ${status} retains an untracked task with local notes and a subtask`, async ({
      page,
      workViewPage,
    }) => {
      await workViewPage.waitForTaskList();
      let missing = false;
      let missingRequests = 0;
      await page.route('https://api.github.com/**', async (route) => {
        if (missing && route.request().url().includes('/issues/42')) {
          missingRequests++;
          await route.fulfill({ status, json: { message: 'Not Found' } });
          return;
        }
        const issue = {
          id: 42,
          number: 42,
          title: 'Audit issue',
          body: 'Remote body',
          state: 'open',
          html_url: 'https://github.com/e2e/audit/issues/42',
          created_at: '2026-09-01T12:00:00Z',
          updated_at: '2026-09-01T12:00:00Z',
          comments: 0,
          labels: [],
        };
        await route.fulfill({
          json: route.request().url().includes('/search/issues')
            ? { items: [issue] }
            : issue,
        });
      });
      const id = await importGithubTask(page);
      await updateTask(page, id, {
        notes: 'Local investigation — 日本語',
        timeEstimate: 3600000,
      });
      await expect
        .poll(async () => (await readTasks(page)).find((t) => t.id === id)?.notes)
        .toBe('Local investigation — 日本語');
      await workViewPage.addSubTask(
        page.locator(`task[data-task-id="${id}"]`),
        'Local follow-up',
      );
      await flush(page);
      const before = await readTasks(page);
      expect(before).toHaveLength(2);
      const retainedContent = (tasks: Task[]): Partial<Task>[] =>
        tasks
          .map((t) => ({
            id: t.id,
            title: t.title,
            notes: t.notes,
            timeEstimate: t.timeEstimate,
            timeSpent: t.timeSpent,
            parentId: t.parentId,
            subTaskIds: t.subTaskIds,
            issueId: t.issueId,
            issueProviderId: t.issueProviderId,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
      const warning = page.locator('snack-custom .wrapper.warning');
      const warningText = `Remote issue was deleted. Delete linked task "${before.find((t) => t.id === id)!.title}"?`;
      const deleteButton = warning.getByRole('button', { name: 'Delete', exact: true });
      missing = true;
      await refresh(page, id);
      await expect.poll(() => missingRequests).toBeGreaterThan(0);
      // The rendered warning proves the adapter handled the HTTP rejection.
      await expect(warning.locator('.message')).toHaveText(warningText);
      await expect(deleteButton).toBeVisible();
      await warning.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await expect(warning).toBeHidden();
      expect(retainedContent(await readTasks(page))).toEqual(retainedContent(before));
      await flush(page);
      await page.reload();
      await workViewPage.waitForTaskList();
      await expect
        .poll(async () => retainedContent(await readTasks(page)))
        .toEqual(retainedContent(before));

      // Plugin registration can finish after task hydration on reload.
      await page.locator('.e2e-toggle-issue-provider-panel').click();
      await page.locator('issue-panel .mat-mdc-tab').last().click();
      await expect(
        page.getByRole('button', { name: 'GitHub Issues', exact: true }),
      ).toBeVisible();
      await page.locator('.e2e-toggle-issue-provider-panel').click();
      await refresh(page, id);
      await expect(warning.locator('.message')).toHaveText(warningText);
      await expect(deleteButton).toBeVisible();
      await deleteButton.click();
      await expect.poll(() => readTasks(page)).toEqual([]);
      for (const task of before) {
        await expect(page.locator(`task[data-task-id="${task.id}"]`)).toHaveCount(0);
      }
    });
  }
});
