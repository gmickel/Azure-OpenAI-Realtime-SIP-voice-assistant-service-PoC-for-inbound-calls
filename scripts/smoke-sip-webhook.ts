import { spawn } from 'node:child_process';
import http from 'node:http';
import { WebSocketServer } from 'ws';

type RecordedRequest = { url: string; method: string; body: unknown };
const recorded: RecordedRequest[] = [];

const webhookPort = Number(process.env.PORT ?? 8000);
const healthUrl = `http://127.0.0.1:${webhookPort}/healthz`;

function createMockServer(): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        const body = data ? JSON.parse(data) : {};
        recorded.push({
          url: req.url ?? '',
          method: req.method ?? 'GET',
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('mock server address unavailable');
      }

      const base = `http://127.0.0.1:${address.port}`;
      const wss = new WebSocketServer({ server });
      wss.on('connection', (socket) => {
        socket.on('message', () => {
          // Ignore test traffic.
        });
      });

      resolve({
        base,
        close: () =>
          new Promise<void>((res) => {
            wss.close(() => {
              server.close(() => res());
            });
          }),
      });
    });
  });
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

(async () => {
  const mock = await createMockServer();
  const env = {
    ...process.env,
    TEST_MODE: '1',
    OPENAI_BASE: mock.base,
    REALTIME_WS_BASE: `${mock.base.replace('http', 'ws')}/v1/realtime`,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'test-key',
    OPENAI_WEBHOOK_SECRET: process.env.OPENAI_WEBHOOK_SECRET || 'test-secret',
    SIP_TARGET_URI: process.env.SIP_TARGET_URI || 'tel:+41000000000',
    PORT: String(webhookPort),
    REALTIME_MODEL: process.env.REALTIME_MODEL || 'gpt-realtime',
    REALTIME_VOICE: process.env.REALTIME_VOICE || 'alloy',
  };

  const server = spawn(process.execPath, ['run', 'src/server.ts'], {
    env,
    stdio: 'pipe',
  });

  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForServerReady();

    const fakeEvent = {
      type: 'realtime.call.incoming',
      data: { call_id: 'call_test_123' },
    };

    const webhookRes = await fetch(
      `http://127.0.0.1:${webhookPort}/openai/webhook`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fakeEvent),
      }
    );

    invariant(webhookRes.status === 200, 'Webhook did not return 200');

    const accept = recorded.find((req) =>
      req.url?.includes('/v1/realtime/calls/call_test_123/accept')
    );
    invariant(accept, 'accept endpoint was not called');
    invariant(accept.method === 'POST', 'accept used wrong HTTP method');
    const acceptBody = accept.body as Record<string, unknown>;
    invariant(acceptBody.type === 'realtime', 'accept type invalid');
    invariant(
      typeof acceptBody.model === 'string',
      'model missing in accept body'
    );
    invariant(Array.isArray(acceptBody.tools), 'tools missing in accept body');

    await fetch(`${mock.base}/v1/realtime/calls/call_test_123/refer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_uri: 'tel:+41000000000' }),
    });

    const refer = recorded.find((req) =>
      req.url?.includes('/v1/realtime/calls/call_test_123/refer')
    );
    invariant(refer, 'refer endpoint was not called');
    const referBody = refer.body as Record<string, unknown>;
    invariant(
      referBody.target_uri === 'tel:+41000000000',
      'refer body mismatch'
    );

    console.log('SMOKE (server webhook) PASS');
  } finally {
    server.kill();
    await mock.close();
  }
})().catch((error) => {
  console.error('Smoke test failed', error);
  process.exit(1);
});

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
