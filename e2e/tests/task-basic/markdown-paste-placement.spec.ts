import { test, expect } from '../../fixtures/test.fixture';
import type { Page } from '@playwright/test';
import { flushPendingWrites, waitForAppReady } from '../../utils/waits';

interface TaskShape {
  id: string;
  title: string;
  parentId?: string;
  isDone: boolean;
  projectId: string;
  subTaskIds: string[];
}
interface RootShape {
  tasks: { entities: Record<string, TaskShape> };
  projects: { entities: Record<string, { taskIds: string[]; backlogTaskIds: string[] }> };
}
const state = (page: Page): Promise<RootShape> =>
  page.evaluate(() => {
    let result!: RootShape;
    (
      window as unknown as {
        __e2eTestHelpers: {
          store: {
            subscribe: (fn: (s: RootShape) => void) => { unsubscribe: () => void };
          };
        };
      }
    ).__e2eTestHelpers.store
      .subscribe((s) => (result = s))
      .unsubscribe();
    return result;
  });

for (const placement of ['top', 'bottom', 'backlog'] as const) {
  test(`Markdown paste respects add-bar ${placement} placement and keeps the family`, async ({
    page,
    projectPage,
    workViewPage,
  }) => {
    await projectPage.createAndGoToTestProject();
    const projectId = page.url().split('/project/')[1].split('/')[0];
    await workViewPage.addTask('Existing sentinel', true);
    const initial = await state(page);
    const sentinel = initial.projects.entities[projectId].taskIds[0];
    if (placement === 'backlog') {
      await page.evaluate((id) => {
        (
          window as unknown as {
            __e2eTestHelpers: { store: { dispatch: (a: unknown) => void } };
          }
        ).__e2eTestHelpers.store.dispatch({
          type: '[Project] Update Project',
          project: { id, changes: { isEnableBacklog: true } },
          meta: {
            isPersistent: true,
            entityType: 'PROJECT',
            entityId: id,
            opType: 'UPD',
          },
        });
      }, projectId);
      await page.locator('add-task-bar.global .switch-add-to-btn').click();
    }
    if (placement === 'bottom') {
      await page.locator('add-task-bar.global .switch-add-to-bot-btn').click();
    }
    const input = page.locator('add-task-bar.global .main-input');
    await input.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        'text/plain',
        '- Paste first\n  - Paste child\n- [x] Paste done first\n- Paste second\n- [x] Paste done second',
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    await page.locator('dialog-confirm button[e2e="confirmBtn"]').click();
    await expect
      .poll(
        async () =>
          Object.values((await state(page)).tasks.entities).filter((t) =>
            t.title.startsWith('Paste '),
          ).length,
      )
      .toBe(5);
    for (let reload = 0; reload < 2; reload++) {
      const current = await state(page);
      const taskByTitle = (title: string): TaskShape =>
        Object.values(current.tasks.entities).find((t) => t.title === title)!;
      const first = taskByTitle('Paste first');
      const second = taskByTitle('Paste second');
      const child = taskByTitle('Paste child');
      const project = current.projects.entities[projectId];
      expect.soft(first.subTaskIds).toEqual([child.id]);
      expect.soft(child.parentId).toBe(first.id);
      expect.soft(child.projectId).toBe(projectId);
      const pastedIds = [first.id, second.id];
      const unfinishedIds = (ids: string[]): string[] =>
        ids.filter((id) => !current.tasks.entities[id].isDone);
      const targetIds =
        placement === 'backlog' ? project.backlogTaskIds : project.taskIds;
      expect
        .soft(targetIds.filter((id) => current.tasks.entities[id].isDone))
        .toEqual([
          taskByTitle('Paste done first').id,
          taskByTitle('Paste done second').id,
        ]);
      expect
        .soft(unfinishedIds(project.taskIds))
        .toEqual(
          placement === 'backlog'
            ? [sentinel]
            : placement === 'top'
              ? [...pastedIds, sentinel]
              : [sentinel, ...pastedIds],
        );
      expect
        .soft(unfinishedIds(project.backlogTaskIds))
        .toEqual(placement === 'backlog' ? pastedIds : []);
      // Wait for real op-log persistence before reopening.
      await page.keyboard.press('Escape');
      await flushPendingWrites(page);
      await page.reload();
      await waitForAppReady(page);
    }
    // Today builds Done from all tasks, not the project's explicit order.
    await page.goto('/#/tag/TODAY/tasks');
    await waitForAppReady(page);
    await expect(page.locator('.tour-doneList task-title')).toHaveText([
      /Paste done first/,
      /Paste done second/,
    ]);
  });
}
