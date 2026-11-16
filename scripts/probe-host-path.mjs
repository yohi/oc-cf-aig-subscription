#!/usr/bin/env node
// Secret-free loopback probe responder. Built-in modules only; never logs headers.
import http from "node:http";
import { pathToFileURL } from "node:url";

export function startProbeServer({ host = "127.0.0.1", port } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((res, rej) => {
            server.close((e) => (e ? rej(e) : res()));
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.argv[2] ?? 49187);
  const s = await startProbeServer({ host: "127.0.0.1", port });
  console.log(`probe listening on 127.0.0.1:${s.port}`);
  process.on("SIGINT", () => s.close().then(() => process.exit(0)));
}
