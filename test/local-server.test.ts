import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { createLocalProxyServer } from "../src/local-server.ts";

const capacityEvent = JSON.stringify({
  type: "response.failed",
  response: {
    error: {
      code: "server_is_overloaded",
      message: "Selected model is at capacity.",
    },
  },
});

describe("local proxy", () => {
  const seenAuthorization: string[] = [];
  const logs: Array<Record<string, boolean | number | string>> = [];
  const upstreamWebSockets = new WebSocketServer({ noServer: true });
  const upstream = createServer((request, response) => {
    seenAuthorization.push(request.headers.authorization ?? "");
    if (request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"models":[]}');
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: response.failed\ndata: ${capacityEvent}\n\n`);
  });

  let upstreamOrigin: string;
  let proxyOrigin: string;
  let proxy: ReturnType<typeof createLocalProxyServer>;

  beforeAll(async () => {
    upstream.on("upgrade", (request, socket, head) => {
      seenAuthorization.push(request.headers.authorization ?? "");
      if (request.url?.includes("handshake-error")) {
        socket.end(
          [
            "HTTP/1.1 503 Service Unavailable",
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(capacityEvent)}`,
            "Connection: close",
            "",
            capacityEvent,
          ].join("\r\n"),
        );
        return;
      }
      upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.once("message", () => webSocket.send(capacityEvent));
      });
    });
    await listen(upstream);
    upstreamOrigin = origin(upstream);

    proxy = createLocalProxyServer({
      upstreamOrigin,
      log(entry) {
        logs.push(entry);
      },
    });
    await listen(proxy);
    proxyOrigin = origin(proxy);
  });

  afterAll(async () => {
    upstreamWebSockets.clients.forEach((client) => client.terminate());
    await Promise.all([close(proxy), close(upstream)]);
    upstreamWebSockets.close();
  });

  it("forwards authentication headers and rewrites an SSE capacity event", async () => {
    const models = await fetch(`${proxyOrigin}/backend-api/codex/models`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(await models.json()).toEqual({ models: [] });

    const response = await fetch(`${proxyOrigin}/backend-api/codex/responses`, {
      body: "{}",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.text();

    expect(seenAuthorization.slice(0, 2)).toEqual([
      "Bearer test-token",
      "Bearer test-token",
    ]);
    expect(body).toContain('"code":"rate_limit_exceeded"');
    expect(body).toContain("Please try again in 30s.");
    expect(logs).toContainEqual({
      event: "proxy.capacity_rewrite",
      transport: "sse",
    });
  });

  it("forwards and rewrites WebSocket messages", async () => {
    const response = await webSocketRoundTrip(
      proxyOrigin.replace("http:", "ws:") + "/backend-api/codex/responses",
    );
    const payload = JSON.parse(response);

    expect(seenAuthorization.at(-1)).toBe("Bearer test-token");
    expect(payload.response.error.code).toBe("rate_limit_exceeded");
    expect(payload.response.error.message).toContain("Please try again in 30s.");
    expect(logs).toContainEqual({
      event: "proxy.capacity_rewrite",
      transport: "websocket",
    });
  });

  it("rewrites a capacity error returned during the WebSocket handshake", async () => {
    const response = await webSocketHandshakeResponse(
      proxyOrigin.replace("http:", "ws:") +
        "/backend-api/codex/responses?handshake-error=1",
    );
    const payload = JSON.parse(response.body);

    expect(response.status).toBe(503);
    expect(payload.response.error.code).toBe("rate_limit_exceeded");
    expect(payload.response.error.message).toContain("Please try again in 30s.");
    expect(logs).toContainEqual({
      event: "proxy.capacity_rewrite",
      transport: "websocket-handshake",
    });
  });
});

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function origin(server: ReturnType<typeof createServer>): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function webSocketRoundTrip(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, {
      headers: { authorization: "Bearer test-token" },
    });
    webSocket.once("open", () => webSocket.send("go"));
    webSocket.once("message", (data) => {
      webSocket.close();
      resolve(data.toString());
    });
    webSocket.once("error", reject);
  });
}

async function webSocketHandshakeResponse(
  url: string,
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, {
      headers: { authorization: "Bearer test-token" },
    });
    webSocket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode ?? 0,
        });
      });
    });
    webSocket.once("error", reject);
  });
}
