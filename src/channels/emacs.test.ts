import { execFileSync, execSync } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoisted — must appear before any imports of the modules they replace) ---

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: '/tmp/test-groups',
}));
vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../channels/channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));

// Stub out all filesystem calls so tests never touch disk.
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

import type { ChannelSetup } from './adapter.js';
import { EmacsBridgeChannel } from './emacs.js';

// ---------------------------------------------------------------------------
// Helpers

function createTestSetup(overrides?: Partial<ChannelSetup>): ChannelSetup {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
}

/** Make an HTTP request to the test server; returns status code and parsed body. */
async function req(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode!, data: raw });
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

/** Read the actual bound port after setup() (server listens on port 0). */
function boundPort(channel: EmacsBridgeChannel): number {
  return (((channel as any).server as http.Server).address() as AddressInfo).port;
}

// ---------------------------------------------------------------------------

describe('EmacsBridgeChannel', () => {
  let setup: ChannelSetup;
  let channel: EmacsBridgeChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    setup = createTestSetup();
    // Port 0 tells the OS to pick a free ephemeral port — no conflicts between test runs
    channel = new EmacsBridgeChannel(0, null);
  });

  afterEach(async () => {
    if (channel.isConnected()) await channel.teardown();
  });

  // -------------------------------------------------------------------------
  describe('setup / teardown / isConnected', () => {
    it('isConnected returns false before setup', () => {
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected returns true after setup', async () => {
      await channel.setup(setup);
      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected returns false after teardown', async () => {
      await channel.setup(setup);
      await channel.teardown();
      expect(channel.isConnected()).toBe(false);
    });

    it('teardown is a no-op when not connected', async () => {
      await expect(channel.teardown()).resolves.not.toThrow();
    });

    it('calls onMetadata on setup', async () => {
      await channel.setup(setup);
      expect(setup.onMetadata).toHaveBeenCalledWith('default', 'Emacs');
    });
  });

  // -------------------------------------------------------------------------
  describe('POST /api/message', () => {
    let port: number;

    beforeEach(async () => {
      await channel.setup(setup);
      port = boundPort(channel);
    });

    it('returns 200 with messageId and timestamp for valid text', async () => {
      const { status, data } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hello' }));
      expect(status).toBe(200);
      expect(data).toHaveProperty('messageId');
      expect(data).toHaveProperty('timestamp');
      expect(typeof data.timestamp).toBe('number');
    });

    it('calls setup.onInbound with correct structure', async () => {
      await req(port, 'POST', '/api/message', JSON.stringify({ text: 'ping' }));
      expect(setup.onInbound).toHaveBeenCalledWith(
        'default',
        null,
        expect.objectContaining({
          kind: 'chat',
          content: { text: 'ping' },
        }),
      );
    });

    it('returns 400 for empty text', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: '' }));
      expect(status).toBe(400);
    });

    it('returns 400 for whitespace-only text', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: '   ' }));
      expect(status).toBe(400);
    });

    it('returns 400 for invalid JSON', async () => {
      const { status } = await req(port, 'POST', '/api/message', 'not-json');
      expect(status).toBe(400);
    });

    it('returns 404 for unknown paths', async () => {
      const { status } = await req(port, 'POST', '/api/unknown', JSON.stringify({ text: 'hi' }));
      expect(status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('GET /api/messages', () => {
    let port: number;

    beforeEach(async () => {
      await channel.setup(setup);
      port = boundPort(channel);
    });

    it('returns empty messages array when nothing has been sent', async () => {
      const { status, data } = await req(port, 'GET', '/api/messages?since=0');
      expect(status).toBe(200);
      expect(data).toEqual({ messages: [] });
    });

    it('returns messages added via deliver', async () => {
      await channel.deliver('default', null, { kind: 'text', content: { text: 'hello back' } });
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].text).toBe('hello back');
    });

    it('filters out messages at or before the since timestamp', async () => {
      await channel.deliver('default', null, { kind: 'text', content: { text: 'old' } });
      const since = Date.now();
      await new Promise((r) => setTimeout(r, 2));
      await channel.deliver('default', null, { kind: 'text', content: { text: 'new' } });

      const { data } = await req(port, 'GET', `/api/messages?since=${since}`);
      expect(data.messages.map((m: any) => m.text)).not.toContain('old');
      expect(data.messages.map((m: any) => m.text)).toContain('new');
    });

    it('caps buffer at 200 messages, dropping the oldest', async () => {
      for (let i = 0; i < 201; i++) {
        await channel.deliver('default', null, { kind: 'text', content: { text: `msg-${i}` } });
      }
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect(data.messages).toHaveLength(200);
      expect(data.messages.map((m: any) => m.text)).not.toContain('msg-0');
      expect(data.messages.map((m: any) => m.text)).toContain('msg-1');
      expect(data.messages.map((m: any) => m.text)).toContain('msg-200');
    });
  });

  // -------------------------------------------------------------------------
  describe('deliver', () => {
    beforeEach(async () => {
      await channel.setup(setup);
    });

    it('pushes exact text to the buffer', async () => {
      await channel.deliver('default', null, { kind: 'text', content: { text: 'response text' } });
      const { data } = await req(boundPort(channel), 'GET', '/api/messages?since=0');
      expect(data.messages[0].text).toBe('response text');
    });

    it('attaches a numeric epoch-ms timestamp', async () => {
      const before = Date.now();
      await channel.deliver('default', null, { kind: 'text', content: { text: 'ts-check' } });
      const after = Date.now();
      const { data } = await req(boundPort(channel), 'GET', '/api/messages?since=0');
      expect(data.messages[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(data.messages[0].timestamp).toBeLessThanOrEqual(after);
    });

    it('ignores deliver for non-default platformId', async () => {
      await channel.deliver('other-platform', null, { kind: 'text', content: { text: 'ignored' } });
      const { data } = await req(boundPort(channel), 'GET', '/api/messages?since=0');
      expect(data.messages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('authentication', () => {
    let authChannel: EmacsBridgeChannel;
    let port: number;

    beforeEach(async () => {
      authChannel = new EmacsBridgeChannel(0, 'secret');
      await authChannel.setup(setup);
      port = boundPort(authChannel);
    });

    afterEach(async () => {
      if (authChannel.isConnected()) await authChannel.teardown();
    });

    it('rejects POST without Authorization header (401)', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }));
      expect(status).toBe(401);
    });

    it('rejects POST with wrong token (401)', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }), {
        Authorization: 'Bearer wrong',
      });
      expect(status).toBe(401);
    });

    it('accepts POST with correct Bearer token (200)', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }), {
        Authorization: 'Bearer secret',
      });
      expect(status).toBe(200);
    });

    it('rejects GET without Authorization header (401)', async () => {
      const { status } = await req(port, 'GET', '/api/messages?since=0');
      expect(status).toBe(401);
    });

    it('accepts GET with correct Bearer token (200)', async () => {
      const { status } = await req(port, 'GET', '/api/messages?since=0', undefined, { Authorization: 'Bearer secret' });
      expect(status).toBe(200);
    });

    it('channel without authToken ignores Authorization header entirely', async () => {
      const noAuthChannel = new EmacsBridgeChannel(0, null);
      await noAuthChannel.setup(setup);
      const noAuthPort = boundPort(noAuthChannel);
      try {
        const { status } = await req(noAuthPort, 'GET', '/api/messages?since=0');
        expect(status).toBe(200);
      } finally {
        await noAuthChannel.teardown();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// nanoclaw--md-to-org-regex (Emacs Lisp, tested via emacs --batch)

function emacsAvailable(): boolean {
  try {
    execSync('emacs --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function mdToOrg(input: string): string {
  const elFile = path.resolve('emacs/nanoclaw.el');
  const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return execFileSync(
    'emacs',
    ['--batch', '--load', elFile, '--eval', `(princ (nanoclaw--md-to-org-regex "${escaped}"))`],
    { encoding: 'utf8' },
  );
}

describe.skipIf(!emacsAvailable())('nanoclaw--md-to-org-regex', () => {
  it('converts bold **text** → *text*', () => {
    expect(mdToOrg('**hello**')).toBe('*hello*');
  });

  it('converts italic *text* → /text/', () => {
    expect(mdToOrg('*hello*')).toBe('/hello/');
  });

  it('handles bold before italic in the same string', () => {
    expect(mdToOrg('**bold** and *italic*')).toBe('*bold* and /italic/');
  });

  it('converts strikethrough ~~text~~ → +text+', () => {
    expect(mdToOrg('~~gone~~')).toBe('+gone+');
  });

  it('converts underline __text__ → _text_', () => {
    expect(mdToOrg('__under__')).toBe('_under_');
  });

  it('converts inline code `code` → ~code~', () => {
    expect(mdToOrg('`foo()`')).toBe('~foo()~');
  });

  it('converts fenced code block with language', () => {
    expect(mdToOrg('```typescript\nconst x = 1;\n```')).toBe('#+begin_src typescript\nconst x = 1;\n#+end_src');
  });

  it('converts fenced code block without language', () => {
    expect(mdToOrg('```\nhello\n```')).toBe('#+begin_src text\nhello\n#+end_src');
  });

  it('converts ## heading → ** heading', () => {
    expect(mdToOrg('## Section')).toBe('** Section');
  });

  it('converts ### heading → *** heading', () => {
    expect(mdToOrg('### Deep')).toBe('*** Deep');
  });

  it('leaves list items unchanged', () => {
    expect(mdToOrg('- item one')).toBe('- item one');
  });

  it('converts links [text](url) → [[url][text]]', () => {
    expect(mdToOrg('[NanoClaw](https://example.com)')).toBe('[[https://example.com][NanoClaw]]');
  });
});
