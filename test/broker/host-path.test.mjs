import test from "node:test";
import assert from "node:assert/strict";
import { startProbeServer } from "../../scripts/probe-host-path.mjs";

test("probe server responds on /health and 404 elsewhere", async () => {
  const server = await startProbeServer({ host: "127.0.0.1", port: 0 });
  try {
    assert.ok(Number.isInteger(server.port) && server.port > 0);
    const base = `http://127.0.0.1:${server.port}`;
    const ok = await fetch(`${base}/health`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    const nf = await fetch(`${base}/anything`);
    assert.equal(nf.status, 404);
    await nf.arrayBuffer();
  } finally {
    await server.close();
  }
});
