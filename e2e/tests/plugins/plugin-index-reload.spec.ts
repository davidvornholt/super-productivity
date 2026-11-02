import type { Store } from '@ngrx/store';
import { expect, test } from '../../fixtures/test.fixture';
import { flushPendingWrites } from '../../utils/waits';
import {
  enablePluginWithVerification,
  waitForPluginManagementInit,
} from '../../helpers/plugin-test.helpers';

for (const plugin of [
  { id: 'yesterday-tasks', name: "Yesterday's Tasks" },
  { id: 'api-test-plugin', name: 'API Test Plugin' },
  { id: 'automations', name: 'Automations (experimental)' },
]) {
  test(`enabled ${plugin.id} opens after reloading its own route`, async ({
    page,
    workViewPage,
  }) => {
    await workViewPage.waitForTaskList();
    expect(await waitForPluginManagementInit(page)).toBe(true);
    expect(await enablePluginWithVerification(page, plugin.name, 15000)).toBe(true);
    await page.goto(`/#/plugins/${plugin.id}/index`);
    const frame = page.frameLocator('plugin-index iframe').locator('body');
    await expect(frame).toBeVisible();
    await flushPendingWrites(page);
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate((id) => {
          type State = { pluginMetadata: { id: string; isEnabled: boolean }[] };
          const helpers = (
            window as Window & { __e2eTestHelpers?: { store: Store<State> } }
          ).__e2eTestHelpers;
          if (!helpers) return false;
          let state: State | undefined;
          helpers.store.subscribe((value) => (state = value)).unsubscribe();
          return state?.pluginMetadata.find((entry) => entry.id === id)?.isEnabled;
        }, plugin.id),
      )
      .toBe(true);
    await expect(frame).toBeVisible();
  });
}
