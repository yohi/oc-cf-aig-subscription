import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";

/** Create disposable local CA/leaf material for HTTPS tests. */
export function createTlsFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oc2-broker-tls-"));
  const caKey = path.join(directory, "ca.key");
  const caCert = path.join(directory, "ca.pem");
  const key = path.join(directory, "server.key");
  const csr = path.join(directory, "server.csr");
  const cert = path.join(directory, "server.pem");
  const extensions = path.join(directory, "server.ext");
  const run = (args) => {
    const result = spawnSync("openssl", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };

  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=OC2 test CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-addext", "subjectKeyIdentifier=hash", "-addext", "authorityKeyIdentifier=keyid:always,issuer",
    "-keyout", caKey, "-out", caCert]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=host.docker.internal",
    "-keyout", key, "-out", csr]);
  fs.writeFileSync(extensions,
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:host.docker.internal,IP:127.0.0.1\n");
  run(["x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
    "-days", "1", "-extfile", extensions, "-out", cert]);

  return {
    caCert,
    cert,
    key,
    ca: fs.readFileSync(caCert),
    certBytes: fs.readFileSync(cert),
    keyBytes: fs.readFileSync(key),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

export function httpsRequest(url, options, ca) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      ...options,
      ca,
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      resolve(new Response(Readable.toWeb(response), { status: response.statusCode ?? 500, headers }));
    });
    request.on("error", reject);
    request.end(options?.body);
  });
}
