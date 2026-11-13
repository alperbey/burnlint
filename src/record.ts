// Local OTLP/HTTP receiver. Appends every trace export it receives to a JSONL
// file, one ExportTraceServiceRequest per line, which is what `burnlint audit`
// reads.
//
// - Loopback only. Nothing is forwarded anywhere.
// - JSON encoding only. Protobuf trace exports are refused with 415 so the
//   sending SDK reports the failure instead of losing spans silently.
// - Only traces are kept. Log and metric exports are acknowledged and
//   dropped, so an agent that exports all three signals doesn't log errors.
// - Request bodies are written as received (minus line breaks), not
//   re-serialized, so 64-bit values sent as JSON numbers keep their digits.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { looksLikeOtlp } from "./adapters/otlp.js";

export const DEFAULT_PORT = 4318;
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SIGNAL_PATHS: Record<string, "traces" | "logs" | "metrics"> = {
  "/v1/traces": "traces",
  "/v1/logs": "logs",
  "/v1/metrics": "metrics",
};

export interface RecordOptions {
  /** JSONL file to append to. Created on the first span, mode 0600. */
  file: string;
  /** Default 4318. 0 picks a free port. */
  port?: number;
  /** Status lines for the person running the recorder. Never span content. */
  log?: (line: string) => void;
  /** Log one line per trace export. */
  verbose?: boolean;
}

export interface RecordStats {
  /** Trace exports written to the file. */
  requests: number;
  spans: number;
  /** Trace exports refused because they were protobuf-encoded. */
  protobufRefused: number;
  /** Trace exports refused as unreadable (bad JSON, bad encoding, too large). */
  invalid: number;
  /** Log and metric exports acknowledged and dropped. */
  logsDropped: number;
  metricsDropped: number;
}

export interface Recorder {
  port: number;
  file: string;
  stats: RecordStats;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function defaultRecordFile(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `burnlint-${stamp}Z.jsonl`;
}

/**
 * Checks the target before the server starts, so a bad path fails up front
 * and not on the first export. Returns true if a newline has to be written
 * before the first appended line.
 */
function prepareFile(file: string): boolean {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    return false;
  }
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (st.size === 0) return false;

  const fd = openSync(file, "r");
  try {
    const headBuf = Buffer.alloc(Math.min(st.size, 20000));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    if (!looksLikeOtlp(headBuf.toString("utf8")))
      throw new Error(`${file} exists and is not an OTLP trace file; not appending to it`);
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, st.size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // Keep draining so the response can be sent, but stop buffering.
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(c);
    });
    req.on("end", () =>
      tooLarge ? reject(new HttpError(413, "request body too large")) : resolve(Buffer.concat(chunks)),
    );
    req.on("error", reject);
  });
}

function decodeBody(body: Buffer, encoding: string): Buffer {
  if (!encoding || encoding === "identity") return body;
  if (encoding !== "gzip") throw new HttpError(415, `unsupported content-encoding: ${encoding}`);
  try {
    return gunzipSync(body, { maxOutputLength: MAX_BODY_BYTES });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new HttpError(413, "request body too large");
    throw new HttpError(400, "request body is not valid gzip");
  }
}

function countSpans(text: string): number {
  let req: unknown;
  try {
    req = JSON.parse(text);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (typeof req !== "object" || req === null || Array.isArray(req))
    throw new HttpError(400, "expected an ExportTraceServiceRequest object");
  const resourceSpans = (req as { resourceSpans?: unknown }).resourceSpans;
  if (resourceSpans === undefined) return 0;
  if (!Array.isArray(resourceSpans)) throw new HttpError(400, "resourceSpans must be an array");
  let n = 0;
  for (const rs of resourceSpans) {
    const scopeSpans = (rs as { scopeSpans?: unknown } | null)?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      const spans = (ss as { spans?: unknown } | null)?.spans;
      if (Array.isArray(spans)) n += spans.length;
    }
  }
  return n;
}

/** google.rpc.Status with only `message` (field 2) set, protobuf-encoded. */
function protobufStatus(message: string): Buffer {
  const text = Buffer.from(message, "utf8");
  const len: number[] = [];
  for (let n = text.length; ; n >>>= 7) {
    if (n < 0x80) {
      len.push(n);
      break;
    }
    len.push((n & 0x7f) | 0x80);
  }
  return Buffer.concat([Buffer.from([0x12, ...len]), text]);
}

// OTLP/HTTP: responses use the encoding of the request, and error bodies are
// a Status message.
function send(res: ServerResponse, status: number, protobuf: boolean, message?: string): void {
  const body = protobuf
    ? message === undefined
      ? Buffer.alloc(0)
      : protobufStatus(message)
    : Buffer.from(message === undefined ? "{}" : JSON.stringify({ message }));
  res.writeHead(status, {
    "content-type": protobuf ? "application/x-protobuf" : "application/json",
    "content-length": body.length,
  });
  res.end(body);
}

export const PROTOBUF_HINT =
  "burnlint record reads OTLP/JSON only; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json on the agent";

export async function startRecorder(opts: RecordOptions): Promise<Recorder> {
  const { file, verbose = false } = opts;
  const log = opts.log ?? (() => {});
  let needsNewline = prepareFile(file);

  const stats: RecordStats = {
    requests: 0,
    spans: 0,
    protobufRefused: 0,
    invalid: 0,
    logsDropped: 0,
    metricsDropped: 0,
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    const protobuf = contentType.includes("protobuf");
    const path = (req.url ?? "").split("?")[0]!;
    const signal = SIGNAL_PATHS[path];

    if (!signal || req.method !== "POST") {
      req.resume();
      if (!signal) send(res, 404, protobuf, `no OTLP endpoint at ${path}; traces go to /v1/traces`);
      else send(res, 405, protobuf, "use POST");
      return;
    }

    if (signal !== "traces") {
      req.resume();
      if (signal === "logs") stats.logsDropped++;
      else stats.metricsDropped++;
      send(res, 200, protobuf);
      return;
    }

    if (protobuf) {
      req.resume();
      if (stats.protobufRefused++ === 0) log(`refused a protobuf trace export: ${PROTOBUF_HINT}`);
      send(res, 415, true, PROTOBUF_HINT);
      return;
    }

    try {
      // Also keeps web pages out: a cross-origin form or no-cors POST can't send this type.
      if (!/^application\/json\s*(;|$)/.test(contentType)) {
        req.resume();
        throw new HttpError(415, "content-type must be application/json");
      }
      const raw = await readBody(req);
      const text = decodeBody(raw, String(req.headers["content-encoding"] ?? "").toLowerCase()).toString("utf8");
      const spans = countSpans(text);
      if (spans > 0) {
        // Line breaks in valid JSON are only ever whitespace between tokens.
        const line = text.replace(/[\r\n]+/g, "");
        appendFileSync(file, (needsNewline ? "\n" : "") + line + "\n", { mode: 0o600 });
        needsNewline = false;
        if (stats.spans === 0) log(`receiving spans, writing to ${file}`);
        stats.requests++;
        stats.spans += spans;
      }
      if (verbose) log(`${spans} span(s)`);
      send(res, 200, false);
    } catch (e) {
      if (e instanceof HttpError) {
        stats.invalid++;
        if (verbose) log(`refused a trace export: ${e.message}`);
        send(res, e.status, false, e.message);
      } else {
        log(`failed to record a trace export: ${(e as Error).message}`);
        send(res, 500, false, "burnlint record could not write the trace file");
      }
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      const port = opts.port ?? DEFAULT_PORT;
      reject(
        e.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use (another OTLP collector?); pick another with --port`)
          : e,
      );
    });
    server.listen(opts.port ?? DEFAULT_PORT, HOST, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        file,
        stats,
        // Lets exports already in flight finish; cuts off stragglers after 2s.
        close: () =>
          new Promise<void>((done) => {
            const cutoff = setTimeout(() => server.closeAllConnections(), 2000);
            server.close(() => {
              clearTimeout(cutoff);
              done();
            });
          }),
      });
    });
  });
}
