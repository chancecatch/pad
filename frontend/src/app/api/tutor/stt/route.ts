/* CHANGE NOTE
Why: Make tutor speech recognition local-only
What changed: Removed SDK/provider fallback and added client input-level checks before accepting STT output
Behaviour/Assumptions: LOCAL_STT_BASE_URL points to a multipart transcription endpoint; browser silence should not become tutor text
Rollback: git checkout -- src/app/api/tutor/stt/route.ts
- mj
*/

import {
  computeSpeechMetrics,
  extractText,
  extractWordTimings,
  localServiceHeaders,
  localServiceErrorResponse,
  localServiceUrl,
  resolveLocalServiceConfig,
  tutorErrorResponse,
} from "@/lib/tutorProviders";

export async function POST(req: Request) {
  let serviceConfig: ReturnType<typeof resolveLocalServiceConfig> | null = null;

  try {
    const formData = await req.formData();
    const file = formData.get("audio");

    if (!(file instanceof File)) {
      return Response.json({ error: "audio file missing" }, { status: 400 });
    }

    const clientMaxInputLevel = parseClientMaxInputLevel(formData.get("clientMaxInputLevel"));
    serviceConfig = resolveLocalServiceConfig("stt");
    const tr = await createTranscription(serviceConfig, file);

    const text = extractText(tr);
    const words = extractWordTimings(tr);
    const qualityError = validateTranscription(text, tr, clientMaxInputLevel);
    if (qualityError) {
      return Response.json(
        {
          error: "speech_not_clear",
          message: qualityError,
          text,
          words,
          speechMetrics: computeSpeechMetrics(words),
          clientMaxInputLevel,
          service: serviceConfig.service,
        },
        { status: 422 }
      );
    }
    const speechMetrics = computeSpeechMetrics(words);
    return Response.json({ text, words, speechMetrics, clientMaxInputLevel, service: serviceConfig.service });
  } catch (e) {
    if (serviceConfig) return localServiceErrorResponse(serviceConfig, e);
    return tutorErrorResponse(e, "stt_failed");
  }
}

async function createTranscription(
  config: ReturnType<typeof resolveLocalServiceConfig>,
  file: File
) {
  const form = new FormData();
  form.append("model", config.model);
  form.append("file", file, file.name || "speech.webm");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("language", process.env.LOCAL_STT_LANGUAGE || "en");

  const response = await fetch(localServiceUrl(config, "/audio/transcriptions"), {
    method: "POST",
    headers: localServiceHeaders(config),
    body: form,
  });

  if (!response.ok) {
    const retryForm = new FormData();
    retryForm.append("model", config.model);
    retryForm.append("file", file, file.name || "speech.webm");
    retryForm.append("language", process.env.LOCAL_STT_LANGUAGE || "en");
    const retryResponse = await fetch(localServiceUrl(config, "/audio/transcriptions"), {
      method: "POST",
      headers: localServiceHeaders(config),
      body: retryForm,
    });
    if (!retryResponse.ok) throw await localResponseError(retryResponse, file);
    return retryResponse.json();
  }

  return response.json();
}

async function localResponseError(response: Response, file: File) {
  const text = await response.text();
  const fileContext = `file=${file.name || "speech.webm"} type=${file.type || "unknown"} size=${file.size}`;
  return new Error(`Local speech recognition returned ${response.status}: ${text.slice(0, 500)} (${fileContext})`);
}

function validateTranscription(text: string, result: unknown, clientMaxInputLevel?: number) {
  const normalized = text.toLowerCase().replace(/[^\w\s']/g, "").replace(/\s+/g, " ").trim();
  const record = asRecord(result);
  const words = extractWordTimings(result);
  const wordProbabilities = collectWordProbabilities(record, words);
  const averageWordProbability =
    wordProbabilities.length > 0
      ? wordProbabilities.reduce((sum, value) => sum + value, 0) / wordProbabilities.length
      : undefined;
  const noSpeechProbability = getMaxSegmentNumber(record, "no_speech_prob");
  const averageLogProbability = getMinSegmentNumber(record, "avg_logprob");

  if (typeof clientMaxInputLevel === "number" && clientMaxInputLevel < 0.002) {
    return "The browser recorded almost no microphone signal. Check the macOS input source or browser microphone permission and try again.";
  }

  if (!normalized) return "I could not hear anything clearly. Please try recording again.";

  const likelySilenceHallucinations = new Set([
    "thank you",
    "thanks",
    "thanks for watching",
    "thank you for watching",
  ]);

  if (
    likelySilenceHallucinations.has(normalized) &&
    ((typeof averageWordProbability === "number" && averageWordProbability < 0.75) ||
      (typeof noSpeechProbability === "number" && noSpeechProbability > 0.05) ||
      (typeof averageLogProbability === "number" && averageLogProbability < -0.45))
  ) {
    return "I only heard silence or background noise. Check the macOS input source or browser microphone permission and try again.";
  }

  if (typeof noSpeechProbability === "number" && noSpeechProbability > 0.65) {
    return "I could not hear speech clearly. Please try recording again.";
  }

  if (wordProbabilities.length > 0 && typeof averageWordProbability === "number" && averageWordProbability < 0.45) {
    return "The speech recognition confidence was too low. Please try recording again.";
  }

  return "";
}

function collectWordProbabilities(record: Record<string, unknown> | null, fallbackWords: unknown[]) {
  const probabilities: number[] = [];
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const itemRecord = asRecord(item);
      const probability = getNumber(itemRecord?.probability);
      if (typeof probability === "number") probabilities.push(probability);
    }
  };

  collect(record?.words);
  if (Array.isArray(record?.segments)) {
    for (const segment of record.segments) {
      collect(asRecord(segment)?.words);
    }
  }

  if (!probabilities.length && fallbackWords.length) {
    return [];
  }
  return probabilities;
}

function getMaxSegmentNumber(record: Record<string, unknown> | null, key: string) {
  if (!record) return undefined;
  const direct = getNumber(record[key]);
  const values = typeof direct === "number" ? [direct] : [];
  if (Array.isArray(record.segments)) {
    for (const segment of record.segments) {
      const value = getNumber(asRecord(segment)?.[key]);
      if (typeof value === "number") values.push(value);
    }
  }
  return values.length ? Math.max(...values) : undefined;
}

function getMinSegmentNumber(record: Record<string, unknown> | null, key: string) {
  if (!record) return undefined;
  const direct = getNumber(record[key]);
  const values = typeof direct === "number" ? [direct] : [];
  if (Array.isArray(record.segments)) {
    for (const segment of record.segments) {
      const value = getNumber(asRecord(segment)?.[key]);
      if (typeof value === "number") values.push(value);
    }
  }
  return values.length ? Math.min(...values) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseClientMaxInputLevel(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
