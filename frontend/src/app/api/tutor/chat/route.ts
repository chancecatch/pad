/* CHANGE NOTE
Why: Make tutor chat local-only
What changed: Switched visible feedback to validated fix pairs and kept full rewrites as optional memory
Behaviour/Assumptions: LOCAL_CHAT_BASE_URL points to an accessible chat server and fixes must match the current learner utterance
Rollback: git checkout -- src/app/api/tutor/chat/route.ts
- mj
*/

import {
  buildDisplayReply,
  localServiceHeaders,
  localServiceErrorResponse,
  localServiceUrl,
  parseTutorJson,
  resolveLocalServiceConfig,
  tutorErrorResponse,
  type SpeechMetrics,
  type TutorFix,
} from "@/lib/tutorProviders";
import { resolveBackendBase } from "@/lib/backendProxy";

type Turn = { role: "user" | "assistant"; content: string };
type LearnerProfile = {
  _id?: string;
  displayName?: string;
  level?: string;
  learningGoal?: string;
  interests?: string[];
  memory?: {
    summary?: string;
    recurringErrors?: string[];
    usefulPhrases?: string[];
    recentTopics?: string[];
    lastFeedback?: string[];
    levelEvidence?: string[];
    learningInsights?: Array<{
      text?: string;
      example?: string;
      strength?: number;
      evidenceCount?: number;
      lastSeenAt?: string;
    }>;
    episodicNotes?: Array<{
      text?: string;
      salience?: number;
      expiresAt?: string;
      lastSeenAt?: string;
    }>;
    estimatedLevel?: string;
    turnCount?: number;
    sessionCount?: number;
  };
};
type ClientBody = {
  message: string;
  history?: Turn[];
  profileId?: string;
  learnerProfile?: LearnerProfile | null;
  persona?: string;
  scenario?: string;
  materials?: string | string[];
  level?: string;
  learner?: string;
  targetPhrases?: string[];
  speechMetrics?: SpeechMetrics | null;
};

export async function POST(req: Request) {
  let serviceConfig: ReturnType<typeof resolveLocalServiceConfig> | null = null;

  try {
    const {
      message,
      history = [],
      profileId,
      learnerProfile,
      persona,
      scenario,
      materials,
      level,
      targetPhrases = [],
      learner,
      speechMetrics,
    } = (await req.json()) as ClientBody;

    serviceConfig = resolveLocalServiceConfig("chat");

    const parts: string[] = [
      "You are an English speaking tutor and conversation partner.",
      "Keep replies short (1-3 sentences), conversational, and always in English.",
      "Always include one brief follow-up question to keep the conversation going.",
      "The learner's last utterance is the only text you may correct.",
      "Never correct or rewrite your own tutor reply, conversation history, profile memory, interview questions, or previous corrections.",
      "If the learner's utterance is already natural, set fixes to an empty array and leave correction, rewrite, explanation, fluencyFeedback, and targetPhraseFeedback empty.",
      "Do not leave fixes empty when the learner has clear grammar, preposition, article, possessive, tense, plurality, or word-choice errors, even if the meaning is understandable.",
      "Common learner fixes include: 'in this weekend' -> 'this weekend'; 'a master student' -> 'a master's student' or 'a graduate student'; 'research things' -> 'research work' or 'research tasks'.",
      "Return fixes as short before/after pairs for only the wrong parts. Do not rewrite correct parts.",
      "Each fix.original must be the shortest exact wrong phrase from the current learner utterance, not correct surrounding context or a whole paragraph.",
      "Each fix.corrected must be the corrected phrase. Each fix.note must name the pattern in 2-6 words.",
      "Keep fixes, correction, and rewrite separate from reply. The reply should react to the learner's meaning and ask the next question, not restate the corrected sentence.",
      "Keep correction as a concise semicolon-separated summary of fixes for backward compatibility, not a full paragraph.",
      "Set rewrite to one optional polished full answer for memory only. Leave it empty if the learner mostly needs local fixes.",
      "Set explanation to a very short overall note, max 8 words, naming only the main pattern. Do not write a long grammar lesson.",
      "Set fluencyFeedback only for a major speech rhythm issue; otherwise use an empty string.",
      "Set targetPhraseFeedback only if target phrases were explicitly provided; otherwise use an empty string.",
      'Return only JSON with keys "reply", "fixes", "correction", "rewrite", "explanation", "followUp", "fluencyFeedback", and "targetPhraseFeedback".',
    ];
    const profilePrompt = buildLearnerProfilePrompt(learnerProfile);
    if (profilePrompt) {
      parts.push(profilePrompt);
      parts.push("Use durable learning memory only as pattern guidance. Never copy memory text into fixes or correction.");
    }
    if (persona) parts.push(`Persona: ${persona}. Stay in character.`);
    if (learner) parts.push(`Learner persona: ${learner}. Address the learner accordingly and tailor your responses to that role.`);
    if (scenario) parts.push(`Scenario: ${scenario}. Keep the conversation aligned with it.`);
    if (level) parts.push(`Learner level: ${level}. Adjust vocabulary and complexity accordingly.`);

    // Normalize and bound target phrases for prompt hygiene
    const normalizedPhrases = (Array.isArray(targetPhrases) ? targetPhrases : [])
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean)
      .slice(0, 12);
    if (normalizedPhrases.length) parts.push(`Encourage using: ${normalizedPhrases.join(", ")}.`);

    // Normalize and truncate materials (accept string or string[])
    if (materials) {
      const MAX_MATERIAL_CHARS = 2000; // adjust as needed
      const mats = Array.isArray(materials) ? materials : [materials];
      const cleaned = mats
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean)
        .slice(0, 10); // cap sections
      let joined = cleaned.join("\\n\\n");
      if (joined.length > MAX_MATERIAL_CHARS) joined = joined.slice(0, MAX_MATERIAL_CHARS) + "…";
      if (joined) parts.push(`Reference materials (use when relevant):\\n${joined}`);
    }

    if (speechMetrics) {
      parts.push(`Speech timing metrics for the last utterance: ${JSON.stringify(speechMetrics)}.`);
    }

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: parts.join("\\n\\n") },
      ...history.filter((m) => m.role === "user" || m.role === "assistant"),
      { role: "user", content: message },
    ];

    const completion = await requestChatCompletion(serviceConfig, {
      model: serviceConfig.model,
      messages,
      response_format: { type: "json_object" },
      stream: false,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const json = recoverMisplacedCorrection(parseTutorJson(raw), message);
    const displayReply = buildDisplayReply(
      typeof json.reply === "string" ? json.reply : "",
      typeof json.followUp === "string" ? json.followUp : ""
    );
    const feedback = sanitizeTutorFeedback(json, message, displayReply, normalizedPhrases.length > 0);
    const updatedProfile = profileId
      ? await updateLearnerPractice(profileId, {
          userMessage: message,
          assistantReply: displayReply,
          correction: feedback.correction,
          fixes: feedback.fixes,
          rewrite: feedback.rewrite,
          explanation: feedback.explanation,
          fluencyFeedback: feedback.fluencyFeedback,
          targetPhraseFeedback: feedback.targetPhraseFeedback,
          speechMetrics,
        })
      : null;
    return Response.json({
      ...json,
      ...feedback,
      reply: displayReply,
      learnerProfile: updatedProfile,
      service: serviceConfig.service,
    });
  } catch (err) {
    if (serviceConfig) return localServiceErrorResponse(serviceConfig, err);
    return tutorErrorResponse(err, "chat_failed");
  }
}

type LocalChatRequest = {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  response_format?: { type: "json_object" };
  stream: false;
};

type LocalChatCompletion = {
  choices: Array<{
    message?: {
      content?: string;
    };
  }>;
};

async function requestChatCompletion(config: ReturnType<typeof resolveLocalServiceConfig>, body: LocalChatRequest) {
  const response = await fetch(localServiceUrl(config, "/chat/completions"), {
    method: "POST",
    headers: localServiceHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  if (!response.ok && body.response_format) {
    const retryResponse = await fetch(localServiceUrl(config, "/chat/completions"), {
      method: "POST",
      headers: localServiceHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify({ ...body, response_format: undefined }),
    });
    if (!retryResponse.ok) throw await localResponseError(retryResponse);
    return retryResponse.json() as Promise<LocalChatCompletion>;
  }

  if (!response.ok) throw await localResponseError(response);
  return response.json() as Promise<LocalChatCompletion>;
}

async function localResponseError(response: Response) {
  const text = await response.text();
  return new Error(`Local chat returned ${response.status}: ${text.slice(0, 500)}`);
}

function buildLearnerProfilePrompt(profile?: LearnerProfile | null) {
  if (!profile) return "";
  const memory = profile.memory || {};
  const learningInsights = (memory.learningInsights || [])
    .filter((item) => item?.text && isUsefulMemoryLine(item.text))
    .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0));
  const activeEpisodicNotes = (memory.episodicNotes || [])
    .filter((item) => item?.text && isActiveMemoryNote(item.expiresAt))
    .sort((a, b) => Number(b.salience || 0) - Number(a.salience || 0));
  const parts = [
    profile.displayName && `Name: ${profile.displayName}`,
    profile.level && `Estimated level: ${profile.level}`,
    profile.learningGoal && `Learning goal: ${profile.learningGoal}`,
    profile.interests?.length && `Interests: ${profile.interests.join(", ")}`,
    learningInsights.length && `Durable learning patterns: ${learningInsights.slice(0, 6).map(formatLearningInsight).join(" | ")}`,
    activeEpisodicNotes.length && `Soft recent memory: ${activeEpisodicNotes.slice(0, 5).map((item) => item.text).join(" | ")}`,
    memory.recentTopics?.length && `Fallback recent topics: ${memory.recentTopics.slice(0, 3).join(" | ")}`,
    memory.estimatedLevel && `Memory-estimated level: ${memory.estimatedLevel}`,
  ].filter(Boolean);
  return parts.length ? `Learner profile and tutor memory:\n${parts.join("\n")}` : "";
}

function formatLearningInsight(item: { text?: string; evidenceCount?: number }) {
  const count = item.evidenceCount ? ` (${item.evidenceCount}x)` : "";
  return `${item.text}${count}`;
}

function isActiveMemoryNote(expiresAt?: string) {
  if (!expiresAt) return true;
  const time = new Date(expiresAt).getTime();
  return !Number.isFinite(time) || time > Date.now();
}

async function updateLearnerPractice(profileId: string, payload: Record<string, unknown>) {
  try {
    const base = resolveBackendBase();
    const response = await fetch(`${base}/tutor/profiles/${profileId}/practice`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.warn(`[tutor] Learner profile update returned ${response.status}`);
      return null;
    }
    return response.json();
  } catch (error) {
    console.warn("[tutor] Learner profile update skipped:", error);
    return null;
  }
}

type TutorFeedback = {
  fixes: TutorFix[];
  correction: string;
  rewrite: string;
  explanation: string;
  fluencyFeedback: string;
  targetPhraseFeedback: string;
};

type TutorJson = Partial<TutorFeedback> & {
  reply?: string;
  followUp?: string;
  [key: string]: unknown;
};

function recoverMisplacedCorrection(json: TutorJson, userMessage: string) {
  if (json.fixes?.length || cleanFeedback(json.correction, 1200)) return json;

  const reply = cleanFeedback(json.reply, 600);
  const recovered = extractCorrectionFromReply(reply, userMessage);
  if (!recovered) return json;

  return {
    ...json,
    reply: recovered.reply,
    correction: recovered.correction,
    explanation: cleanFeedback(json.explanation, 80) || recovered.explanation,
  };
}

function extractCorrectionFromReply(reply: string, userMessage: string) {
  if (!reply) return null;
  const lastQuestion = reply.match(/[^.!?]*\?\s*$/);
  if (!lastQuestion) return null;

  const candidate = reply.slice(0, reply.length - lastQuestion[0].length).trim();
  const followUp = lastQuestion[0].trim();
  if (!candidateLikelyCorrection(userMessage, candidate)) return null;

  return {
    correction: candidate.replace(/\s+$/g, ""),
    reply: followUp || "I see. Tell me more.",
    explanation: inferCorrectionExplanation(userMessage),
  };
}

function candidateLikelyCorrection(userMessage: string, candidate: string) {
  if (!candidate || normalizeText(candidate) === normalizeText(userMessage)) return false;
  if (/^(i see|that sounds|sounds like|nice|great|ah[, ]|okay|ok)\b/i.test(candidate)) return false;

  const userWords = significantWords(userMessage);
  const candidateWords = significantWords(candidate);
  if (userWords.length < 4 || candidateWords.length < 4) return false;

  const overlap = candidateWords.filter((word) => userWords.includes(word)).length / candidateWords.length;
  return overlap >= 0.45;
}

function inferCorrectionExplanation(userMessage: string) {
  const text = normalizeText(userMessage);
  const fixes = [];
  if (text.includes("in this weekend")) fixes.push("preposition");
  if (text.includes("master student")) fixes.push("possessive title");
  if (text.includes("research things")) fixes.push("word choice");
  if (!fixes.length) return "Grammar and word choice.";
  return `${fixes.slice(0, 2).join(" and ")}.`;
}

function sanitizeTutorFeedback(json: Partial<TutorFeedback>, userMessage: string, displayReply: string, hasTargetPhrases: boolean): TutorFeedback {
  const fixes = sanitizeTutorFixes(json.fixes, userMessage);
  const correction = fixes.length ? formatFixesAsCorrection(fixes) : cleanFeedback(json.correction, 1200);
  const explanation = cleanFeedback(json.explanation, 80);
  const meaningfulCorrection = fixes.length > 0 || isMeaningfulCorrection(userMessage, correction, explanation, displayReply);

  return {
    fixes,
    correction: meaningfulCorrection ? correction : "",
    rewrite: meaningfulCorrection ? cleanFeedback(json.rewrite, 1200) : "",
    explanation: meaningfulCorrection ? trimWords(explanation || fixes[0]?.note || "", 8) : "",
    fluencyFeedback: meaningfulCorrection ? cleanFeedback(json.fluencyFeedback, 120) : "",
    targetPhraseFeedback: hasTargetPhrases && meaningfulCorrection ? cleanFeedback(json.targetPhraseFeedback, 120) : "",
  };
}

function isMeaningfulCorrection(userMessage: string, correction: string, explanation: string, displayReply = "") {
  if (!correction) return false;
  if (isNoCorrectionText(correction) || isNoCorrectionText(explanation)) return false;
  const normalizedCorrection = normalizeText(correction);
  if (!normalizedCorrection || normalizedCorrection === normalizeText(userMessage)) return false;
  if (!isCorrectionRelatedToCurrentMessage(userMessage, correction)) return false;
  if (isTutorReplyLike(correction, userMessage, displayReply)) return false;
  return true;
}

function sanitizeTutorFixes(value: unknown, userMessage: string): TutorFix[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const fixes: TutorFix[] = [];

  for (const item of value) {
    const fix = item && typeof item === "object" ? (item as Partial<TutorFix>) : null;
    if (!fix) continue;
    const original = cleanFeedback(fix.original, 220);
    const corrected = cleanFeedback(fix.corrected, 220);
    const note = trimWords(cleanFeedback(fix.note, 80), 8);
    const key = `${normalizeText(original)}->${normalizeText(corrected)}`;

    if (!original || !corrected || seen.has(key)) continue;
    if (normalizeText(original) === normalizeText(corrected)) continue;
    if (!phraseAppearsInMessage(userMessage, original)) continue;
    if (isTutorReplyLike(corrected, userMessage, "")) continue;

    seen.add(key);
    fixes.push({ original, corrected, note });
    if (fixes.length >= 5) break;
  }

  return fixes;
}

function formatFixesAsCorrection(fixes: TutorFix[]) {
  return fixes.map((fix) => `${fix.original} -> ${fix.corrected}`).join("; ");
}

function phraseAppearsInMessage(message: string, phrase: string) {
  const normalizedMessage = normalizeText(message);
  const normalizedPhrase = normalizeText(phrase);
  return Boolean(normalizedPhrase && normalizedMessage.includes(normalizedPhrase));
}

function isCorrectionRelatedToCurrentMessage(userMessage: string, correction: string) {
  const userWords = significantWords(userMessage);
  const correctionWords = significantWords(correction);
  if (userWords.length < 4 || correctionWords.length < 4) return true;
  const overlap = correctionWords.filter((word) => userWords.includes(word)).length / correctionWords.length;
  return overlap >= 0.25;
}

function isTutorReplyLike(correction: string, userMessage: string, displayReply: string) {
  const normalizedCorrection = normalizeText(correction);
  const normalizedReply = normalizeText(displayReply);
  if (normalizedReply && (normalizedReply === normalizedCorrection || normalizedReply.includes(normalizedCorrection))) return true;
  if (/^(hi|hello|nice to meet|that sounds|sounds great|great|sure|of course|ah[, ]|okay|ok)\b/i.test(correction)) return true;
  if (correction.includes("?") && /\b(what|how|any|would you|do you|want to|share|tell me)\b/i.test(correction)) return true;

  const userWords = significantWords(userMessage);
  const correctionWords = significantWords(correction);
  if (userWords.length >= 4 && correctionWords.length >= 4) {
    const overlap = correctionWords.filter((word) => userWords.includes(word)).length / correctionWords.length;
    if (overlap < 0.2 && correction.includes("?")) return true;
  }
  return false;
}

function isUsefulMemoryLine(value: string) {
  if (!value || isNoCorrectionText(value)) return false;
  return !/->\s*(hi|hello|nice to meet|that sounds|sounds great|what kind|how('|’)s|any specific)/i.test(value);
}

function isNoCorrectionText(value: string) {
  return /\b(no correction needed|already natural|no changes? needed|nothing to correct)\b/i.test(value);
}

function cleanFeedback(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function trimWords(value: string, maxWords: number) {
  const words = value.split(/\s+/).filter(Boolean);
  return words.length > maxWords ? words.slice(0, maxWords).join(" ") : value;
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\w\s']/g, "").replace(/\s+/g, " ").trim();
}

function significantWords(value: string) {
  const stop = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "is", "are", "am", "i", "you", "it", "this", "that"]);
  return normalizeText(value).split(" ").filter((word) => word.length > 2 && !stop.has(word));
}
