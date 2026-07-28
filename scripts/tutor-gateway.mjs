#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_HEADERS_TO_DROP = new Set([
  ...HOP_BY_HOP_HEADERS,
  "accept-encoding",
  "authorization",
  "content-length",
  "expect",
  "host",
]);
const RESPONSE_HEADERS_TO_DROP = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
]);
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

const bindHost = process.env.TUTOR_GATEWAY_HOST?.trim() || "127.0.0.1";
if (!LOOPBACK_HOSTS.has(bindHost)) {
  fatal("TUTOR_GATEWAY_HOST must be a loopback host.");
}

const port = readInteger("TUTOR_GATEWAY_PORT", 8787, { min: 0, max: 65535 });
const timeoutMs = readInteger("TUTOR_GATEWAY_TIMEOUT_MS", 120_000, {
  min: 1,
  max: 900_000,
});
const maxBodyBytes = readMaxBodyBytes();
const requireHealthAuth = process.env.TUTOR_GATEWAY_REQUIRE_HEALTH_AUTH === "1";
const gatewayToken = readGatewayToken();

const routes = [
  createRoute(
    "/stt",
    "stt",
    "TUTOR_GATEWAY_STT_BASE_URL",
    "http://127.0.0.1:8000",
    "TUTOR_GATEWAY_STT_API_KEY",
  ),
  createRoute(
    "/chat",
    "chat",
    "TUTOR_GATEWAY_CHAT_BASE_URL",
    "http://127.0.0.1:11434",
    "TUTOR_GATEWAY_CHAT_API_KEY",
  ),
  createRoute(
    "/tts",
    "tts",
    "TUTOR_GATEWAY_TTS_BASE_URL",
    "http://127.0.0.1:8000",
    "TUTOR_GATEWAY_TTS_API_KEY",
  ),
];

const server = http.createServer(async (request, response) => {
  let route;

  try {
    const requestUrl = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    );

    if (request.method === "OPTIONS") {
      writeCors(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (requestUrl.pathname === "/health") {
      if (requireHealthAuth && !isAuthorized(request)) {
        unauthorized(response);
        return;
      }

      json(response, 200, {
        ok: true,
        service: "pad-tutor-gateway",
        routes: routes.map((candidate) => candidate.name),
      });
      return;
    }

    if (!ALLOWED_METHODS.has(request.method || "")) {
      json(response, 405, {
        error: "method_not_allowed",
        message: "Only GET, HEAD, POST, and OPTIONS are supported.",
      });
      return;
    }

    route = routes.find(
      (candidate) =>
        requestUrl.pathname === candidate.mount ||
        requestUrl.pathname.startsWith(`${candidate.mount}/`),
    );
    if (!route) {
      json(response, 404, {
        error: "not_found",
        message: "Use /stt/*, /chat/*, /tts/*, or /health.",
      });
      return;
    }

    if (!isAuthorized(request)) {
      unauthorized(response);
      return;
    }

    const body = await readBody(request);
    const upstreamUrl = buildUpstreamUrl(route, requestUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: buildUpstreamHeaders(request.headers, route.upstreamToken),
        body:
          request.method === "GET" ||
          request.method === "HEAD" ||
          body.length === 0
            ? undefined
            : body,
        redirect: "manual",
        signal: controller.signal,
      });
      const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());

      response.statusCode = upstreamResponse.status;
      copyUpstreamHeaders(upstreamResponse.headers, response);
      writeCors(response);
      if (request.method === "HEAD") {
        response.end();
      } else {
        response.end(responseBody);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }

    const failure = classifyError(error);
    console.error(
      `[pad-tutor-gateway] ${route?.name || "request"}: ${redactError(error)}`,
    );
    json(response, failure.status, {
      error: failure.code,
      message: failure.message,
    });
  }
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(port, bindHost, () => {
  const address = server.address();
  const listeningPort =
    address && typeof address === "object" ? address.port : port;
  console.log(
    `PAD tutor gateway listening on http://${bindHost}:${listeningPort}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function readGatewayToken() {
  const tokenFile = process.env.TUTOR_GATEWAY_TOKEN_FILE?.trim();
  if (tokenFile) {
    try {
      const token = readFileSync(tokenFile, "utf8").trim();
      if (token) return token;
    } catch {
      fatal("Unable to read TUTOR_GATEWAY_TOKEN_FILE.");
    }
    fatal("TUTOR_GATEWAY_TOKEN_FILE is empty.");
  }

  const legacyToken = process.env.TUTOR_GATEWAY_TOKEN?.trim();
  if (legacyToken) return legacyToken;

  fatal(
    "Set TUTOR_GATEWAY_TOKEN_FILE (preferred) or TUTOR_GATEWAY_TOKEN before starting.",
  );
}

function createRoute(
  mount,
  name,
  baseUrlEnvironmentName,
  defaultBaseUrl,
  tokenEnvironmentName,
) {
  const baseUrl = new URL(
    process.env[baseUrlEnvironmentName]?.trim() || defaultBaseUrl,
  );
  if (
    baseUrl.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(baseUrl.hostname) ||
    baseUrl.username ||
    baseUrl.password
  ) {
    fatal(
      `${baseUrlEnvironmentName} must be an unauthenticated loopback HTTP URL.`,
    );
  }
  baseUrl.hash = "";
  baseUrl.search = "";
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";

  return {
    mount,
    name,
    baseUrl,
    upstreamToken: process.env[tokenEnvironmentName]?.trim() || "",
  };
}

function buildUpstreamUrl(route, requestUrl) {
  const relativePath = requestUrl.pathname.slice(route.mount.length);
  const upstreamUrl = new URL(relativePath.replace(/^\/+/, ""), route.baseUrl);
  upstreamUrl.search = requestUrl.search;
  return upstreamUrl;
}

function isAuthorized(request) {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    return false;
  }

  const candidate = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(gatewayToken);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

function unauthorized(response) {
  json(response, 401, {
    error: "unauthorized",
    message: "Missing or invalid Bearer token.",
  });
}

function buildUpstreamHeaders(incomingHeaders, upstreamToken) {
  const headers = new Headers();
  const connectionHeaders = connectionHeaderTokens(incomingHeaders.connection);

  for (const [name, value] of Object.entries(incomingHeaders)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined ||
      REQUEST_HEADERS_TO_DROP.has(lowerName) ||
      connectionHeaders.has(lowerName)
    ) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  headers.set("Accept-Encoding", "identity");
  if (upstreamToken) headers.set("Authorization", `Bearer ${upstreamToken}`);
  return headers;
}

function copyUpstreamHeaders(upstreamHeaders, response) {
  const connectionHeaders = connectionHeaderTokens(
    upstreamHeaders.get("connection"),
  );
  for (const [name, value] of upstreamHeaders) {
    const lowerName = name.toLowerCase();
    if (
      RESPONSE_HEADERS_TO_DROP.has(lowerName) ||
      connectionHeaders.has(lowerName)
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
}

function connectionHeaderTokens(value) {
  if (!value) return new Set();
  const values = Array.isArray(value) ? value : [value];
  return new Set(
    values
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function readBody(request) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new GatewayError(
      413,
      "payload_too_large",
      `Request body exceeds the ${maxBodyBytes}-byte limit.`,
    );
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.resume();
      throw new GatewayError(
        413,
        "payload_too_large",
        `Request body exceeds the ${maxBodyBytes}-byte limit.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function readMaxBodyBytes() {
  if (process.env.TUTOR_GATEWAY_MAX_BODY_BYTES) {
    return readInteger("TUTOR_GATEWAY_MAX_BODY_BYTES", 50 * 1024 * 1024, {
      min: 1,
      max: 1024 * 1024 * 1024,
    });
  }
  return (
    readInteger("TUTOR_GATEWAY_MAX_BODY_MB", 50, { min: 1, max: 1024 }) *
    1024 *
    1024
  );
}

function readInteger(name, fallback, { min, max }) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallback;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < min || value > max) {
    fatal(`${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function classifyError(error) {
  if (error instanceof GatewayError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new GatewayError(
      504,
      "upstream_timeout",
      "The local tutor service timed out.",
    );
  }
  return new GatewayError(
    502,
    "upstream_unavailable",
    "The local tutor service is unavailable.",
  );
}

function redactError(error) {
  const rawMessage =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : "Unknown error";
  return rawMessage.replaceAll(gatewayToken, "[redacted]");
}

function json(response, status, payload) {
  response.statusCode = status;
  writeCors(response);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function writeCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, OPTIONS",
  );
}

function fatal(message) {
  console.error(`[pad-tutor-gateway] ${message}`);
  process.exit(1);
}

class GatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
