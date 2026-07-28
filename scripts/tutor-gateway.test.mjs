import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_TOKEN = "gateway-test-token";
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_SCRIPT = path.join(SCRIPT_DIRECTORY, "tutor-gateway.mjs");

let audioServer;
let chatServer;
let gatewayProcess;
let gatewayBaseUrl;
let temporaryDirectory;

before(async () => {
  audioServer = await startMockServer("audio");
  chatServer = await startMockServer("chat");
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pad-tutor-gateway-"),
  );
  const tokenFile = path.join(temporaryDirectory, "gateway-token.txt");
  await writeFile(tokenFile, `${TEST_TOKEN}\n`, { encoding: "utf8" });
  await chmod(tokenFile, 0o600);

  gatewayProcess = spawn(process.execPath, [GATEWAY_SCRIPT], {
    env: {
      ...process.env,
      TUTOR_GATEWAY_PORT: "0",
      TUTOR_GATEWAY_TOKEN_FILE: tokenFile,
      TUTOR_GATEWAY_TIMEOUT_MS: "50",
      TUTOR_GATEWAY_MAX_BODY_BYTES: "8",
      TUTOR_GATEWAY_STT_BASE_URL: serverUrl(audioServer),
      TUTOR_GATEWAY_STT_API_KEY: "audio-upstream-token",
      TUTOR_GATEWAY_TTS_BASE_URL: serverUrl(audioServer),
      TUTOR_GATEWAY_TTS_API_KEY: "audio-upstream-token",
      TUTOR_GATEWAY_CHAT_BASE_URL: serverUrl(chatServer),
      TUTOR_GATEWAY_CHAT_API_KEY: "chat-upstream-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  gatewayBaseUrl = await waitForGateway(gatewayProcess);
});

after(async () => {
  gatewayProcess?.kill("SIGTERM");
  await Promise.all([
    waitForExit(gatewayProcess),
    closeServer(audioServer),
    closeServer(chatServer),
  ]);
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("health is available without exposing configuration secrets", async () => {
  const response = await fetch(`${gatewayBaseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "pad-tutor-gateway",
    routes: ["stt", "chat", "tts"],
  });
});

test("proxy routes require the gateway Bearer token", async () => {
  const response = await fetch(`${gatewayBaseUrl}/stt/v1/models`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
});

test("STT and TTS share the audio server and incoming auth is replaced", async () => {
  for (const mount of ["stt", "tts"]) {
    const response = await authorizedFetch(
      `${gatewayBaseUrl}/${mount}/v1/echo?source=${mount}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-pad-private"), null);
    const payload = await response.json();
    assert.equal(payload.service, "audio");
    assert.equal(payload.path, `/v1/echo?source=${mount}`);
    assert.equal(payload.authorization, "Bearer audio-upstream-token");
    assert.notEqual(payload.authorization, `Bearer ${TEST_TOKEN}`);
    assert.equal(payload.acceptEncoding, "identity");
  }
});

test("chat traffic uses the Ollama route", async () => {
  const response = await authorizedFetch(`${gatewayBaseUrl}/chat/v1/echo`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.service, "chat");
  assert.equal(payload.authorization, "Bearer chat-upstream-token");
});

test("request bodies over the configured limit are rejected", async () => {
  const response = await authorizedFetch(`${gatewayBaseUrl}/stt/v1/echo`, {
    method: "POST",
    body: "123456789",
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "payload_too_large");
});

test("slow upstreams are aborted at the configured timeout", async () => {
  const response = await authorizedFetch(`${gatewayBaseUrl}/chat/v1/slow`);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error, "upstream_timeout");
});

function authorizedFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
  });
}

async function startMockServer(service) {
  const server = http.createServer((request, response) => {
    if (request.url === "/v1/slow") {
      setTimeout(() => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ service }));
      }, 150);
      return;
    }

    response.setHeader("Content-Type", "application/json");
    response.setHeader("Connection", "x-pad-private");
    response.setHeader("X-Pad-Private", "must-not-leak");
    response.end(
      JSON.stringify({
        service,
        path: request.url,
        authorization: request.headers.authorization || null,
        acceptEncoding: request.headers["accept-encoding"] || null,
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function serverUrl(server) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function waitForGateway(child) {
  return new Promise((resolve, reject) => {
    let standardOutput = "";
    let standardError = "";
    const timeout = setTimeout(
      () => reject(new Error(`Gateway startup timed out: ${standardError}`)),
      5_000,
    );

    child.stdout.on("data", (chunk) => {
      standardOutput += chunk.toString();
      const match = standardOutput.match(
        /PAD tutor gateway listening on http:\/\/127\.0\.0\.1:(\d+)/,
      );
      if (!match) return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on("data", (chunk) => {
      standardError += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Gateway exited before startup (${code}): ${standardError}`),
      );
    });
  });
}

function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}
