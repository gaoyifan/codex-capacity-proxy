# Live experiment: Cloudflare Workers

- Date: 2026-08-25 Asia/Singapore
- Codex: 0.149.1
- Worker version: `25e0030f-cb16-492a-963e-8e746517f75d`

## Outcome

A Cloudflare Worker is not a viable transparent proxy for `https://chatgpt.com/backend-api/codex/` in the tested environment. OpenAI's Cloudflare edge blocks the Worker's cross-zone subrequest before it reaches the Codex backend.

## Evidence

An unauthenticated request sent directly from the test machine reached the application layer:

```text
GET https://chatgpt.com/backend-api/codex/models?client_version=0.149.1
HTTP/2 401
content-type: application/json
```

The same request through the deployed Worker was blocked at the edge:

```text
GET https://codex-capacity-proxy.d58993771361bc4ff2f5.workers.dev/backend-api/codex/models?client_version=0.149.1
HTTP/2 403
content-type: text/html; charset=UTF-8

Unable to load site
Please try again later. If you are using a VPN, try turning it off.
[IP:2a06:98c0:3600::103]
```

[Cloudflare documents](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests) `2a06:98c0:3600::103` as the fixed `CF-Connecting-IP` used for cross-zone Worker subrequests. It also [adds `CF-Worker`](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-worker) to every Worker `fetch()` subrequest. Those properties cannot be restored to the original Codex client's values by Worker code.

A logged-in Codex request sent directly succeeded and returned the requested `direct-ok` response. With only `openai_base_url` changed to the Worker URL, Codex received `403` for all of these paths:

- `GET /backend-api/codex/models`
- WebSocket upgrade on `GET /backend-api/codex/responses`
- HTTP/SSE fallback on `POST /backend-api/codex/responses`

Live tail confirmed that the Worker received the following headers from Codex before making the upstream request:

- `Authorization`
- `chatgpt-account-id`
- `openai-beta` on WebSocket requests
- `originator`
- `session-id` and `thread-id`
- Codex routing and turn metadata headers

Header values and request bodies were not logged by the application. Cloudflare's tail event envelope did include request metadata, so persistent observability was disabled after the experiment.

## What remains valid

Codex accepts the Worker URL through the top-level `openai_base_url` setting while retaining the built-in `openai` provider and ChatGPT subscription authentication. Cloudflare Workers can also terminate and originate WebSockets. The blocker is the unavoidable identity of the outgoing cross-zone Worker request, not the HTTP/SSE or WebSocket implementation.

The capacity transformation itself is unit tested:

```text
server_is_overloaded | slow_down
          -> rate_limit_exceeded
          +  "Please try again in 30s."
```

This is expected to enter Codex's retryable rate-limit path, but the live Worker cannot reach a real Codex response to verify that final step end to end.
