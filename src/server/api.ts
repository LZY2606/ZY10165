/**
 * HTTP API（node:http，零运行时依赖）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as db from "./db.js";
import * as svc from "./service.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, code: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

export function createApp(d: DatabaseSync, publicDir: string): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path.startsWith("/api/")) {
        await handleApi(d, req, res, path, url);
        return;
      }
      // 静态资源
      let file = path === "/" ? "/index.html" : path;
      const full = normalize(join(publicDir, file));
      if (!full.startsWith(normalize(publicDir))) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const data = readFileSync(full);
      res.writeHead(200, {
        "content-type": MIME[extname(full)] ?? "application/octet-stream",
      });
      res.end(data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.writeHead(404).end("not found");
      } else {
        send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
  });
}

async function handleApi(
  d: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
) {
  const method = req.method ?? "GET";
  const body = method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};

  if (method === "GET" && path === "/api/state") {
    send(res, 200, svc.stateSnapshot(d));
    return;
  }
  if (method === "POST" && path === "/api/import-fixture") {
    const variant = body.variant === "no-tail" ? "no-tail" : "full";
    send(res, 200, svc.importFixture(d, variant));
    return;
  }
  if (method === "POST" && path === "/api/revert-tail") {
    const from = Number(body.fromVersion);
    send(res, 200, svc.revertTail(d, from));
    return;
  }
  if (method === "POST" && path === "/api/branches") {
    const params = body.params as Record<string, string> | undefined;
    send(
      res,
      200,
      svc.createBranch(
        d,
        String(body.name ?? "未命名分支"),
        Number(body.inputVersion),
        params
          ? {
              fNum: params.fNum !== undefined ? BigInt(params.fNum) : undefined,
              dNum: params.dNum !== undefined ? BigInt(params.dNum) : undefined,
              dmNum: params.dmNum !== undefined ? BigInt(params.dmNum) : undefined,
            }
          : undefined,
        body.copyFrom !== undefined ? Number(body.copyFrom) : undefined,
      ),
    );
    return;
  }
  const shiftMatch = path.match(/^\/api\/branches\/(\d+)\/shifts(?:\/(\d+))?$/);
  if (shiftMatch && method === "POST" && !shiftMatch[2]) {
    const branchId = Number(shiftMatch[1]);
    const id = db.addCycleShift(
      d,
      branchId,
      BigInt(String(body.boundaryTUs)),
      BigInt(String(body.delta)),
    );
    db.logRun(d, "add-shift", `branch=${branchId} boundary=${body.boundaryTUs} delta=${body.delta}`);
    send(res, 200, { shiftId: id });
    return;
  }
  if (shiftMatch && method === "DELETE" && shiftMatch[2]) {
    db.deleteCycleShift(d, Number(shiftMatch[2]));
    db.logRun(d, "delete-shift", `shift=${shiftMatch[2]}`);
    send(res, 200, { ok: true });
    return;
  }
  const exclMatch = path.match(/^\/api\/branches\/(\d+)\/exclusions$/);
  if (exclMatch && method === "POST") {
    const branchId = Number(exclMatch[1]);
    db.setExclusion(d, branchId, Number(body.toaId), Boolean(body.excluded));
    db.logRun(d, "set-exclusion", `branch=${branchId} toa=${body.toaId} excluded=${body.excluded}`);
    send(res, 200, { ok: true });
    return;
  }
  const detailMatch = path.match(/^\/api\/branches\/(\d+)\/detail$/);
  if (detailMatch && method === "GET") {
    send(res, 200, svc.getBranchDetail(d, Number(detailMatch[1])));
    return;
  }
  if (method === "POST" && path === "/api/clock-events") {
    const seq = db.nextClockSeq(d);
    const id = db.insertClockEvent(d, {
      seq,
      tUs: BigInt(String(body.tUs)),
      offsetUs: BigInt(String(body.offsetUs)),
      label: String(body.label ?? ""),
    });
    db.logRun(d, "add-clock-event", `seq=${seq} t=${body.tUs} offset=${body.offsetUs}`);
    send(res, 200, { id, seq });
    return;
  }
  if (method === "GET" && path === "/api/compare") {
    const a = Number(url.searchParams.get("a"));
    const b = Number(url.searchParams.get("b"));
    send(res, 200, { rows: svc.compareBranches(d, a, b) });
    return;
  }
  if (method === "GET" && path === "/api/export") {
    send(res, 200, db.exportAll(d));
    return;
  }
  if (method === "POST" && path === "/api/import-run") {
    db.importAll(d, body as unknown as db.ExportBundle);
    db.logRun(d, "import-run", "replayed export bundle");
    send(res, 200, { ok: true });
    return;
  }
  if (method === "POST" && path === "/api/reset") {
    db.resetDb(d);
    db.logRun(d, "reset", "database cleared");
    send(res, 200, { ok: true });
    return;
  }
  send(res, 404, { error: `unknown route: ${method} ${path}` });
}
