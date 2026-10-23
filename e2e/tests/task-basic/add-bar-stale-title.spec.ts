import type { Store } from '@ngrx/store';
import type { Page } from '@playwright/test';
import type { RootState } from '../../../src/app/root-store/root-state';
import { expect, test } from '../../fixtures/test.fixture';
import { flushPendingWrites } from '../../utils/waits';

/**
 * The add-task bar parses the input after every change and keeps the cleaned
 * title of the last parse. The first `@date` of a page load waits for the lazy
 * date-parser chunk, so a submit can land before the parse of the current
 * input. The task must then get the current input, not the cleaned title of an
 * earlier draft.
 *
 * Run: npm run e2e:file e2e/tests/task-basic/add-bar-stale-title.spec.ts -- --retries=0
 */

const readTitles = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const store = (window as Window & { __e2eTestHelpers: { store: Store<RootState> } })
      .__e2eTestHelpers.store;
    let state: RootState | undefined;
    store.subscribe((value) => (state = value)).unsubscribe();
    return Object.values(state?.tasks.entities ?? {}).map((task) => task!.title);
  });

test('submitting while the date parser loads keeps the words typed last', async ({
  page,
  workViewPage,
}) => {
  await workViewPage.waitForTaskList();
  await page.locator('.tour-addBtn').click();
  const input = page.locator('add-task-bar.global .main-input');
  await input.fill('Cold parser base');
  // Let the parse of this first draft land, so the bar holds its cleaned title.
  await expect
    .poll(() =>
      input.evaluate((element) => {
        const ng = (
          window as Window & {
            ng: {
              getComponent(element: Element): {
                stateService: { state(): { cleanText: string | null } };
              };
            };
          }
        ).ng;
        return ng.getComponent(element.closest('add-task-bar')!).stateService.state()
          .cleanText;
      }),
    )
    .toBe('Cold parser base');

  // Slow down the lazy chunks requested from here on, as on a slow network.
  let delayedScripts = 0;
  await page.route(/\.js(?:\?|$)/, async (route) => {
    delayedScripts++;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  await input.fill('Cold parser base @tomorrow suffix');
  await input.press('Enter');

  // Short syntax still applies once the parser has loaded; removing
  // `@tomorrow` leaves both spaces around it.
  await expect
    .poll(() => readTitles(page), { timeout: 5000 })
    .toEqual(['Cold parser base  suffix']);
  expect(delayedScripts).toBeGreaterThan(0);
  await flushPendingWrites(page);
  await page.reload();
  await workViewPage.waitForTaskList();
  await expect
    .poll(() => readTitles(page), { timeout: 5000 })
    .toEqual(['Cold parser base  suffix']);
});

test('submitting a menu repeat while the date parser loads keeps its template clean', async ({
  page,
  workViewPage,
}) => {
  // Keep the first occurrence in the future so overdue cleanup cannot move it.
  const dueDay = `${new Date().getFullYear() + 1}-12-01`;
  await workViewPage.waitForTaskList();
  await page.locator('.tour-addBtn').click();
  const input = page.locator('add-task-bar.global .main-input');
  await input.fill('Draft');
  const readCleanText = (): Promise<string | null> =>
    input.evaluate((element) => {
      const ng = (
        window as Window & {
          ng: {
            getComponent(element: Element): {
              stateService: { state(): { cleanText: string | null } };
            };
          };
        }
      ).ng;
      return ng.getComponent(element.closest('add-task-bar')!).stateService.state()
        .cleanText;
    });
  await expect.poll(readCleanText).toBe('Draft');
  await page.locator('[data-test="add-task-bar-repeat-btn"]').click();
  await page.getByRole('menuitem', { name: 'Every day', exact: true }).click();
  await expect(input).toBeFocused();

  // Hold the real lazy parser chunk until after Enter, so the race cannot
  // disappear on a faster machine. No parser result is stubbed.
  let releaseParser!: () => void;
  const parserGate = new Promise<void>((resolve) => (releaseParser = resolve));
  let heldScripts = 0;
  await page.route(/\.js(?:\?|$)/, async (route) => {
    heldScripts++;
    await parserGate;
    await route.continue();
  });
  try {
    await input.fill(`Draft @${dueDay} suffix`);
    await expect.poll(() => heldScripts).toBeGreaterThan(0);
    expect(await readCleanText()).toBe('Draft');
    await input.press('Enter');
  } finally {
    releaseParser();
  }

  const readRepeat = (): Promise<{
    title?: string;
    dueDay?: string;
    templateTitle?: string;
    startDate?: string;
  }> =>
    page.evaluate(() => {
      type RepeatState = RootState & {
        taskRepeatCfg: {
          entities: Record<string, { title: string; startDate: string }>;
        };
      };
      const store = (
        window as Window & { __e2eTestHelpers: { store: Store<RepeatState> } }
      ).__e2eTestHelpers.store;
      let state: RepeatState | undefined;
      store.subscribe((value) => (state = value)).unsubscribe();
      const task = Object.values(state?.tasks.entities ?? {})[0];
      const cfg = task?.repeatCfgId
        ? state?.taskRepeatCfg.entities[task.repeatCfgId]
        : undefined;
      return {
        title: task?.title,
        dueDay: task?.dueDay,
        templateTitle: cfg?.title,
        startDate: cfg?.startDate,
      };
    });
  const expected = {
    title: 'Draft  suffix',
    dueDay,
    templateTitle: 'Draft  suffix',
    startDate: dueDay,
  };
  await expect.poll(readRepeat).toEqual(expected);
  await flushPendingWrites(page);
  await page.reload();
  await workViewPage.waitForTaskList();
  await expect.poll(readRepeat).toEqual(expected);
});
