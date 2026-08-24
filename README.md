# Codex capacity proxy experiment

This repository tests whether a Cloudflare Worker can transparently proxy the built-in Codex `openai` provider and change `server_is_overloaded` and `slow_down` failures into retryable rate-limit failures.

It cannot currently reach the ChatGPT Codex backend. OpenAI blocks the cross-zone Worker subrequest before it reaches the Codex application, even though the Worker receives and forwards the Codex authentication and feature headers. See [EXPERIMENT.md](EXPERIMENT.md) for the live test and evidence.

The implementation includes Responses WebSocket forwarding, HTTP/SSE fallback forwarding, and capacity-error rewriting. The rewriting logic is covered by unit tests but could not be exercised against a real upstream capacity response because of the edge block.

## Reproduce

Deploy the Worker:

```sh
npm install
npm run check
npm run deploy
```

Run Codex with a temporary backend override:

```sh
codex -c 'openai_base_url="https://WORKER.workers.dev/backend-api/codex"'
```

The provider remains the built-in `openai` provider, so ChatGPT login and subscription authentication remain active. The current expected result is an upstream `403` response.

## Security

The Worker receives the ChatGPT bearer token supplied by Codex. Keep the repository free of tokens and do not add unrelated forwarding destinations. Application logs record only whether selected headers are present, but Cloudflare live tail events can include request metadata; observability is therefore left disabled after the experiment.
