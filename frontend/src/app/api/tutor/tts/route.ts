/* CHANGE NOTE
Why: Make tutor speech synthesis local-only and configurable from the Tutor UI
What changed: Removed SDK/provider fallback, added voice-list proxy, and pass selected voice to local TTS with af_alloy as the default fallback
Behaviour/Assumptions: LOCAL_TTS_BASE_URL points to a speech synthesis endpoint; LOCAL_TTS_VOICE can override the default Kokoro voice
Rollback: git checkout -- src/app/api/tutor/tts/route.ts
- mj
*/

import {
  localServiceHeaders,
  localServiceErrorResponse,
  localServiceUrl,
  resolveLocalServiceConfig,
  tutorErrorResponse,
} from "@/lib/tutorProviders";

export async function POST(req: Request) {
  let serviceConfig: ReturnType<typeof resolveLocalServiceConfig> | null = null;

  try {
    const body = await req.json();
    const { text, voice = process.env.LOCAL_TTS_VOICE || "af_alloy", instructions, speed = 1 } = (body || {}) as {
      text?: string;
      voice?: string;
      instructions?: string;
      speed?: number;
    };

    if (!text || typeof text !== "string") {
      return Response.json({ error: "text_required", message: "Text is required." }, { status: 400 });
    }

    serviceConfig = resolveLocalServiceConfig("tts");
    const speech = await fetch(localServiceUrl(serviceConfig, "/audio/speech"), {
      method: "POST",
      headers: localServiceHeaders(serviceConfig, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: serviceConfig.model,
        voice,
        input: text,
        instructions,
        response_format: "mp3",
        speed,
      }),
    });

    if (!speech.ok) throw await localResponseError(speech);
    const buf = Buffer.from(await speech.arrayBuffer());
    return new Response(buf, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (serviceConfig) return localServiceErrorResponse(serviceConfig, e);
    return tutorErrorResponse(e, "tts_failed");
  }
}

export async function GET() {
  let serviceConfig: ReturnType<typeof resolveLocalServiceConfig> | null = null;

  try {
    serviceConfig = resolveLocalServiceConfig("tts");
    const response = await fetch(localServiceUrl(serviceConfig, "/audio/voices"), {
      headers: localServiceHeaders(serviceConfig),
      cache: "no-store",
    });
    if (!response.ok) throw await localResponseError(response);
    const data = await response.json();
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (serviceConfig) return localServiceErrorResponse(serviceConfig, e);
    return tutorErrorResponse(e, "tts_voices_failed");
  }
}

async function localResponseError(response: Response) {
  const text = await response.text();
  return new Error(`Local speech synthesis returned ${response.status}: ${text.slice(0, 500)}`);
}
