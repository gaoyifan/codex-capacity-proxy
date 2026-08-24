# Codex capacity proxy

This proxy keeps Codex on its built-in `openai` provider and ChatGPT subscription authentication while changing `server_is_overloaded` and `slow_down` failures into retryable rate-limit failures.

The local Node proxy supports both Responses WebSocket traffic and HTTP/SSE fallback traffic. Integration tests cover header forwarding and capacity rewriting on both transports.

## Run locally

Install dependencies and start the loopback-only listener:

```sh
npm install
npm run local
```

In another terminal, point Codex at it:

```sh
codex -c 'openai_base_url="http://127.0.0.1:8788/backend-api/codex"'
```

The provider remains the built-in `openai` provider. No third-party API key or provider configuration is needed.

The proxy logs request paths, transports, upstream status codes, and capacity rewrites. It does not log headers or request bodies.

## Run on an intranet

Listen on all interfaces only when the host is protected by the internal network:

```sh
CODEX_PROXY_HOST=0.0.0.0 CODEX_PROXY_PORT=8788 npm run local
```

Clients then use `http://INTRANET_HOST:8788/backend-api/codex` as `openai_base_url`.

The proxy has no client authentication or TLS termination and receives each caller's ChatGPT bearer token. Restrict network access to trusted clients; use an authenticated TLS reverse proxy before exposing it beyond a trusted network.

## NixOS

The flake exports `packages.<system>.default` and `nixosModules.default`. A minimal NixOS configuration is:

```nix
{inputs, ...}: {
  imports = [inputs.codex-capacity-proxy.nixosModules.default];

  services.codex-capacity-proxy.enable = true;
}
```

The module listens on `127.0.0.1:8788` by default. Configure TLS and network access at the publishing layer.

## Retry behavior

The transformation is:

```text
server_is_overloaded | slow_down
          -> rate_limit_exceeded
          +  "Please try again in 30s."
```

This enters Codex's built-in rate-limit retry path. It does not make that retry loop infinite.

## Check

```sh
npm run check
```
