/* CHANGE NOTE
Why: Make tutor chat local-only
What changed: Refined tutor behavior prompt, separated learner-preserving mine text from fuller rewrites, and repair-mandated missing practice text for long turns
Behaviour/Assumptions: LOCAL_CHAT_BASE_URL points to an accessible chat server and feedback must match the current learner utterance
Rollback: git checkout -- src/app/api/tutor/chat/route.ts
- mj
*/

import {
  localServiceHeaders,
  localServiceErrorResponse,
  localServiceUrl,
  parseTutorJson,
  resolveLocalServiceConfig,
  tutorErrorResponse,
  type SpeechMetrics,
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
      "You are a warm English speaking tutor and conversation partner for adult learners.",
      "Primary goal: keep the conversation natural, useful, and confidence-building while noticing recurring grammar and phrasing patterns over time.",
      "Reply policy: write only the tutor's conversational response in reply. Keep it 1-3 short sentences, always in English, and include one natural follow-up question unless the learner asked for something else.",
      "Do not mention corrections inside reply unless the learner asks. Learner-facing study text belongs only in mine, rewrite, and note.",
      "Correction scope: the only text eligible for mine/rewrite/note is the learner's newest utterance.",
      "Conversation history, profile memory, interview questions, reference materials, and previous corrections are context only. Do not rewrite them as if they were the learner's newest utterance.",
      "If a past mistake appears again in the newest utterance, correct it again in mine and briefly explain the pattern in note.",
      "If the newest utterance is already natural enough, mine may be a lightly cleaned version and rewrite/note may be empty.",
      "For long learner turns with clear awkward phrasing, repeated fillers, tense errors, or unnatural collocations, still return mine and note; do not skip learner-facing feedback just because the meaning is understandable.",
      "Catch clear errors even when meaning is understandable, especially grammar, prepositions, articles, possessives, tense, plurality, word choice, collocations, and awkward phrasing that would sound unnatural in conversation.",
      "Do not overcorrect personal style, accent, informal spoken fillers, or acceptable casual grammar unless it blocks clarity or sounds clearly unnatural.",
      "Mine policy: set mine to the learner's own completed thought, corrected into grammatical and natural English while preserving the original sentence's meaning, order, concrete details, and personal voice as much as possible.",
      "Mine is not a free rewrite. Do not simplify away details, change the speaker's perspective, or reorganize the answer into a new composition. Remove fillers, repeated fragments, false starts, and STT clutter; fix grammar, collocations, word choice, articles, prepositions, tense, and sentence boundaries.",
      "Treat repeated filler words, hesitation phrases, and false starts as cleanup targets when they make the learner's spoken sentence hard to practice.",
      "Be careful with ASR-like modal or negation artifacts around filler words such as 'can/can't like'. Do not create a correction that reverses the learner's likely intended meaning. In a sports celebration context, 'they can't like celebrate themselves with food' is likely meant as 'they can celebrate with some food' unless the learner clearly means they are unable to celebrate.",
      "In sports tournament contexts, awkward phrases like 'get processed', 'get promoted', or 'go up' usually mean 'advance to the next stage' or 'make it to the next round', not 'be scheduled'.",
      "Do not use 'promoted' for World Cup or tournament advancement unless the source is explicitly about league promotion.",
      "Note policy: set note to a concise learner-facing explanation of why mine changed. Mention the most useful grammar, word-choice, or fluency pattern in one short sentence, or up to three concise sentences for long turns. Do not output a separate correction list.",
      "Rewrite policy: set rewrite to a freer, clearer, natural version of what the learner was trying to say. Rewrite can reorganize the answer and choose easier/more idiomatic wording, but it must preserve the learner's intended meaning and concrete details.",
      "For spoken learner turns over about 35 meaningful words, if mine or note makes meaningful changes, rewrite is required. Do not leave rewrite empty just because mine already exists.",
      "The rewrite must preserve all distinct ideas, examples, reasons, places, events, and relationships from the newest learner utterance. Do not summarize by dropping details.",
      "Remove unnecessary fillers, repeated fragments, and hesitation words in rewrite, while keeping the learner's intended meaning and personal voice.",
      "Drop empty conversational openers such as 'I don't know' when they do not add real meaning.",
      "Preserve the learner's team-identification perspective. If the learner uses we/us/our for their team, keep we/us/our in mine and rewrite instead of changing it to they/them.",
      "For long learner turns, rewrite should usually be 2-5 natural sentences, or two short paragraphs when the answer has two clear parts. It should read like a polished transcript/study-pack answer, not a short gist.",
      "For long learner turns, rewrite should normally keep 55-100% of the meaningful source length after filler removal. Never compress several concrete ideas into one generic sentence.",
      "Never put the tutor reply, praise, or a follow-up question in rewrite. Otherwise leave it empty.",
      'Return only valid JSON with keys "reply", "mine", "rewrite", and "note". Do not include correction arrays, Markdown, or prose outside JSON.',
    ];
    const profilePrompt = buildLearnerProfilePrompt(learnerProfile);
    if (profilePrompt) {
      parts.push(profilePrompt);
      parts.push("Use durable learning memory quietly as background evidence for recurring patterns. If the newest utterance repeats a remembered pattern, correct it again as a current-utterance fix. Memory must never appear as a visible topic, daily focus, drill, correction source, or copied phrase.");
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
    const json = parseTutorJson(raw);
    const displayReply = cleanFeedback(json.reply, 1200);
    let feedback = sanitizeTutorFeedback(json, message, displayReply);
    if (shouldRepairMine(message, feedback)) {
      const repaired = await requestMineRepair(serviceConfig, message, displayReply, feedback);
      if (repaired.mine) feedback = { ...feedback, mine: repaired.mine, note: repaired.note || feedback.note };
    }
    if (shouldRepairRewrite(message, feedback)) {
      const repairedRewrite = await requestRewriteRepair(serviceConfig, message, displayReply, feedback);
      if (repairedRewrite) feedback = { ...feedback, rewrite: repairedRewrite };
    }
    if (!feedback.mine) feedback = { ...feedback, mine: fallbackMine(message) };
    const updatedProfile = profileId
      ? await updateLearnerPractice(profileId, {
          userMessage: message,
          assistantReply: displayReply,
          mine: feedback.mine,
          rewrite: feedback.rewrite,
          note: feedback.note,
          speechMetrics,
        })
      : null;
    return Response.json({
      reply: displayReply,
      mine: feedback.mine,
      rewrite: feedback.rewrite,
      note: feedback.note,
      learnerProfile: updatedProfile,
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
  mine: string;
  rewrite: string;
  note: string;
};

function sanitizeTutorFeedback(json: Partial<TutorFeedback>, userMessage: string, displayReply: string): TutorFeedback {
  const mine = cleanLearnerMine(json.mine, userMessage, displayReply);
  const rewrite = cleanLearnerRewrite(json.rewrite, userMessage, displayReply);
  const hasFeedback = Boolean(mine || rewrite);

  return {
    mine,
    rewrite,
    note: hasFeedback ? cleanFeedback(json.note, 700) : "",
  };
}

function cleanLearnerMine(value: unknown, userMessage: string, displayReply: string) {
  const mine = normalizeSportsTournamentTerms(cleanFeedback(value, 2500), userMessage);
  if (!mine || isNoCorrectionText(mine)) return "";
  if (isTutorReplyLike(mine, userMessage, displayReply)) return "";
  if (!isTextRelatedToCurrentMessage(userMessage, mine)) return "";
  if (isMineTooCompressed(userMessage, mine)) return "";
  return mine;
}

function cleanLearnerRewrite(value: unknown, userMessage: string, displayReply: string) {
  const rewrite = normalizeSportsTournamentTerms(cleanFeedback(value, 2000), userMessage);
  if (!rewrite || isNoCorrectionText(rewrite)) return "";
  if (isTutorReplyLike(rewrite, userMessage, displayReply)) return "";
  if (rewrite.includes("?")) return "";
  if (!isTextRelatedToCurrentMessage(userMessage, rewrite)) return "";
  if (isRewriteTooCompressed(userMessage, rewrite)) return "";
  return rewrite;
}

function shouldRepairRewrite(userMessage: string, feedback: TutorFeedback) {
  const sourceWords = countMeaningfulWords(stripSpokenDisfluencies(userMessage));
  if (sourceWords < 35) return false;
  const mineDiffers = Boolean(feedback.mine && normalizeText(feedback.mine) !== normalizeText(fallbackMine(userMessage)));
  const hasFeedbackSignal = mineDiffers || Boolean(feedback.note) || hasSpokenDisfluency(userMessage);
  if (!hasFeedbackSignal) return false;
  return !feedback.rewrite || sourceWords >= 70;
}

function shouldRepairMine(userMessage: string, feedback: TutorFeedback) {
  const source = stripSpokenDisfluencies(userMessage);
  const sourceWords = countMeaningfulWords(source);
  if (sourceWords < 12) return false;
  if (!feedback.mine) return sourceWords >= 25 || hasSpokenDisfluency(userMessage);
  if (isMineTooCompressed(userMessage, feedback.mine)) return true;
  if (hasSpokenDisfluency(feedback.mine)) return true;
  if (
    hasSpokenDisfluency(userMessage) &&
    normalizeText(feedback.mine) === normalizeText(userMessage)
  ) {
    return true;
  }
  return false;
}

async function requestMineRepair(
  config: ReturnType<typeof resolveLocalServiceConfig>,
  userMessage: string,
  displayReply: string,
  feedback: TutorFeedback
) {
  try {
    const mineSource = normalizeLikelySttArtifacts(userMessage);
    const completion = await requestChatCompletion(config, {
      model: config.model,
      messages: [
        {
          role: "system",
          content: [
            "You are an English speaking coach editing one messy spoken learner transcript.",
            'Return only valid JSON with exactly this shape: {"mine":"...","note":"..."}',
            "Write mine as the learner's own completed thought corrected into grammatical, natural English.",
            "Mine is not a free rewrite. Preserve the learner's original meaning, order, concrete details, and personal voice as much as possible.",
            "Remove fillers, repeated fragments, false starts, and STT clutter. Fix grammar, articles, prepositions, tense, sentence boundaries, word choice, and collocations.",
            "Do not simplify away details, add new ideas, add tutor praise, add advice, or ask a follow-up question.",
            "Preserve first-person/team perspective. If the learner uses we/us/our for their team, keep that perspective.",
            "Recover likely intended meaning from messy STT and fillers. In sports-win contexts, 'they can't like celebrate themselves with food' is often intended as 'they can celebrate with food' unless the surrounding context clearly says they cannot.",
            "In sports tournament contexts, awkward phrases like 'get processed', 'get promoted', or 'go up' usually mean 'advance to the next stage' or 'make it to the next round', not 'be scheduled'.",
            "Do not use 'promoted' for World Cup or tournament advancement unless the source is explicitly about league promotion.",
            "For long sources, mine may be shorter after removing filler, but it must keep every meaningful point.",
            "Write note as one short learner-facing explanation of the most useful grammar, word-choice, or fluency changes.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "Learner transcript to correct as mine:",
            mineSource,
            mineSource !== userMessage ? `\nRaw transcript before obvious STT cleanup:\n${userMessage}` : "",
            "",
            "Previous mine candidate to improve:",
            feedback.mine || "(none)",
            "",
            "Previous note candidate:",
            feedback.note || "(none)",
            "",
            "Tutor reply to avoid copying:",
            displayReply || "(none)",
          ].join("\n"),
        },
      ],
      response_format: { type: "json_object" },
      stream: false,
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const json = parseTutorJson(raw);
    return {
      mine: cleanLearnerMine(json.mine, userMessage, displayReply),
      note: cleanFeedback(json.note, 700),
    };
  } catch (error) {
    console.warn("[tutor] Mine repair skipped:", error);
    return { mine: "", note: "" };
  }
}

async function requestRewriteRepair(
  config: ReturnType<typeof resolveLocalServiceConfig>,
  userMessage: string,
  displayReply: string,
  feedback: TutorFeedback
) {
  try {
    const rewriteSource = normalizeLikelySttArtifacts(userMessage);
    const completion = await requestChatCompletion(config, {
      model: config.model,
      messages: [
        {
          role: "system",
          content: [
            "You are an English speaking coach rewriting one messy spoken learner transcript.",
            'Return only valid JSON with exactly this shape: {"rewrite":"..."}',
            "Write a polished first-person version of the learner's newest answer only.",
            "Preserve every concrete idea, example, reason, place, event, prediction, and relationship from the source. Do not summarize by dropping details.",
            "Recover the learner's likely intended meaning from messy STT and fillers. If a filler-heavy phrase creates an accidental negation or contradiction, use the surrounding context to choose the intended positive or negative meaning.",
            "In sports-win contexts, a fragment like 'they can't like celebrate themselves with food' is often a messy version of 'they can celebrate with food' unless the learner clearly says they are unable to celebrate.",
            "In sports tournament contexts, awkward phrases like 'get processed', 'get promoted', or 'go up' usually mean 'advance to the next stage' or 'make it to the next round', not 'be scheduled'.",
            "Do not use 'promoted' for World Cup or tournament advancement unless the source is explicitly about league promotion.",
            "The previous mine/note candidates are hints, not authorities. Ignore anything that reverses the intended meaning or conflicts with the surrounding context.",
            "Remove fillers, repeated fragments, false starts, and hesitation words while keeping the learner's intended meaning and personal voice.",
            "Drop empty conversational openers such as 'I don't know' when they do not add real meaning.",
            "Preserve the learner's team-identification perspective. If the learner uses we/us/our for their team, keep we/us/our in the rewrite instead of changing it to they/them.",
            "Prefer natural spoken English that the learner can say aloud. Keep concrete details such as food, location, host country, next opponent, worry about losing, and trying hard when they appear in the source.",
            "For source turns over about 50 words, use 2-5 natural sentences and normally keep 55-100% of the meaningful source length after filler removal.",
            "Do not add tutor praise, a tutor reply, advice, or a follow-up question.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "Learner transcript for rewriting:",
            rewriteSource,
            rewriteSource !== userMessage ? `\nRaw transcript before obvious STT cleanup:\n${userMessage}` : "",
            "",
            "Previous mine candidate:",
            feedback.mine || "(none)",
            "",
            "Previous note candidate:",
            feedback.note || "(none)",
            "",
            "Tutor reply to avoid copying:",
            displayReply || "(none)",
          ].join("\n"),
        },
      ],
      response_format: { type: "json_object" },
      stream: false,
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const json = parseTutorJson(raw);
    return cleanLearnerRewrite(json.rewrite, userMessage, displayReply);
  } catch (error) {
    console.warn("[tutor] Rewrite repair skipped:", error);
    return "";
  }
}

function isTextRelatedToCurrentMessage(userMessage: string, candidate: string) {
  const userWords = significantWords(userMessage);
  const candidateWords = significantWords(candidate);
  if (userWords.length < 4 || candidateWords.length < 4) return true;
  const overlap = candidateWords.filter((word) => userWords.includes(word)).length / candidateWords.length;
  return overlap >= 0.25;
}

function isRewriteTooCompressed(userMessage: string, candidate: string) {
  const sourceWords = countMeaningfulWords(stripSpokenDisfluencies(userMessage));
  const rewriteWords = countMeaningfulWords(candidate);
  if (sourceWords < 45) return false;
  if (rewriteWords >= Math.max(32, Math.floor(sourceWords * 0.55))) return false;

  const sourceTerms = uniqueSignificantWords(stripSpokenDisfluencies(userMessage));
  const rewriteTerms = uniqueSignificantWords(candidate);
  if (sourceTerms.length < 8) return false;
  const covered = sourceTerms.filter((word) => rewriteTerms.includes(word)).length / sourceTerms.length;
  return covered < 0.62;
}

function isMineTooCompressed(userMessage: string, candidate: string) {
  const sourceWords = countMeaningfulWords(stripSpokenDisfluencies(userMessage));
  const mineWords = countMeaningfulWords(candidate);
  if (sourceWords < 45) return false;
  if (mineWords >= Math.max(36, Math.floor(sourceWords * 0.5))) return false;

  const sourceTerms = uniqueSignificantWords(stripSpokenDisfluencies(userMessage));
  const mineTerms = uniqueSignificantWords(candidate);
  if (sourceTerms.length < 8) return false;
  const covered = sourceTerms.filter((word) => mineTerms.includes(word)).length / sourceTerms.length;
  return covered < 0.52;
}

function hasSpokenDisfluency(value: string) {
  return (
    /\b(?:um+|uh+|er+|ah+|you know|i mean)\b/i.test(value) ||
    /,\s*like\b|\blike\s*,|\b(?:just|basically|actually|so|but|and|or|can|can't|could|would|should|to)\s+like\b/i.test(value) ||
    /\b(\w+(?:'\w+)?)(?:[\s,]+\1\b)+/i.test(value)
  );
}

function normalizeLikelySttArtifacts(value: string) {
  return value.replace(/\bthey\s+can(?:not|'t)\s+like\s+celebrate\s+themselves\b/gi, "they can celebrate");
}

function normalizeSportsTournamentTerms(value: string, source: string) {
  if (!value || !isSportsTournamentContext(source)) return value;
  return value
    .replace(/\bget\s+processed\b/gi, "advance")
    .replace(/\bgets\s+processed\b/gi, "advances")
    .replace(/\bgot\s+processed\b/gi, "advanced")
    .replace(/\bgetting\s+processed\b/gi, "advancing")
    .replace(/\bget\s+promoted\b/gi, "advance")
    .replace(/\bgets\s+promoted\b/gi, "advances")
    .replace(/\bgot\s+promoted\b/gi, "advanced")
    .replace(/\bgetting\s+promoted\b/gi, "advancing");
}

function isSportsTournamentContext(value: string) {
  return (
    /\b(world cup|tournament|group stage|host country|next game|match|football|soccer)\b/i.test(value) &&
    /\b(korea|mexico|canada|usa|team|game|round|stage|advance|processed|promoted|go up)\b/i.test(value)
  );
}

function isTutorReplyLike(candidate: string, userMessage: string, displayReply: string) {
  const normalizedCandidate = normalizeText(candidate);
  const normalizedReply = normalizeText(displayReply);
  if (normalizedReply && (normalizedReply === normalizedCandidate || normalizedReply.includes(normalizedCandidate))) return true;
  if (/^(hi|hello|nice to meet|that sounds|that makes|that moment|sounds great|great|sure|of course|ah[, ]|oh[, ]|okay|ok|here('|’)s)\b/i.test(candidate)) return true;
  if (candidate.includes("?") && /\b(what|how|any|would you|do you|want to|share|tell me)\b/i.test(candidate)) return true;

  const userWords = significantWords(userMessage);
  const candidateWords = significantWords(candidate);
  if (userWords.length >= 4 && candidateWords.length >= 4) {
    const overlap = candidateWords.filter((word) => userWords.includes(word)).length / candidateWords.length;
    if (overlap < 0.2 && candidate.includes("?")) return true;
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

function stripSpokenDisfluencies(value: string) {
  return value
    .replace(/\b(?:um+|uh+|er+|ah+)\b[,.]?\s*/gi, "")
    .replace(/\b(?:you know|i mean)\b[,.]?\s*/gi, "")
    .replace(/\b(\w+(?:'\w+)?)(?:[\s,]+\1\b)+/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackMine(value: string) {
  return stripSpokenDisfluencies(value);
}

function countMeaningfulWords(value: string) {
  return value.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length || 0;
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\w\s']/g, "").replace(/\s+/g, " ").trim();
}

function significantWords(value: string) {
  const stop = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "is", "are", "am", "i", "you", "it", "this", "that"]);
  return normalizeText(value).split(" ").filter((word) => word.length > 2 && !stop.has(word));
}

function uniqueSignificantWords(value: string) {
  return Array.from(new Set(significantWords(value)));
}
