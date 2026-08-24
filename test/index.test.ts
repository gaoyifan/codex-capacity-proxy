import { describe, expect, it } from "vitest";

import {
  buildUpstreamHeaders,
} from "../src/index";
import {
  rewriteCapacityError,
  rewriteSseEventBlock,
} from "../src/rewrite";

describe("rewriteCapacityError", () => {
  it("turns a Responses capacity failure into a retryable rate limit error", () => {
    const input = JSON.stringify({
      type: "response.failed",
      response: {
        error: {
          code: "server_is_overloaded",
          message: "Selected model is at capacity.",
        },
      },
    });

    const result = rewriteCapacityError(input);
    const payload = JSON.parse(result.text);

    expect(result.rewritten).toBe(true);
    expect(payload.response.error).toEqual({
      code: "rate_limit_exceeded",
      message: "Selected model is at capacity. Please try again in 30s.",
    });
  });

  it("rewrites a wrapped WebSocket slow-down error", () => {
    const result = rewriteCapacityError(
      JSON.stringify({
        type: "error",
        status: 503,
        error: { code: "slow_down", message: "Busy" },
      }),
    );

    expect(result.rewritten).toBe(true);
    expect(JSON.parse(result.text).error).toEqual({
      code: "rate_limit_exceeded",
      message: "Busy Please try again in 30s.",
    });
  });

  it("leaves unrelated events byte-for-byte unchanged", () => {
    const input = '{"type":"response.output_text.delta","delta":"hello"}';
    expect(rewriteCapacityError(input)).toEqual({
      text: input,
      rewritten: false,
    });
  });
});

describe("rewriteSseEventBlock", () => {
  it("rewrites the data line of a capacity failure event", () => {
    const input = [
      "event: response.failed",
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          error: { code: "server_is_overloaded", message: "At capacity" },
        },
      })}`,
    ].join("\n");

    const result = rewriteSseEventBlock(input);

    expect(result.rewritten).toBe(true);
    expect(result.text).toContain('"code":"rate_limit_exceeded"');
    expect(result.text).toContain("Please try again in 30s.");
  });
});

describe("buildUpstreamHeaders", () => {
  it("preserves Codex semantic headers and regenerates transport headers", () => {
    const incoming = new Headers({
      authorization: "Bearer secret",
      "chatgpt-account-id": "account-id",
      connection: "keep-alive",
      host: "proxy.example.com",
      "openai-beta": "responses_websockets=2026-02-06",
      originator: "codex_cli_rs",
      "sec-websocket-key": "downstream-key",
      "x-codex-turn-state": "sticky-state",
      "cf-ray": "edge-ray",
    });

    const headers = buildUpstreamHeaders(incoming, "gzip", true);

    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("chatgpt-account-id")).toBe("account-id");
    expect(headers.get("openai-beta")).toBe(
      "responses_websockets=2026-02-06",
    );
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("x-codex-turn-state")).toBe("sticky-state");
    expect(headers.get("accept-encoding")).toBe("gzip");
    expect(headers.get("upgrade")).toBe("websocket");
    expect(headers.has("host")).toBe(false);
    expect(headers.has("connection")).toBe(false);
    expect(headers.has("sec-websocket-key")).toBe(false);
    expect(headers.has("cf-ray")).toBe(false);
  });
});
