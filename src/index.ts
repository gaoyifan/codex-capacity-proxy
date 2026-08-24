const UPSTREAM_ORIGIN = "https://chatgpt.com";
const CODEX_PATH_PREFIX = "/backend-api/codex";
const RETRY_DELAY_SECONDS = 30;

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
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-accept",
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ew-via",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

const RESPONSE_HEADERS_TO_DROP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-accept",
  "sec-websocket-extensions",
] as const;

type RewriteResult = {
  text: string;
  rewritten: boolean;
};

type ErrorBody = {
  code?: unknown;
  message?: unknown;
};

type JsonObject = Record<string, unknown>;

export default {
  async fetch(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/") {
      return new Response("codex-capacity-proxy\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (!isCodexPath(requestUrl.pathname)) {
      return new Response("Not found\n", { status: 404 });
    }

    const isWebSocket =
      request.headers.get("upgrade")?.toLowerCase() === "websocket";
    logRequest(request, isWebSocket);

    if (isWebSocket) {
      return proxyWebSocket(request, requestUrl);
    }

    return proxyHttp(request, requestUrl);
  },
} satisfies ExportedHandler;

function isCodexPath(pathname: string): boolean {
  return (
    pathname === CODEX_PATH_PREFIX ||
    pathname.startsWith(`${CODEX_PATH_PREFIX}/`)
  );
}

function upstreamUrl(requestUrl: URL): URL {
  const url = new URL(requestUrl);
  url.protocol = "https:";
  url.host = new URL(UPSTREAM_ORIGIN).host;
  return url;
}

async function proxyHttp(request: Request, requestUrl: URL): Promise<Response> {
  const headers = buildUpstreamHeaders(
    request.headers,
    typeof request.cf?.clientAcceptEncoding === "string"
      ? request.cf.clientAcceptEncoding
      : undefined,
    false,
  );
  const response = await fetch(upstreamUrl(requestUrl), {
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    headers,
    method: request.method,
    redirect: "manual",
  });

  logUpstreamResponse("http", response);

  const contentType = response.headers.get("content-type") ?? "";
  if (response.body && contentType.includes("text/event-stream")) {
    const rewrittenBody = response.body.pipeThrough(
      createSseRewriteStream(() => logCapacityRewrite("sse")),
    );
    const responseHeaders = transformedResponseHeaders(response.headers);
    return new Response(rewrittenBody, {
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (response.status >= 400 && contentType.includes("json")) {
    return rewriteJsonErrorResponse(response, "http");
  }

  return response;
}

async function proxyWebSocket(
  request: Request,
  requestUrl: URL,
): Promise<Response> {
  const headers = buildUpstreamHeaders(
    request.headers,
    typeof request.cf?.clientAcceptEncoding === "string"
      ? request.cf.clientAcceptEncoding
      : undefined,
    true,
  );
  const upstreamResponse = await fetch(upstreamUrl(requestUrl), {
    headers,
    method: "GET",
    redirect: "manual",
  });

  logUpstreamResponse("websocket", upstreamResponse);

  const upstreamSocket = upstreamResponse.webSocket;
  if (upstreamResponse.status !== 101 || !upstreamSocket) {
    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    if (upstreamResponse.status >= 400 && contentType.includes("json")) {
      return rewriteJsonErrorResponse(upstreamResponse, "websocket-handshake");
    }
    return upstreamResponse;
  }

  const [clientSocket, workerSocket] = Object.values(new WebSocketPair());
  upstreamSocket.binaryType = "arraybuffer";
  workerSocket.binaryType = "arraybuffer";
  upstreamSocket.accept({ allowHalfOpen: true });
  workerSocket.accept({ allowHalfOpen: true });

  workerSocket.addEventListener("message", (event) => {
    sendIfOpen(upstreamSocket, event.data);
  });
  upstreamSocket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      sendIfOpen(workerSocket, event.data);
      return;
    }

    const result = rewriteCapacityError(event.data);
    if (result.rewritten) {
      logCapacityRewrite("websocket");
    }
    sendIfOpen(workerSocket, result.text);
  });

  workerSocket.addEventListener("close", (event) => {
    closeIfNeeded(upstreamSocket, event.code, event.reason);
  });
  upstreamSocket.addEventListener("close", (event) => {
    closeIfNeeded(workerSocket, event.code, event.reason);
  });
  workerSocket.addEventListener("error", () => {
    closeIfNeeded(upstreamSocket, 1011, "Downstream WebSocket error");
  });
  upstreamSocket.addEventListener("error", () => {
    closeIfNeeded(workerSocket, 1011, "Upstream WebSocket error");
  });

  return new Response(null, {
    headers: websocketResponseHeaders(upstreamResponse.headers),
    status: 101,
    webSocket: clientSocket,
  });
}

export function buildUpstreamHeaders(
  incoming: Headers,
  clientAcceptEncoding: string | undefined,
  webSocket: boolean,
): Headers {
  const headers = new Headers(incoming);
  for (const name of REQUEST_HEADERS_TO_DROP) {
    headers.delete(name);
  }

  if (clientAcceptEncoding) {
    headers.set("accept-encoding", clientAcceptEncoding);
  } else {
    headers.delete("accept-encoding");
  }

  if (webSocket) {
    headers.set("upgrade", "websocket");
  } else {
    headers.delete("sec-websocket-extensions");
    headers.delete("sec-websocket-protocol");
  }

  return headers;
}

export function rewriteCapacityError(text: string): RewriteResult {
  if (
    !text.includes("server_is_overloaded") &&
    !text.includes("slow_down")
  ) {
    return { text, rewritten: false };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { text, rewritten: false };
  }

  if (!isObject(payload)) {
    return { text, rewritten: false };
  }

  let rewritten = rewriteErrorBody(payload.error);
  if (isObject(payload.response)) {
    rewritten = rewriteErrorBody(payload.response.error) || rewritten;
  }

  return rewritten
    ? { text: JSON.stringify(payload), rewritten: true }
    : { text, rewritten: false };
}

export function rewriteSseEventBlock(block: string): RewriteResult {
  let rewritten = false;
  const lines = block.split(/\r?\n/).map((line) => {
    if (!line.startsWith("data:")) {
      return line;
    }

    const whitespace = line.slice(5).match(/^\s*/)?.[0] ?? "";
    const result = rewriteCapacityError(line.slice(5 + whitespace.length));
    rewritten = result.rewritten || rewritten;
    return result.rewritten ? `data:${whitespace}${result.text}` : line;
  });

  return { text: lines.join("\n"), rewritten };
}

function rewriteErrorBody(candidate: unknown): boolean {
  if (!isObject(candidate)) {
    return false;
  }

  const error = candidate as ErrorBody;
  if (
    error.code !== "server_is_overloaded" &&
    error.code !== "slow_down"
  ) {
    return false;
  }

  error.code = "rate_limit_exceeded";
  const originalMessage =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : "Selected model is at capacity.";
  error.message = /try again in\s+\d+(?:\.\d+)?\s*(?:s|ms|seconds?)/i.test(
    originalMessage,
  )
    ? originalMessage
    : `${originalMessage} Please try again in ${RETRY_DELAY_SECONDS}s.`;
  return true;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createSseRewriteStream(
  onRewrite: () => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      while (true) {
        const delimiter = /\r?\n\r?\n/.exec(buffered);
        if (!delimiter) {
          break;
        }

        const block = buffered.slice(0, delimiter.index);
        buffered = buffered.slice(delimiter.index + delimiter[0].length);
        const result = rewriteSseEventBlock(block);
        if (result.rewritten) {
          onRewrite();
        }
        controller.enqueue(encoder.encode(result.text + delimiter[0]));
      }
    },
    flush(controller) {
      buffered += decoder.decode();
      if (!buffered) {
        return;
      }
      const result = rewriteSseEventBlock(buffered);
      if (result.rewritten) {
        onRewrite();
      }
      controller.enqueue(encoder.encode(result.text));
    },
  });
}

async function rewriteJsonErrorResponse(
  response: Response,
  transport: string,
): Promise<Response> {
  const original = await response.text();
  const result = rewriteCapacityError(original);
  if (result.rewritten) {
    logCapacityRewrite(transport);
  }
  return new Response(result.text, {
    headers: transformedResponseHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
}

function transformedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("etag");
  return headers;
}

function websocketResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const name of RESPONSE_HEADERS_TO_DROP) {
    headers.delete(name);
  }
  return headers;
}

function sendIfOpen(socket: WebSocket, data: string | ArrayBuffer): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}

function closeIfNeeded(socket: WebSocket, code: number, reason: string): void {
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close(code, reason);
  }
}

function logRequest(request: Request, webSocket: boolean): void {
  console.log(
    JSON.stringify({
      event: "proxy.request",
      headerPresence: {
        authorization: request.headers.has("authorization"),
        chatgptAccountId: request.headers.has("chatgpt-account-id"),
        openaiBeta: request.headers.has("openai-beta"),
        originator: request.headers.has("originator"),
        sessionId: request.headers.has("session-id"),
        threadId: request.headers.has("thread-id"),
        userAgent: request.headers.has("user-agent"),
        xOaiAttestation: request.headers.has("x-oai-attestation"),
      },
      method: request.method,
      path: new URL(request.url).pathname,
      transport: webSocket ? "websocket" : "http",
    }),
  );
}

function logUpstreamResponse(transport: string, response: Response): void {
  console.log(
    JSON.stringify({
      event: "proxy.upstream_response",
      hasWebSocket: response.webSocket !== null,
      status: response.status,
      transport,
    }),
  );
}

function logCapacityRewrite(transport: string): void {
  console.log(
    JSON.stringify({
      event: "proxy.capacity_rewrite",
      transport,
    }),
  );
}
