/* CHANGE NOTE
Why: Remove hosted API fallback from the tutor and make local services the only runtime
What changed: Centralized local service config, endpoint helpers, error formatting, tutor JSON/fix parsing, and speech timing helpers
Behaviour/Assumptions: Every tutor service requires a local base URL; user-facing errors hide local details and keep admin trace IDs in logs
Rollback: git checkout -- src/lib/tutorProviders.ts
- mj
*/

export type TutorService = "stt" | "chat" | "tts";

export type TutorServiceConfig = {
  service: TutorService;
  label: string;
  model: string;
  apiKey: string;
  baseURL: string;
};

export type WordTiming = {
  word: string;
  start?: number;
  end?: number;
};

export type SpeechMetrics = {
  wordCount: number;
  durationSeconds?: number;
  wordsPerMinute?: number;
  pauseCount?: number;
  longestPauseSeconds?: number;
};

const SERVICE_LABELS: Record<TutorService, string> = {
  stt: "speech recognition",
  chat: "tutor chat",
  tts: "speech synthesis",
};

const LOCAL_MODEL_DEFAULTS: Record<TutorService, string> = {
  stt: "Systran/faster-distil-whisper-large-v3",
  chat: "qwen3:30b-a3b-instruct-2507-q4_K_M",
  tts: "kokoro",
};

const TUTOR_USER_MESSAGE = "The tutor hit a temporary error. Please try again in a moment.";

const LOCAL_SERVICE_USER_MESSAGES: Record<TutorService, string> = {
  stt: TUTOR_USER_MESSAGE,
  chat: TUTOR_USER_MESSAGE,
  tts: TUTOR_USER_MESSAGE,
};

export class TutorServiceError extends Error {
  status: number;
  code: string;
  service?: TutorService;

  constructor(status: number, code: string, message: string, service?: TutorService) {
    super(message);
    this.name = "TutorServiceError";
    this.status = status;
    this.code = code;
    this.service = service;
  }
}

export function resolveLocalServiceConfig(service: TutorService): TutorServiceConfig {
  const label = SERVICE_LABELS[service];
  const baseURL = process.env[`LOCAL_${service.toUpperCase()}_BASE_URL`] || process.env.TUTOR_LOCAL_BASE_URL;

  if (!baseURL) {
    throw new TutorServiceError(
      400,
      "local_base_url_missing",
      `Set LOCAL_${service.toUpperCase()}_BASE_URL before using local ${label}.`,
      service
    );
  }

  return {
    service,
    label,
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey:
      process.env[`LOCAL_${service.toUpperCase()}_API_KEY`] ||
      process.env.TUTOR_LOCAL_API_KEY ||
      "local",
    model: process.env[`LOCAL_${service.toUpperCase()}_MODEL`] || LOCAL_MODEL_DEFAULTS[service],
  };
}

export function localServiceUrl(config: TutorServiceConfig, path: string) {
  return `${config.baseURL}/${path.replace(/^\/+/, "")}`;
}

export function localServiceHeaders(config: TutorServiceConfig, extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    ...(extra || {}),
  };
}

export function tutorErrorResponse(error: unknown, fallbackCode: string, fallbackStatus = 500): Response {
  const errorId = createTutorErrorId(error instanceof TutorServiceError ? error.service : undefined);
  const details = getErrorMessage(error);
  if (error instanceof TutorServiceError) {
    const body: Record<string, unknown> = {
      error: error.code,
      message: TUTOR_USER_MESSAGE,
      service: error.service,
      errorId,
    };
    if (process.env.TUTOR_EXPOSE_ERROR_DETAILS === "1") body.adminDetails = { details };

    console.warn("[tutor] Tutor service configuration failed", {
      errorId,
      code: error.code,
      service: error.service,
      details,
    });
    return Response.json(body, { status: error.status });
  }

  const body: Record<string, unknown> = {
    error: fallbackCode,
    message: TUTOR_USER_MESSAGE,
    errorId,
  };
  if (process.env.TUTOR_EXPOSE_ERROR_DETAILS === "1") body.adminDetails = { details };

  console.error("[tutor] Tutor API failed", {
    errorId,
    code: fallbackCode,
    details,
  });
  return Response.json(
    body,
    { status: fallbackStatus }
  );
}

export function localServiceErrorResponse(config: TutorServiceConfig, error: unknown): Response {
  const errorId = createTutorErrorId(config.service);
  const details = getErrorMessage(error);
  const body: Record<string, unknown> = {
    error: "local_service_unavailable",
    message: LOCAL_SERVICE_USER_MESSAGES[config.service],
    service: config.service,
    errorId,
  };
  if (process.env.TUTOR_EXPOSE_ERROR_DETAILS === "1") {
    body.adminDetails = {
      baseURL: config.baseURL,
      details,
    };
  }

  console.warn("[tutor] Local service failed", {
    errorId,
    service: config.service,
    label: config.label,
    baseURL: config.baseURL,
    details,
  });
  return Response.json(
    body,
    { status: 503 }
  );
}

export function parseTutorJson(raw: string) {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      reply: getString(parsed.reply),
      mine: getString(parsed.mine),
      rewrite: getString(parsed.rewrite),
      note: getString(parsed.note) || getString(parsed.explanation),
    };
  } catch {
    return {
      reply: cleaned,
      mine: "",
      rewrite: "",
      note: "",
    };
  }
}

export function extractText(result: unknown) {
  if (typeof result === "string") return result;
  const record = asRecord(result);
  return record ? getString(record.text) : "";
}

export function extractWordTimings(result: unknown): WordTiming[] {
  const record = asRecord(result);
  if (!record) return [];

  const directWords = parseWordArray(record.words);
  if (directWords.length) return directWords;

  const segmentWords = Array.isArray(record.segments)
    ? record.segments.flatMap((segment) => {
        const segmentRecord = asRecord(segment);
        return segmentRecord ? parseWordArray(segmentRecord.words) : [];
      })
    : [];
  if (segmentWords.length) return segmentWords;

  if (Array.isArray(record.chunks)) {
    const chunkWords: WordTiming[] = [];
    for (const chunk of record.chunks) {
      const chunkRecord = asRecord(chunk);
      if (!chunkRecord) continue;
      const timestamp = Array.isArray(chunkRecord.timestamp) ? chunkRecord.timestamp : [];
      const word = getString(chunkRecord.text).trim();
      if (!word) continue;
      chunkWords.push({
        word,
        start: getNumber(timestamp[0]),
        end: getNumber(timestamp[1]),
      });
    }
    return chunkWords;
  }

  return [];
}

export function computeSpeechMetrics(words: WordTiming[]): SpeechMetrics | null {
  const timedWords = words.filter(
    (word) => typeof word.start === "number" && typeof word.end === "number"
  );
  if (timedWords.length < 2) return words.length ? { wordCount: words.length } : null;

  const firstStart = timedWords[0].start || 0;
  const lastEnd = timedWords[timedWords.length - 1].end || firstStart;
  const durationSeconds = Math.max(0, lastEnd - firstStart);
  const pauses: number[] = [];

  for (let index = 1; index < timedWords.length; index += 1) {
    const previousEnd = timedWords[index - 1].end;
    const currentStart = timedWords[index].start;
    if (typeof previousEnd !== "number" || typeof currentStart !== "number") continue;
    const gap = currentStart - previousEnd;
    if (gap >= 0.65) pauses.push(gap);
  }

  return {
    wordCount: words.length,
    durationSeconds: roundMetric(durationSeconds),
    wordsPerMinute: durationSeconds > 0 ? roundMetric(timedWords.length / (durationSeconds / 60)) : undefined,
    pauseCount: pauses.length,
    longestPauseSeconds: pauses.length ? roundMetric(Math.max(...pauses)) : undefined,
  };
}

function parseWordArray(value: unknown): WordTiming[] {
  if (!Array.isArray(value)) return [];
  const words: WordTiming[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const word = (getString(record.word) || getString(record.text)).trim();
    if (!word) continue;
    words.push({
      word,
      start: getNumber(record.start),
      end: getNumber(record.end),
    });
  }
  return words;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function getNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function createTutorErrorId(service?: TutorService) {
  const random =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ||
    Math.random().toString(36).slice(2, 10);
  return `tutor-${service || "api"}-${Date.now().toString(36)}-${random}`;
}

function roundMetric(value: number) {
  return Math.round(value * 10) / 10;
}
