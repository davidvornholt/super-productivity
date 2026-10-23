import type { Page } from '@playwright/test';
import type { Store } from '@ngrx/store';
import type { RootState } from '../../../src/app/root-store/root-state';
import { expect, test } from '../../fixtures/test.fixture';
import { flushPendingWrites } from '../../utils/waits';

const read = (page: Page): Promise<RootState> =>
  page.evaluate(() => {
    let state!: RootState;
    (
      window as Window & { __e2eTestHelpers: { store: Store<RootState> } }
    ).__e2eTestHelpers.store
      .subscribe((s) => (state = s))
      .unsubscribe();
    return state;
  });
const dispatch = (page: Page, action: Record<string, unknown>): Promise<void> =>
  page.evaluate((a) => {
    (
      window as Window & { __e2eTestHelpers: { store: Store<RootState> } }
    ).__e2eTestHelpers.store.dispatch(a as { type: string });
  }, action);
for (const timed of [false, true]) {
  for (const field of ['Deadline', 'Planned Date']) {
    test(`${field} Today filter uses the logical day before 04:00 (${timed ? 'timed' : 'all-day'})`, async ({
      page,
      workViewPage,
    }) => {
      await dispatch(page, {
        type: '[Global Config] Update Global Config Section',
        sectionKey: 'misc',
        sectionCfg: { startOfNextDay: 4, startOfNextDayTime: '04:00' },
        meta: {
          isPersistent: true,
          entityType: 'GLOBAL_CONFIG',
          entityId: 'misc',
          opType: 'UPD',
        },
      });
      await flushPendingWrites(page);
      await page.clock.setSystemTime(new Date('2030-06-17T02:30:00'));
      await page.reload();
      await workViewPage.waitForTaskList();
      await workViewPage.addTask('Synthetic logical filter');
      const task = Object.values((await read(page)).tasks.entities).find((t) =>
        t?.title.includes('Synthetic logical filter'),
      )!;
      await dispatch(page, {
        type: '[Task Shared] setDeadline',
        taskId: task.id,
        ...(timed
          ? { deadlineWithTime: new Date('2030-06-17T02:00:00').getTime() }
          : { deadlineDay: '2030-06-16' }),
        meta: {
          isPersistent: true,
          entityType: 'TASK',
          entityId: task.id,
          opType: 'UPD',
        },
      });
      if (timed) {
        await dispatch(page, {
          type: '[Task Shared] updateTask',
          task: {
            id: task.id,
            changes: {
              dueDay: null,
              dueWithTime: new Date('2030-06-17T02:00:00').getTime(),
            },
          },
          meta: {
            isPersistent: true,
            entityType: 'TASK',
            entityId: task.id,
            opType: 'UPD',
          },
        });
      }
      await flushPendingWrites(page);
      await page.goto('/#/project/INBOX_PROJECT/tasks');
      await workViewPage.waitForTaskList();
      const row = page.locator(`task[id="t-${task.id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toBeVisible();
      await page.locator('.task-filter-btn').click();
      await page.getByRole('menuitem', { name: /Filter By/ }).hover();
      await page.getByRole('menuitem', { name: field, exact: true }).hover();
      await page
        .locator('.cdk-overlay-container')
        .getByRole('menuitem', {
          name: field === 'Deadline' ? 'Deadline Today' : 'Today',
          exact: true,
        })
        .click();
      await expect(row).toBeVisible();
      await page.reload();
      await workViewPage.waitForTaskList();
      await expect(row).toBeVisible();
    });
  }
}
