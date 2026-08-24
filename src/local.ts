import { createLocalProxyServer } from "./local-server.ts";

const host = process.env.CODEX_PROXY_HOST ?? "127.0.0.1";
const port = Number(process.env.CODEX_PROXY_PORT ?? "8788");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(
    `Invalid CODEX_PROXY_PORT: ${process.env.CODEX_PROXY_PORT ?? ""}. Expected an integer from 1 to 65535.`,
  );
}

const server = createLocalProxyServer({
  log(entry) {
    console.error(JSON.stringify(entry));
  },
});

server.listen(port, host, () => {
  const displayHost = host.includes(":") ? `[${host}]` : host;
  console.error(`Codex capacity proxy listening on http://${displayHost}:${port}`);
});

server.on("error", (error) => {
  console.error(`Codex capacity proxy failed: ${error.message}`);
  process.exitCode = 1;
});
