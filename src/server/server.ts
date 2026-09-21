import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TimingService } from './service.js';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { loadFixtureBundle } from '../core/fixtures/load.js';

export interface ServeOptions {
  host: string;
  port: number;
  dbPath: string;
  publicDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface RunningServer {
  server: Server;
  service: TimingService;
  url: string;
  close: () => Promise<void>;
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const db = openDatabase(options.dbPath);
  const fixture = loadFixtureBundle();
  const repository = new Repository(db);
  const service = new TimingService(fixture, repository);
  service.initializeFromPersistence();

  const rootDir = dirname(fileURLToPath(new URL(import.meta.url)));
  const publicDir = options.publicDir ?? join(rootDir, '..', '..', 'web');
  const clientEntry = join(publicDir, 'app.ts');
  const bundleResult = await build({
    entryPoints: [clientEntry],
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    minify: false,
    write: false,
    sourcemap: 'inline',
    logLevel: 'silent',
  });
  const clientJs = bundleResult.outputFiles[0]?.text ?? '';

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url, service);
      return;
    }
    await serveStatic(url.pathname, res, publicDir, clientJs);
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : options.port;
  const actualHost = options.host === '0.0.0.0' ? '127.0.0.1' : options.host;

  return {
    server,
    service,
    url: `http://${actualHost}:${actualPort}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
    },
  };
}

async function serveStatic(
  pathname: string,
  res: ServerResponse,
  publicDir: string,
  clientJs: string,
): Promise<void> {
  if (pathname === '/app.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    res.end(clientJs);
    return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
  });
  createReadStream(filePath).pipe(res);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: TimingService,
): Promise<void> {
  const route = url.pathname.slice('/api/'.length);
  const method = req.method ?? 'GET';

  if (method === 'GET' && route === 'state') {
    sendJson(res, 200, service.snapshot());
    return;
  }
  if (method === 'GET' && route === 'export') {
    sendJson(res, 200, service.exportRun());
    return;
  }
  if (method === 'POST' && route === 'import') {
    const body = await readJson(req);
    sendJson(res, 200, { ok: true, report: service.importRun(body) });
    return;
  }
  if (method === 'POST' && route === 'reset') {
    service.seed();
    sendJson(res, 200, { ok: true, state: service.snapshot() });
    return;
  }
  if (method === 'POST' && route === 'switch-version') {
    const body = (await readJson(req)) as { versionId: string };
    service.switchVersion(body.versionId);
    sendJson(res, 200, { ok: true, state: service.snapshot() });
    return;
  }
  if (method === 'POST' && route === 'branches') {
    const body = (await readJson(req)) as {
      label: string;
      fromBranchId: string | null;
      gapOffsets?: Record<string, number>;
      note?: string;
    };
    const branch = service.createBranch(body);
    sendJson(res, 200, { ok: true, branch, state: service.snapshot() });
    return;
  }
  if (method === 'POST' && route === 'branches/adjust-offset') {
    const body = (await readJson(req)) as {
      branchId: string;
      gapIndex: number;
      delta: number;
    };
    service.adjustGapOffset(body.branchId, body.gapIndex, body.delta);
    sendJson(res, 200, { ok: true, state: service.snapshot() });
    return;
  }
  if (method === 'POST' && route === 'branches/exclude') {
    const body = (await readJson(req)) as {
      branchId: string;
      toaCode: string;
      excluded: boolean;
    };
    service.setExcluded(body.branchId, body.toaCode, body.excluded);
    sendJson(res, 200, { ok: true, state: service.snapshot() });
    return;
  }
  if (method === 'POST' && route === 'branches/clock-event') {
    const body = (await readJson(req)) as {
      branchId: string;
      atNs: string;
      jumpNs: string;
      label?: string;
    };
    service.addClockEvent({
      branchId: body.branchId,
      atNs: BigInt(body.atNs),
      jumpNs: BigInt(body.jumpNs),
      label: body.label ?? '时钟跳变',
    });
    sendJson(res, 200, { ok: true, state: service.snapshot() });
    return;
  }
  if (method === 'POST' && route === 'branches/remove-clock-event') {
    const body = (await readJson(req)) as { branchId: string; seq: number };
    service.removeClockEvent(body.branchId, body.seq);
    sendJson(res, 200, { ok: true, state: service.snapshot() });
    return;
  }
  if (method === 'POST' && route === 'refit') {
    service.refit();
    sendJson(res, 200, { ok: true, state: service.snapshot() });
    return;
  }
  if (method === 'POST' && route === 'compare') {
    const body = (await readJson(req)) as { branchIdA: string; branchIdB: string };
    sendJson(res, 200, { ok: true, comparison: service.compare(body.branchIdA, body.branchIdB) });
    return;
  }
  sendJson(res, 404, { error: `未知 API: ${method} ${route}` });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': MIME['.json'] });
  res.end(JSON.stringify(value, bigIntReplacer));
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}
