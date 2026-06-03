/* CHANGE NOTE
Why: Remove hosted API fallback from the tutor and make local services the only runtime
What changed: Centralized local service config, endpoint helpers, error formatting, tutor JSON/fix parsing, and speech timing helpers
Behaviour/Assumptions: Every tutor service requires a local base URL
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

export type TutorFix = {
  original: string;
  corrected: string;
  note: string;
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
  if (error instanceof TutorServiceError) {
    return Response.json(
      {
        error: error.code,
        message: error.message,
        service: error.service,
      },
      { status: error.status }
    );
  }

  console.error(error);
  return Response.json(
    {
      error: fallbackCode,
      message: "The tutor service failed. Please try again.",
      details: getErrorMessage(error),
    },
    { status: fallbackStatus }
  );
}

export function localServiceErrorResponse(config: TutorServiceConfig, error: unknown): Response {
  console.warn(`[tutor] Local ${config.label} failed: ${getErrorMessage(error)}`);
  return Response.json(
    {
      error: "local_service_unavailable",
      message: `Local ${config.label} is not reachable at ${config.baseURL}. Start the local service and try again.`,
      service: config.service,
      details: getErrorMessage(error),
    },
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
      fixes: parseTutorFixes(parsed.fixes),
      correction: getString(parsed.correction),
      rewrite: getString(parsed.rewrite),
      explanation: getString(parsed.explanation),
      followUp: getString(parsed.followUp),
      fluencyFeedback: getString(parsed.fluencyFeedback),
      targetPhraseFeedback: getString(parsed.targetPhraseFeedback),
    };
  } catch {
    return {
      reply: cleaned,
      fixes: [],
      correction: "",
      rewrite: "",
      explanation: "",
      followUp: "",
      fluencyFeedback: "",
      targetPhraseFeedback: "",
    };
  }
}

function parseTutorFixes(value: unknown): TutorFix[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      return {
        original: getString(record.original).trim(),
        corrected: getString(record.corrected).trim(),
        note: getString(record.note).trim(),
      };
    })
    .filter((fix): fix is TutorFix => Boolean(fix?.original && fix.corrected));
}

export function buildDisplayReply(reply: string, followUp?: string) {
  const cleanReply = reply.trim();
  const cleanFollowUp = followUp?.trim() || "";
  if (!cleanFollowUp || cleanReply.includes(cleanFollowUp)) return cleanReply;
  return `${cleanReply} ${cleanFollowUp}`.trim();
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

function roundMetric(value: number) {
  return Math.round(value * 10) / 10;
}
