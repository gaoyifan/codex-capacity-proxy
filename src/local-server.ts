import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import {
  createSseRewriteStream,
  rewriteCapacityError,
} from "./rewrite.ts";

const CODEX_PATH_PREFIX = "/backend-api/codex";
const DEFAULT_UPSTREAM_ORIGIN = "https://chatgpt.com";

const REQUEST_HEADERS_TO_DROP = [
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
] as const;

const WEBSOCKET_HEADERS_TO_DROP = [
  "accept-encoding",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
] as const;

type LogEntry = Record<string, boolean | number | string>;

export type LocalProxyOptions = {
  upstreamOrigin?: string;
  log?: (entry: LogEntry) => void;
};

export function createLocalProxyServer(options: LocalProxyOptions = {}) {
  const upstreamOrigin = new URL(
    options.upstreamOrigin ?? DEFAULT_UPSTREAM_ORIGIN,
  );
  const log = options.log ?? (() => undefined);
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: true,
  });

  const server = createServer((request, response) => {
    void handleHttp(request, response, upstreamOrigin, log).catch((error) => {
      log({
        event: "proxy.error",
        message: errorMessage(error),
        transport: "http",
      });
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(`Upstream request failed: ${errorMessage(error)}\n`);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    handleWebSocket(
      request,
      socket,
      head,
      upstreamOrigin,
      webSocketServer,
      log,
    );
  });

  return server;
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamOrigin: URL,
  log: (entry: LogEntry) => void,
): Promise<void> {
  const requestUrl = incomingUrl(request);
  if (requestUrl.pathname === "/") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("codex-capacity-proxy local\n");
    return;
  }
  if (!isCodexPath(requestUrl.pathname)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  const method = request.method ?? "GET";
  log({ event: "proxy.request", method, path: requestUrl.pathname, transport: "http" });

  const abortController = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  });

  const init: RequestInit & { duplex?: "half" } = {
    headers: buildUpstreamHeaders(request, false),
    method,
    redirect: "manual",
    signal: abortController.signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  const upstreamResponse = await fetch(
    upstreamUrl(requestUrl, upstreamOrigin, false),
    init,
  );
  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  let body = upstreamResponse.body;
  let transformed = false;

  if (body && contentType.includes("text/event-stream")) {
    transformed = true;
    body = body.pipeThrough(
      createSseRewriteStream(() => {
        log({ event: "proxy.capacity_rewrite", transport: "sse" });
      }),
    );
  } else if (upstreamResponse.status >= 400 && contentType.includes("json")) {
    const result = rewriteCapacityError(await upstreamResponse.text());
    transformed = result.rewritten;
    if (result.rewritten) {
      log({ event: "proxy.capacity_rewrite", transport: "http" });
    }
    body = new Blob([result.text]).stream();
  }

  writeResponseHead(response, upstreamResponse, transformed);
  log({
    event: "proxy.upstream_response",
    status: upstreamResponse.status,
    transport: "http",
  });

  if (!body) {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const readable = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
    readable.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    readable.pipe(response);
  });
}

function handleWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  upstreamOrigin: URL,
  webSocketServer: WebSocketServer,
  log: (entry: LogEntry) => void,
): void {
  const requestUrl = incomingUrl(request);
  if (!isCodexPath(requestUrl.pathname)) {
    writeSocketResponse(socket, 404, "Not Found", new Headers(), "Not found\n");
    return;
  }

  log({
    event: "proxy.request",
    method: request.method ?? "GET",
    path: requestUrl.pathname,
    transport: "websocket",
  });

  const protocols = parseProtocols(request.headers["sec-websocket-protocol"]);
  const headers = Object.fromEntries(buildUpstreamHeaders(request, true));
  const url = upstreamUrl(requestUrl, upstreamOrigin, true);
  const upstream = protocols.length
    ? new WebSocket(url, protocols, { headers, perMessageDeflate: true })
    : new WebSocket(url, { headers, perMessageDeflate: true });
  let settled = false;

  upstream.once("open", () => {
    settled = true;
    log({ event: "proxy.upstream_response", status: 101, transport: "websocket" });
    webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
      bridgeWebSockets(downstream, upstream, log);
    });
  });

  upstream.once("unexpected-response", (_upgradeRequest, upstreamResponse) => {
    settled = true;
    const chunks: Buffer[] = [];
    upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstreamResponse.once("end", () => {
      const original = Buffer.concat(chunks).toString("utf8");
      const contentType = upstreamResponse.headers["content-type"] ?? "";
      const result = contentType.includes("json")
        ? rewriteCapacityError(original)
        : { text: original, rewritten: false };
      if (result.rewritten) {
        log({ event: "proxy.capacity_rewrite", transport: "websocket-handshake" });
      }
      log({
        event: "proxy.upstream_response",
        status: upstreamResponse.statusCode ?? 502,
        transport: "websocket",
      });
      writeSocketResponse(
        socket,
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage ?? "Bad Gateway",
        new Headers(upstreamResponse.headers as Record<string, string>),
        result.text,
      );
    });
  });

  upstream.once("error", (error) => {
    if (settled) {
      return;
    }
    settled = true;
    log({
      event: "proxy.error",
      message: error.message,
      transport: "websocket",
    });
    writeSocketResponse(
      socket,
      502,
      "Bad Gateway",
      new Headers({ "content-type": "text/plain; charset=utf-8" }),
      `Upstream WebSocket failed: ${error.message}\n`,
    );
  });

  socket.once("close", () => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate();
    }
  });
  socket.once("error", () => upstream.terminate());
}

function bridgeWebSockets(
  downstream: WebSocket,
  upstream: WebSocket,
  log: (entry: LogEntry) => void,
): void {
  downstream.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });
  upstream.on("message", (data, isBinary) => {
    if (downstream.readyState !== WebSocket.OPEN) {
      return;
    }
    if (isBinary) {
      downstream.send(data, { binary: true });
      return;
    }
    const result = rewriteCapacityError(data.toString());
    if (result.rewritten) {
      log({ event: "proxy.capacity_rewrite", transport: "websocket" });
    }
    downstream.send(result.text);
  });
  downstream.on("close", (code, reason) => closePeer(upstream, code, reason));
  upstream.on("close", (code, reason) => closePeer(downstream, code, reason));
  downstream.on("error", () => upstream.terminate());
  upstream.on("error", () => downstream.terminate());
}

function buildUpstreamHeaders(
  request: IncomingMessage,
  webSocket: boolean,
): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index], request.rawHeaders[index + 1]);
  }
  for (const name of REQUEST_HEADERS_TO_DROP) {
    headers.delete(name);
  }
  if (webSocket) {
    for (const name of WEBSOCKET_HEADERS_TO_DROP) {
      headers.delete(name);
    }
  }
  return headers;
}

function upstreamUrl(requestUrl: URL, origin: URL, webSocket: boolean): URL {
  const url = new URL(requestUrl.pathname + requestUrl.search, origin);
  if (webSocket) {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  }
  return url;
}

function incomingUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

function isCodexPath(pathname: string): boolean {
  return (
    pathname === CODEX_PATH_PREFIX ||
    pathname.startsWith(`${CODEX_PATH_PREFIX}/`)
  );
}

function parseProtocols(value: string | undefined): string[] {
  return value?.split(",").map((protocol) => protocol.trim()).filter(Boolean) ?? [];
}

function writeResponseHead(
  response: ServerResponse,
  upstream: Response,
  rewritten: boolean,
): void {
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  if (rewritten) {
    headers.delete("etag");
  }
  for (const [name, value] of headers) {
    if (name !== "set-cookie") {
      response.setHeader(name, value);
    }
  }
  const cookies = headers.getSetCookie();
  if (cookies.length) {
    response.setHeader("set-cookie", cookies);
  }
  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
}

function writeSocketResponse(
  socket: Duplex,
  status: number,
  statusText: string,
  sourceHeaders: Headers,
  body: string,
): void {
  const headers = new Headers(sourceHeaders);
  for (const name of [
    "connection",
    "content-encoding",
    "content-length",
    "transfer-encoding",
  ]) {
    headers.delete(name);
  }
  headers.set("connection", "close");
  headers.set("content-length", String(Buffer.byteLength(body)));

  let response = `HTTP/1.1 ${status} ${statusText}\r\n`;
  for (const [name, value] of headers) {
    response += `${name}: ${value}\r\n`;
  }
  socket.end(`${response}\r\n${body}`);
}

function closePeer(peer: WebSocket, code: number, reason: Buffer): void {
  if (peer.readyState !== WebSocket.OPEN) {
    return;
  }
  if (code >= 1000 && code <= 4999 && ![1005, 1006, 1015].includes(code)) {
    peer.close(code, reason);
  } else {
    peer.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
