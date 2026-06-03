#!/usr/bin/env node
/* CHANGE NOTE
Why: Expose the local-only tutor services through a narrow Cloudflare Tunnel origin
What changed: Added a Bearer-token gateway for /stt, /chat, and /tts local service proxying
Behaviour/Assumptions: Cloudflare Tunnel forwards to this process on localhost:8787; upstream services remain local
Rollback: git checkout -- scripts/tutor-gateway.mjs package.json docs/Agents.md ../docs/Agents.md
- mj
*/

import http from "node:http";

const port = Number(process.env.TUTOR_GATEWAY_PORT || 8787);
const token = process.env.TUTOR_GATEWAY_TOKEN || "";
const maxBodyBytes = Number(process.env.TUTOR_GATEWAY_MAX_BODY_MB || 50) * 1024 * 1024;
const requireHealthAuth = process.env.TUTOR_GATEWAY_REQUIRE_HEALTH_AUTH === "1";

const routes = [
  {
    prefix: "/stt/",
    name: "stt",
    baseURL: process.env.TUTOR_GATEWAY_STT_BASE_URL || "http://127.0.0.1:8000",
    upstreamToken: process.env.TUTOR_GATEWAY_STT_API_KEY || "local",
  },
  {
    prefix: "/chat/",
    name: "chat",
    baseURL: process.env.TUTOR_GATEWAY_CHAT_BASE_URL || "http://127.0.0.1:11434",
    upstreamToken: process.env.TUTOR_GATEWAY_CHAT_API_KEY || "ollama",
  },
  {
    prefix: "/tts/",
    name: "tts",
    baseURL: process.env.TUTOR_GATEWAY_TTS_BASE_URL || "http://127.0.0.1:8880",
    upstreamToken: process.env.TUTOR_GATEWAY_TTS_API_KEY || "local",
  },
];

if (!token) {
  console.error("Set TUTOR_GATEWAY_TOKEN before starting the tutor gateway.");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      writeCors(res, 204);
      return res.end();
    }

    if (url.pathname === "/health") {
      if (requireHealthAuth && !isAuthorized(req)) return unauthorized(res);
      return json(res, 200, {
        ok: true,
        service: "pad-tutor-gateway",
        routes: routes.map((route) => route.name),
      });
    }

    const route = routes.find((candidate) => url.pathname.startsWith(candidate.prefix));
    if (!route) {
      return json(res, 404, {
        error: "not_found",
        message: "Use /stt/*, /chat/*, /tts/*, or /health.",
      });
    }

    if (!isAuthorized(req)) return unauthorized(res);

    const upstreamURL = buildUpstreamURL(route, url);
    const body = await readBody(req);
    const upstreamResponse = await fetch(upstreamURL, {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, route.upstreamToken),
      body: body.length ? body : undefined,
    });

    res.statusCode = upstreamResponse.status;
    writeCors(res);
    for (const [key, value] of upstreamResponse.headers) {
      if (!isHopByHopHeader(key)) res.setHeader(key, value);
    }
    const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
    res.end(responseBody);
  } catch (error) {
    console.error(error);
    json(res, 502, {
      error: "gateway_failed",
      message: error instanceof Error ? error.message : "Tutor gateway failed.",
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`PAD tutor gateway listening on http://127.0.0.1:${port}`);
});

function isAuthorized(req) {
  const value = req.headers.authorization || "";
  return value === `Bearer ${token}`;
}

function unauthorized(res) {
  return json(res, 401, {
    error: "unauthorized",
    message: "Missing or invalid Bearer token.",
  });
}

function buildUpstreamURL(route, url) {
  const base = route.baseURL.replace(/\/+$/, "");
  const path = url.pathname.slice(route.prefix.length);
  return `${base}/${path}${url.search}`;
}

function buildUpstreamHeaders(headers, upstreamToken) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value || isHopByHopHeader(key) || key.toLowerCase() === "host") continue;
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  result.Authorization = `Bearer ${upstreamToken}`;
  return result;
}

function isHopByHopHeader(key) {
  return [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ].includes(key.toLowerCase());
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error(`Request body is larger than ${maxBodyBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res, status, payload) {
  res.statusCode = status;
  writeCors(res);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function writeCors(res, status) {
  if (status) res.statusCode = status;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}
