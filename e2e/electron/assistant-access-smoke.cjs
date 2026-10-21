// Run after npm run electron:build and npm run buildFrontend:prod:es6.
// Uses an isolated profile; quit any app using port 3876 before running.
// Optionally pass a packaged Electron executable as the first argument.
// For buffered desktop regressions, build Electron, serve the development app,
// then set BUFFER_REGRESSIONS=1 and E2E_BASE_URL=http://localhost:<port>.
// BUFFER_CASE optionally selects rest, dialog, undo or context cases.
// ELECTRON_EXECUTABLE_PATH selects an unpackaged Electron binary (e.g. on NixOS).
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sp-mcp-real-'));
const xdgDir = path.join(profile, 'xdg');
fs.mkdirSync(xdgDir);
let app;
let key;
let id;
const endpoint = 'http://127.0.0.1:3876/mcp';
async function rpc(method, params, headers = {}) {
  // Node fetch replaces Host; use HTTP directly to exercise the rebinding check.
  return new Promise((resolve, reject) => {
    const request = http.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          ...headers,
        },
        timeout: 60000,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(body) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('MCP request timed out')));
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
}
async function call(name, args = {}) {
  const reply = await rpc('tools/call', { name, arguments: args });
  assert.equal(reply.status, 200);
  assert.ok(reply.body.result, 'Expected tool result');
  return reply.body.result;
}
async function waitUntilReady() {
  // expect.poll stops at the first thrown error, and right after a launch or
  // reload the listener or renderer may not answer yet. Returning the message
  // keeps polling and shows the last error if it times out.
  await expect
    .poll(
      async () => {
        try {
          return (await call('get_status')).structuredContent.isReady;
        } catch (error) {
          return error.message;
        }
      },
      { timeout: 60000 },
    )
    .toBe(true);
}
async function launch() {
  app = await electron.launch({
    ...(process.env.ELECTRON_EXECUTABLE_PATH || process.argv[2]
      ? { executablePath: process.env.ELECTRON_EXECUTABLE_PATH || process.argv[2] }
      : {}),
    args: [
      ...(process.argv[2] ? [] : ['.']),
      ...(process.env.E2E_BASE_URL ? [`--custom-url=${process.env.E2E_BASE_URL}`] : []),
      `--user-data-dir=${profile}`,
      '--no-sandbox',
      '--disable-gpu',
    ],
    env: {
      ...process.env,
      NODE_ENV: 'PROD',
      SP_FORCE_LOCAL_REST_API: '0',
      // The single-instance lock is acquired before --user-data-dir is applied.
      XDG_CONFIG_HOME: xdgDir,
      XDG_CACHE_HOME: xdgDir,
      XDG_DATA_HOME: xdgDir,
    },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.ea?.getAssistantAccessState);
  await page.evaluate(() => {
    for (const key of [
      'SUP_ONBOARDING_PRESET_DONE',
      'SUP_ONBOARDING_HINTS_DONE',
      'SUP_IS_SHOW_TOUR',
      'SUP_EXAMPLE_TASKS_CREATED',
    ])
      localStorage.setItem(key, 'true');
  });
  return page;
}

// Focused desktop regressions: run against the development frontend so the
// existing E2E store reader is available. The clock drives the real tracking
// interval, buffer, effects, API handler and persistence (no mocked services).
async function bufferedTimeRegressions(page) {
  page.setDefaultTimeout(15000);
  await page.evaluate(() => window.ea.setLocalRestApiEnabled(true));
  await page.clock.install({ time: new Date('2026-10-21T12:00:00') });
  await page.reload();
  await waitUntilReady();
  await page.waitForFunction(() => !!window.__e2eTestHelpers?.store);
  const restToken = await page.evaluate(() => window.ea.getLocalRestApiToken());
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:3876${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${restToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(response.ok, `${method} ${route}: ${response.status}`);
    return (await response.json()).data;
  };
  const readState = () =>
    page.evaluate(() => {
      let state;
      window.__e2eTestHelpers.store.subscribe((value) => (state = value)).unsubscribe();
      return state;
    });
  const reloadReady = async () => {
    await page.clock.resume();
    await page.reload();
    await waitUntilReady();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  };
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const today = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  const yesterday = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  const seedBufferedTask = async (name, parentId) => {
    await api('POST', '/task-control/stop');
    assert.equal(
      (await api('GET', '/focus')).timer,
      null,
      'must track outside focus mode',
    );
    const task = await api('POST', '/tasks', {
      title: name,
      ...(parentId ? { parentId } : { dueDay: today }),
    });
    await api('PUT', `/tasks/${task.id}/time`, { date: today, duration: 60000 });
    await api('PUT', `/tasks/${task.id}/time`, { date: yesterday, duration: 120000 });
    // Align with the already-running global interval before starting the task.
    await page.clock.runFor(1000);
    await api('POST', `/tasks/${task.id}/start`);
    await page.clock.runFor(30000);
    const state = await readState();
    assert.equal(state.tasks.entities[task.id].timeSpentOnDay[today], 61000);
    assert.equal(state.taskTimeBuffer.taskId, task.id);
    assert.equal(state.taskTimeBuffer.duration, 29000);
    console.log(`PRECONDITION ${name}: today=61000, buffer=29000, exact=90000`);
    return task.id;
  };
  const assertTime = async (
    taskId,
    expectedYesterday = 120000,
    expectedToday = 90000,
  ) => {
    const task = await api('GET', `/tasks/${taskId}`);
    assert.equal(
      task.timeSpentOnDay[today],
      expectedToday,
      'unchanged today must retain buffered time',
    );
    assert.equal(task.timeSpentOnDay[yesterday] || 0, expectedYesterday);
    assert.equal(task.timeSpent, expectedToday + expectedYesterday);
  };
  const failures = [];
  for (const scenario of [
    'rest',
    'dialog-estimate',
    'dialog-other-day',
    'undo',
    'undo-child',
    'context-tag',
    'context-project',
    'context-suspend',
  ]) {
    if (process.env.BUFFER_CASE && !scenario.startsWith(process.env.BUFFER_CASE))
      continue;
    try {
      if (scenario.startsWith('context')) {
        await api('POST', '/task-control/stop');
        const base = new Date(`${today}T10:00:00`).getTime();
        await page.clock.setSystemTime(base + 25000);
        await page.clock.runFor(1000);
        const task = await api('POST', '/tasks', { title: scenario, dueDay: today });
        await api('PUT', `/tasks/${task.id}/time`, { date: today, duration: 120000 });
        await api('POST', `/tasks/${task.id}/start`);
        await page.clock.runFor(1000);
        await page.clock.setSystemTime(base + 28000);
        const kind = scenario === 'context-project' ? 'project' : 'tag';
        const contextId = `buffer-${scenario}`;
        await page.evaluate(
          ({ kind, id, taskId }) => {
            const store = window.__e2eTestHelpers.store;
            let s;
            store.subscribe((v) => (s = v)).unsubscribe();
            const entity = {
              ...(kind === 'tag'
                ? s.tag.entities.TODAY
                : s.projects.entities.INBOX_PROJECT),
              id,
              title: id,
              created: Date.now(),
              taskIds: [],
              ...(kind === 'project' ? { backlogTaskIds: [], noteIds: [] } : {}),
            };
            store.dispatch({
              type: kind === 'tag' ? '[Tag] Add Tag' : '[Project] Add Project',
              [kind]: entity,
              meta: {
                isPersistent: true,
                entityType: kind.toUpperCase(),
                entityId: id,
                opType: 'CRT',
              },
            });
            const meta = {
              isPersistent: true,
              entityType: 'TASK',
              entityId: taskId,
              opType: 'UPD',
            };
            store.dispatch(
              kind === 'tag'
                ? {
                    type: '[Task Shared] updateTask',
                    task: { id: taskId, changes: { tagIds: [id] } },
                    meta,
                  }
                : {
                    type: '[Task Shared] moveToOtherProject',
                    task: { ...s.tasks.entities[taskId], subTasks: [] },
                    targetProjectId: id,
                    meta,
                  },
            );
          },
          { kind, id: contextId, taskId: task.id },
        );
        await page.clock.runFor(2500);
        const before = await readState();
        assert.ok(before.taskTimeBuffer?.duration > 0, 'must stop with buffered ticks');
        const lastTick = await page.evaluate(
          () =>
            window.ng.getComponent(document.querySelector('app-root'))._taskService
              ._timeTrackingService._currentTrackingStart,
        );
        const expected = { s: base, e: Math.round(lastTick / 60000) * 60000 };
        await page.clock.setSystemTime(
          scenario === 'context-suspend' ? base + 86400000 : base + 31900,
        );
        await api('POST', '/task-control/stop');
        const actual = (await readState()).timeTracking[kind][contextId][today];
        console.log(
          `CONTEXT ${scenario}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`,
        );
        assert.deepEqual(actual, expected);
        await page.clock.resume();
        await page.evaluate(() => window.__e2eTestHelpers.flushPendingWrites());
        await reloadReady();
        assert.deepEqual(
          (await readState()).timeTracking[kind][contextId][today],
          expected,
        );
        console.log(`PASS buffered ${scenario}, including reload`);
        continue;
      }
      const parent = scenario.startsWith('undo')
        ? await api('POST', '/tasks', { title: 'Buffered undo parent', dueDay: today })
        : null;
      const taskId = await seedBufferedTask(`Buffered ${scenario}`, parent?.id);
      if (scenario === 'rest') {
        await api('PUT', `/tasks/${taskId}/time`, { date: yesterday, duration: 600000 });
        await assertTime(taskId, 600000);
      } else if (scenario.startsWith('dialog')) {
        const row = page
          .locator('task')
          .filter({ hasText: `Buffered ${scenario}` })
          .first();
        await row.locator('.time-wrapper').click({ force: true });
        const dialog = page.locator('dialog-time-estimate');
        await expect(dialog).toBeVisible();
        // Allow Angular's scheduled render/form registration while real tracking
        // continues. One further second must survive the edit too.
        await page.clock.runFor(1000);
        assert.equal(
          (await api('GET', '/status')).currentTask.timeSpentOnDay[today],
          91000,
        );
        if (scenario === 'dialog-estimate') {
          await dialog.locator('input-duration-slider input').nth(1).fill('15m');
        } else {
          await dialog.locator('.other-day input').first().fill('10m');
        }
        await dialog.locator('button[type="submit"]').click({ force: true });
        await assertTime(taskId, scenario === 'dialog-estimate' ? 120000 : 600000, 91000);
        assert.equal(
          (await api('GET', `/tasks/${taskId}`)).timeEstimate,
          scenario === 'dialog-estimate' ? 900000 : 0,
        );
      } else {
        const deletedId = scenario === 'undo-child' ? taskId : parent.id;
        await api('DELETE', `/tasks/${deletedId}`);
        const deletedState = await readState();
        assert.equal(deletedState.tasks.entities[taskId], undefined);
        if (scenario === 'undo-child') {
          console.log(
            `DELETE child: parent today=${deletedState.tasks.entities[parent.id].timeSpentOnDay[today]}`,
          );
          await assertTime(parent.id);
          assert.deepEqual(deletedState.tasks.entities[parent.id].subTaskIds, []);
        } else {
          assert.equal(deletedState.tasks.entities[parent.id], undefined);
        }
        await page.clock.resume();
        await page.evaluate(() => window.__e2eTestHelpers.flushPendingWrites());
        await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
        const capturedTask = await page.evaluate(async (deletedId) => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('SUP_OPS');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            const entries = await new Promise((resolve, reject) => {
              const request = db.transaction('ops').objectStore('ops').getAll();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            const op = entries
              .map((entry) => entry.op)
              .findLast(
                (op) =>
                  (op.o ?? op.opType) === 'DEL' && (op.d ?? op.entityId) === deletedId,
              );
            return (op.p ?? op.payload).actionPayload.task;
          } finally {
            db.close();
          }
        }, deletedId);
        const capturedChild =
          scenario === 'undo-child'
            ? capturedTask
            : capturedTask.subTasks.find((task) => task.id === taskId);
        console.log(
          `CAPTURE ${scenario}: today=${capturedChild.timeSpentOnDay[today]}, yesterday=${capturedChild.timeSpentOnDay[yesterday]}`,
        );
        assert.equal(capturedChild.timeSpentOnDay[today], 90000);
        assert.equal(capturedChild.timeSpentOnDay[yesterday], 120000);
        assert.equal(capturedChild.timeSpent, 210000);
        await page.clock.runFor(500);
        await page.locator('snack-custom button.action').click({ force: true });
        await assertTime(taskId);
        await assertTime(parent.id);
      }
      await api('POST', '/task-control/stop');
      await page.clock.resume();
      await page.evaluate(() => window.__e2eTestHelpers.flushPendingWrites());
      await reloadReady();
      await assertTime(
        taskId,
        scenario === 'rest' || scenario === 'dialog-other-day' ? 600000 : 120000,
        scenario.startsWith('dialog') ? 91000 : 90000,
      );
      if (parent) await assertTime(parent.id);
      console.log(`PASS buffered ${scenario}, including reload`);
    } catch (error) {
      failures.push(`${scenario}: ${error.stack}`);
      console.error(`FAIL buffered ${scenario}: ${error.message}`);
      await page.keyboard.press('Escape');
      await api('POST', '/task-control/stop');
      await page.clock.resume();
      await page.evaluate(() => window.__e2eTestHelpers.flushPendingWrites());
      await reloadReady();
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
}
(async () => {
  try {
    let page = await launch();
    assert.equal(
      (await page.evaluate(() => window.ea.getAssistantAccessState())).isEnabled,
      false,
    );
    assert.equal(
      (await page.evaluate(() => window.ea.setAssistantAccessEnabled(true))).isListening,
      true,
      'Temporary-profile listener did not bind',
    );
    key = (await page.evaluate(() => window.ea.rotateAssistantAccessCredential()))
      .credential;
    assert.equal(
      (
        await rpc('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'smoke', version: '1' },
        })
      ).status,
      200,
    );
    assert.equal((await rpc('ping', {}, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await rpc('ping', {}, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await rpc('ping', {}, { Host: 'example.com' })).status, 403);
    await page.evaluate(() =>
      window.ea.setAssistantAccessScopes(['tasks:read', 'tasks:capture']),
    );
    await waitUntilReady();
    if (process.env.BUFFER_REGRESSIONS === '1') {
      await bufferedTimeRegressions(page);
      return;
    }
    const created = await call('create_task', {
      title: 'MCP smoke #literal',
      notes: 'smoke note',
    });
    assert.equal(created.structuredContent?.status, 'created');
    id = created.structuredContent.id;
    const task = (await call('get_task', { id })).structuredContent.task;
    assert.equal(task.title, 'MCP smoke #literal');
    assert.equal(task.projectId, 'INBOX_PROJECT');
    assert.deepEqual(task.tagIds, []);
    assert.equal(task.notes, undefined);
    assert.equal((await call('get_task', { id, includeNotes: true })).isError, true);
    await page.evaluate(() =>
      window.ea.setAssistantAccessScopes([
        'tasks:read',
        'tasks:read_notes',
        'tasks:capture',
      ]),
    );
    assert.equal(
      (await call('get_task', { id, includeNotes: true })).structuredContent.task.notes,
      'smoke note',
    );
    await page.evaluate(() => window.ea.setLocalRestApiEnabled(true));
    await app.close();
    app = undefined;
    page = await launch();
    await waitUntilReady();
    assert.equal((await fetch('http://127.0.0.1:3876/health')).status, 200);
    assert.equal(
      (await call('get_task', { id })).structuredContent.task.title,
      'MCP smoke #literal',
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].minimize(),
    );
    assert.equal((await call('get_task', { id })).isError, undefined);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    assert.equal((await call('get_task', { id })).structuredContent.task.id, id);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    assert.equal((await call('get_task', { id })).structuredContent.task.id, id);
    await page.reload();
    await waitUntilReady();
    assert.equal((await call('get_task', { id })).structuredContent.task.id, id);
    await page.evaluate(() => window.ea.rotateAssistantAccessCredential());
    assert.equal((await rpc('ping', {})).status, 401);
    console.log(
      'PASS: real Electron capture, scopes, auth, persisted dual-switch startup, minimize, hide/show, reload and rotation',
    );
  } finally {
    if (app) await app.close();
    // Late Electron profile writes can cause transient ENOTEMPTY after exit
    // (#10296); async removal retries and picks up newly created files.
    await fs.promises.rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
