import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.js';

test('health endpoint returns OK', async () => {
  const app = createApp({
    openaiClient: { apiKey: 'test-key' },
  });

  const server = app.listen(0);
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('429 quota error returns a clear user-facing message', async () => {
  const app = createApp({
    openaiClient: {
      apiKey: 'test-key',
      chat: {
        completions: {
          create: async () => {
            const err = new Error('You have no credits remaining.');
            err.status = 429;
            err.response = {
              data: {
                error: {
                  type: 'insufficient_quota',
                  message: 'You have no credits remaining.',
                },
              },
            };
            throw err;
          },
        },
      },
    },
  });

  const server = app.listen(0);
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'quota-test', message: 'Ahoj' }),
    });

    assert.equal(response.status, 429);
    const body = await response.json();
    assert.match(body.error, /kredity|credits|quota/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
