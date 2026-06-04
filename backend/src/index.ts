/* CHANGE NOTE
Why: Save tutor feedback and make learner memory age like a human tutor's memory
What changed: Practice updates now separate validated fix pairs, durable learning insights, expiring conversational notes, and profile-scoped recent sessions
Behaviour/Assumptions: Chat API remains backward-compatible and older noisy profile memory may exist
Rollback: git checkout -- src/index.ts
- mj
*/

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { connectDB } from "./db";
import { Note } from "./models/Note";
import { ChatSession } from "./models/Chat";
import { LearnerProfile } from "./models/LearnerProfile";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const MONGODB_URI = process.env.MONGODB_URI as string;
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:3000,https://pineatdawn.me").split(",").map((s) => s.trim());
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LEARNING_INSIGHT_LIMIT = 80;
const EPISODIC_NOTE_LIMIT = 16;
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/notes", async (_req, res) => {
  const notes = await Note.find().lean();
  res.json(notes);
});

app.post("/notes", async (req, res) => {
  try {
    const note = await Note.create(req.body);
    res.status(201).json(note);
  } catch (e) {
    res.status(400).json({ error: "invalid payload" });
  }
});

app.delete("/notes/:id", async (req, res) => {
  try {
    const result = await Note.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ error: "not_found" });
    res.status(200).json({ success: true });
  } catch (e) {
    res.status(400).json({ error: "invalid_id" });
  }
});

// List chat sessions
app.get("/chat/sessions", async (req, res) => {
  const clientId = cleanString(req.query.clientId, 120);
  const limitValue = Number(req.query.limit);
  const filter = clientId ? { clientId } : {};
  let query = ChatSession.find(filter).sort({ updatedAt: -1 });
  if (Number.isFinite(limitValue) && limitValue > 0) query = query.limit(Math.min(50, Math.floor(limitValue)));
  const list = await query.lean();
  res.json(list);
});

// Create a chat session
app.post("/chat/sessions", async (req, res) => {
  const { title, clientId } = req.body || {};
  const sess = await ChatSession.create({ title, clientId, messages: [] });
  if (clientId) {
    await LearnerProfile.findByIdAndUpdate(clientId, {
      $inc: { "memory.sessionCount": 1 },
      $set: { lastPracticedAt: new Date() },
    });
  }
  res.status(201).json(sess);
});

// Get one chat session
app.get("/chat/sessions/:id", async (req, res) => {
  const sess = await ChatSession.findById(req.params.id).lean();
  if (!sess) return res.status(404).json({ error: "not_found" });
  res.json(sess);
});

// Add a chat message
app.post("/chat/sessions/:id/messages", async (req, res) => {
  const { role, text, fixes, correction, rewrite, explanation, fluencyFeedback, targetPhraseFeedback } = req.body || {};
  if (!role || !text) return res.status(400).json({ error: "invalid_payload" });

  const sess = await ChatSession.findByIdAndUpdate(
    req.params.id,
    { $push: { messages: { role, text, fixes: cleanFixes(fixes), correction, rewrite, explanation, fluencyFeedback, targetPhraseFeedback } } },
    { new: true }
  );
  if (!sess) return res.status(404).json({ error: "not_found" });
  res.status(201).json(sess);
});

// Tutor learner profiles
app.get("/tutor/profiles", async (_req, res) => {
  const profiles = await LearnerProfile.find().sort({ updatedAt: -1 }).lean();
  res.json(profiles.map(sanitizeProfile));
});

app.post("/tutor/profiles", async (req, res) => {
  try {
    const { displayName, pin, learningGoal = "", interests = [] } = req.body || {};
    const name = normalizeDisplayName(displayName);
    if (!name) return res.status(400).json({ error: "display_name_required" });
    if (!isValidPin(pin)) return res.status(400).json({ error: "pin_must_be_4_digits" });

    const normalizedName = normalizeProfileName(name);
    const existing = await LearnerProfile.findOne({ normalizedName }).lean();
    if (existing) return res.status(409).json({ error: "profile_exists" });

    const pinSalt = crypto.randomBytes(16).toString("hex");
    const pinHash = hashPin(pin, pinSalt);
    const profile = await LearnerProfile.create({
      displayName: name,
      normalizedName,
      pinHash,
      pinSalt,
      learningGoal: cleanString(learningGoal, 240),
      interests: cleanStringArray(interests, 8, 40),
      memory: buildInitialMemory(name, learningGoal, interests),
      lastPracticedAt: new Date(),
    });

    res.status(201).json(sanitizeProfile(profile));
  } catch (error) {
    console.error("[profiles] create failed:", error);
    res.status(500).json({ error: "profile_create_failed" });
  }
});

app.post("/tutor/profiles/login", async (req, res) => {
  try {
    const { profileId, pin } = req.body || {};
    if (!profileId || !isValidPin(pin)) return res.status(400).json({ error: "invalid_login" });

    const profile = await LearnerProfile.findById(profileId);
    if (!profile || !verifyPin(pin, profile.pinSalt, profile.pinHash)) {
      return res.status(401).json({ error: "invalid_pin" });
    }

    profile.lastPracticedAt = new Date();
    await profile.save();
    res.json(sanitizeProfile(profile));
  } catch (error) {
    console.error("[profiles] login failed:", error);
    res.status(400).json({ error: "invalid_login" });
  }
});

app.patch("/tutor/profiles/:id/practice", async (req, res) => {
  try {
    const profile = await LearnerProfile.findById(req.params.id);
    if (!profile) return res.status(404).json({ error: "not_found" });

    const nextMemory = updatePracticeMemory(profile.memory || {}, req.body || {}, profile.level || "B1");
    profile.memory = nextMemory;
    profile.level = nextMemory.estimatedLevel || profile.level || "B1";
    profile.lastPracticedAt = new Date();
    await profile.save();
    res.json(sanitizeProfile(profile));
  } catch (error) {
    console.error("[profiles] practice update failed:", error);
    res.status(500).json({ error: "profile_update_failed" });
  }
});

async function start() {
  try {
    if (!MONGODB_URI) throw new Error("MONGODB_URI missing");
    await connectDB(MONGODB_URI);
    app.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("[server] failed to start:", err);
    process.exit(1);
  }
}

start();

function normalizeDisplayName(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 60) : "";
}

function normalizeProfileName(value: string) {
  return value.toLowerCase();
}

function isValidPin(value: unknown) {
  return typeof value === "string" && /^\d{4}$/.test(value);
}

function hashPin(pin: string, salt: string) {
  return crypto.pbkdf2Sync(pin, salt, 100000, 32, "sha256").toString("hex");
}

function verifyPin(pin: string, salt: string, expectedHash: string) {
  const actual = Buffer.from(hashPin(pin, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sanitizeProfile(profile: any) {
  const raw = typeof profile.toObject === "function" ? profile.toObject() : profile;
  return {
    _id: raw._id?.toString?.() ?? raw._id,
    displayName: raw.displayName,
    level: raw.level || "B1",
    learningGoal: raw.learningGoal || "",
    interests: raw.interests || [],
    memory: sanitizeMemoryForResponse(raw.memory || {}),
    lastPracticedAt: raw.lastPracticedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function sanitizeMemoryForResponse(memory: any) {
  return {
    ...memory,
    learningInsights: cleanLearningInsights(memory.learningInsights || []),
    episodicNotes: cleanEpisodicNotes(memory.episodicNotes || [], new Date()),
    recurringErrors: cleanMemoryList(memory.recurringErrors || []),
    usefulPhrases: cleanMemoryList(memory.usefulPhrases || []),
    lastFeedback: cleanMemoryList(memory.lastFeedback || []),
    levelEvidence: cleanLevelEvidence(memory.levelEvidence || []),
  };
}

function buildInitialMemory(name: string, learningGoal: unknown, interests: unknown) {
  const goal = cleanString(learningGoal, 240);
  const interestList = cleanStringArray(interests, 8, 40);
  const fragments = [`Learner name: ${name}.`];
  if (goal) fragments.push(`Learning goal: ${goal}.`);
  if (interestList.length) fragments.push(`Interests: ${interestList.join(", ")}.`);
  return {
    summary: fragments.join(" "),
    recurringErrors: [],
    usefulPhrases: [],
    recentTopics: [],
    lastFeedback: [],
    levelEvidence: [],
    learningInsights: [],
    episodicNotes: [],
    estimatedLevel: "B1",
    turnCount: 0,
    sessionCount: 0,
  };
}

function updatePracticeMemory(memory: any, payload: any, currentLevel: string) {
  const userMessage = cleanString(payload.userMessage, 320);
  const assistantReply = cleanString(payload.assistantReply, 320);
  const fixes = cleanFixes(payload.fixes);
  const correction = cleanString(payload.correction, 1200);
  const rewrite = cleanString(payload.rewrite, 1200);
  const explanation = cleanString(payload.explanation, 700);
  const fluencyFeedback = cleanString(payload.fluencyFeedback, 160);
  const targetPhraseFeedback = cleanString(payload.targetPhraseFeedback, 160);
  const fixSummary = formatFixes(fixes);
  const correctionSummary = fixSummary || correction;
  const memoryExplanation = summarizeExplanationForMemory(explanation, fixes);
  const correctionIsUseful = fixes.length > 0 || isMeaningfulCorrection(userMessage, correction, explanation, assistantReply);
  const now = new Date();

  const recurringErrors = appendCapped(
    cleanMemoryList(memory.recurringErrors || []),
    correctionIsUseful
      ? `${userMessage || "Recent utterance"} -> ${correctionSummary}${memoryExplanation ? ` (${memoryExplanation})` : ""}`
      : "",
    10
  );
  const usefulPhrases = appendCapped(cleanMemoryList(memory.usefulPhrases || []), correctionIsUseful ? rewrite : "", 10);
  const recentTopics = appendCapped(memory.recentTopics || [], userMessage, 12);
  const lastFeedback = [correctionIsUseful ? memoryExplanation : "", correctionIsUseful ? fluencyFeedback : "", correctionIsUseful ? targetPhraseFeedback : ""]
    .filter(Boolean)
    .slice(0, 6);
  const learningInsights = updateLearningInsights(memory.learningInsights || [], {
    correctionIsUseful,
    userMessage,
    correction: correctionSummary,
    fixes,
    rewrite,
    explanation: memoryExplanation,
    now,
  });
  const episodicNotes = updateEpisodicNotes(memory.episodicNotes || [], userMessage, now);
  const levelEvidence = appendCapped(
    cleanLevelEvidence(memory.levelEvidence || []),
    buildLevelEvidence(userMessage, correctionIsUseful, memoryExplanation),
    12
  );

  const next = {
    summary: "",
    recurringErrors,
    usefulPhrases,
    recentTopics,
    lastFeedback: appendManyCapped(memory.lastFeedback || [], lastFeedback, 12),
    levelEvidence,
    learningInsights,
    episodicNotes,
    estimatedLevel: "B1",
    turnCount: Number(memory.turnCount || 0) + 1,
    sessionCount: Number(memory.sessionCount || 0),
  };
  next.estimatedLevel = estimateLearnerLevel(currentLevel, next);
  next.summary = buildMemorySummary(next);
  return next;
}

function buildMemorySummary(memory: any) {
  const parts = [];
  if (memory.turnCount) parts.push(`Turns practiced: ${memory.turnCount}.`);
  if (memory.learningInsights?.length) parts.push(`Learning focus: ${memory.learningInsights.slice(0, 4).map((item: any) => item.text).filter(Boolean).join(" | ")}.`);
  if (memory.episodicNotes?.length) parts.push(`Recent context: ${memory.episodicNotes.slice(0, 4).map((item: any) => item.text).filter(Boolean).join(" | ")}.`);
  if (memory.recentTopics?.length) parts.push(`Recent topics: ${memory.recentTopics.slice(0, 3).join(" | ")}.`);
  if (memory.recurringErrors?.length) parts.push(`Recurring patterns: ${memory.recurringErrors.slice(0, 3).join(" | ")}.`);
  if (memory.usefulPhrases?.length) parts.push(`Useful alternatives: ${memory.usefulPhrases.slice(0, 3).join(" | ")}.`);
  if (memory.estimatedLevel) parts.push(`Estimated level: ${memory.estimatedLevel}.`);
  return parts.join(" ");
}

function cleanString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function cleanFixes(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const fixes = [];
  for (const item of value) {
    const fix = item && typeof item === "object" ? (item as any) : null;
    if (!fix) continue;
    const original = cleanString(fix.original, 220);
    const corrected = cleanString(fix.corrected, 220);
    const note = cleanString(fix.note, 80);
    const key = `${normalizeText(original)}->${normalizeText(corrected)}`;
    if (!original || !corrected || normalizeText(original) === normalizeText(corrected) || seen.has(key)) continue;
    seen.add(key);
    fixes.push({ original, corrected, note });
    if (fixes.length >= 5) break;
  }
  return fixes;
}

function formatFixes(fixes: Array<{ original: string; corrected: string; note?: string }>) {
  return fixes.map((fix) => `${fix.original} -> ${fix.corrected}`).join("; ");
}

function summarizeExplanationForMemory(explanation: string, fixes: Array<{ note?: string }>) {
  const notes = fixes
    .map((fix) => cleanString(fix.note, 60))
    .filter(Boolean);
  const uniqueNotes = [...new Set(notes)];
  if (uniqueNotes.length) return uniqueNotes.slice(0, 3).join(", ");
  return trimWords(explanation, 14);
}

function cleanStringArray(value: unknown, maxItems: number, maxLength: number) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return source
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function appendCapped(list: string[], item: string, maxItems: number) {
  if (!item) return list.slice(0, maxItems);
  return [item, ...list.filter((existing) => existing !== item)].slice(0, maxItems);
}

function appendManyCapped(list: string[], items: string[], maxItems: number) {
  return items.reduce((next, item) => appendCapped(next, item, maxItems), list).slice(0, maxItems);
}

function updateLearningInsights(list: any[], payload: any) {
  const existing = cleanLearningInsights(list);
  if (!payload.correctionIsUseful) return existing.slice(0, LEARNING_INSIGHT_LIMIT);

  const key = buildLearningInsightKey(payload.explanation, payload.correction);
  if (!key) return existing.slice(0, LEARNING_INSIGHT_LIMIT);

  const text = payload.explanation
    ? cleanString(payload.explanation, 80)
    : `Practice this pattern: ${cleanString(payload.correction, 120)}`;
  const example = cleanString(payload.rewrite || payload.correction || payload.userMessage, 220);
  const previous = existing.find((item) => item.key === key);
  const updated = {
    key,
    kind: "correction_pattern",
    text,
    example,
    strength: Math.min(1, Number(previous?.strength || 0.35) + 0.15),
    evidenceCount: Number(previous?.evidenceCount || 0) + 1,
    firstSeenAt: previous?.firstSeenAt || payload.now,
    lastSeenAt: payload.now,
  };

  return [updated, ...existing.filter((item) => item.key !== key)]
    .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0))
    .slice(0, LEARNING_INSIGHT_LIMIT);
}

function cleanLearningInsights(list: any[]) {
  return (Array.isArray(list) ? list : [])
    .map((item) => ({
      key: cleanString(item?.key, 120),
      kind: cleanString(item?.kind, 40) || "correction_pattern",
      text: cleanString(item?.text, 180),
      example: cleanString(item?.example, 260),
      strength: clamp(Number(item?.strength || 0.4), 0.1, 1),
      evidenceCount: Math.max(1, Number(item?.evidenceCount || 1)),
      firstSeenAt: item?.firstSeenAt,
      lastSeenAt: item?.lastSeenAt,
    }))
    .filter((item) => item.key && item.text && isUsefulMemoryLine(item.text));
}

function buildLearningInsightKey(explanation: string, correction: string) {
  const source = explanation && !isNoCorrectionText(explanation) ? explanation : correction;
  return normalizeText(cleanString(source, 120)).slice(0, 120);
}

function updateEpisodicNotes(list: any[], userMessage: string, now: Date) {
  const existing = cleanEpisodicNotes(list, now);
  const nextNote = buildEpisodicNote(userMessage, now);
  if (!nextNote) return existing.slice(0, EPISODIC_NOTE_LIMIT);

  const previous = existing.find((item) => item.key === nextNote.key);
  const merged = previous
    ? {
        ...previous,
        salience: Math.min(1, Math.max(Number(previous.salience || 0.5), nextNote.salience) + 0.05),
        lastSeenAt: now,
        expiresAt: nextNote.expiresAt,
      }
    : nextNote;

  return [merged, ...existing.filter((item) => item.key !== nextNote.key)]
    .sort((a, b) => {
      const salienceDelta = Number(b.salience || 0) - Number(a.salience || 0);
      if (Math.abs(salienceDelta) > 0.01) return salienceDelta;
      return new Date(b.lastSeenAt || b.createdAt || 0).getTime() - new Date(a.lastSeenAt || a.createdAt || 0).getTime();
    })
    .slice(0, EPISODIC_NOTE_LIMIT);
}

function cleanEpisodicNotes(list: any[], now: Date) {
  return (Array.isArray(list) ? list : [])
    .map((item) => ({
      key: cleanString(item?.key, 120),
      kind: cleanString(item?.kind, 40) || "conversation_context",
      text: cleanString(item?.text, 180),
      salience: clamp(Number(item?.salience || 0.5), 0.1, 1),
      createdAt: item?.createdAt,
      lastSeenAt: item?.lastSeenAt,
      expiresAt: item?.expiresAt,
    }))
    .filter((item) => {
      if (!item.key || !item.text || isNoCorrectionText(item.text)) return false;
      const expiresAt = item.expiresAt ? new Date(item.expiresAt).getTime() : 0;
      return !expiresAt || expiresAt > now.getTime();
    });
}

function buildEpisodicNote(userMessage: string, now: Date) {
  const text = cleanString(userMessage, 160);
  if (countWords(text) < 4 || isNoCorrectionText(text)) return null;

  const salience = scoreEpisodicSalience(text);
  const ttlDays = episodicTtlDays(text, salience);
  const noteText = `Learner mentioned: ${text}`;
  return {
    key: normalizeText(text).slice(0, 120),
    kind: "conversation_context",
    text: noteText,
    salience,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + ttlDays * MS_PER_DAY),
  };
}

function scoreEpisodicSalience(text: string) {
  if (/\b(i like|i love|i prefer|i hate|favorite|interested in|goal|want to improve|need to practice)\b/i.test(text)) return 0.85;
  if (/\b(research|project|study|student|work|lab|presentation|interview|english|french)\b/i.test(text)) return 0.7;
  if (/\b(today|yesterday|tomorrow|weekend|this week|next week|now)\b/i.test(text)) return 0.45;
  return 0.55;
}

function episodicTtlDays(text: string, salience: number) {
  if (salience >= 0.8) return 45;
  if (salience >= 0.65) return 30;
  if (/\b(today|yesterday|tomorrow|weekend|this week|next week|now)\b/i.test(text)) return 10;
  return 21;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function buildLevelEvidence(userMessage: string, correctionNeeded: boolean, explanation: string) {
  const wordCount = countWords(userMessage);
  const note = explanation ? ` note=${explanation}` : "";
  return `words=${wordCount} correction=${correctionNeeded ? "yes" : "no"}${note}`;
}

function estimateLearnerLevel(currentLevel: string, memory: any) {
  const levels = ["A2", "B1", "B2", "C1"];
  const currentIndex = Math.max(0, levels.indexOf(normalizeLevel(currentLevel)));
  const evidence = Array.isArray(memory.levelEvidence) ? memory.levelEvidence.slice(0, 10) : [];
  const turnCount = Number(memory.turnCount || 0);

  if (turnCount < 3 || evidence.length < 3) return levels[currentIndex] || "B1";

  const wordCounts = evidence
    .map((item: string) => Number(item.match(/words=(\d+)/)?.[1]))
    .filter((value: number) => Number.isFinite(value));
  const averageWords = wordCounts.length
    ? wordCounts.reduce((sum: number, value: number) => sum + value, 0) / wordCounts.length
    : 0;
  const correctionRate = evidence.filter((item: string) => item.includes("correction=yes")).length / evidence.length;
  const enoughB2Evidence = turnCount >= 8 && evidence.length >= 6;
  const enoughC1Evidence = turnCount >= 14 && evidence.length >= 10;

  let targetIndex = 1;
  if (averageWords < 8 && correctionRate > 0.65) targetIndex = 0;
  if (enoughB2Evidence && averageWords >= 18 && correctionRate <= 0.45) targetIndex = 2;
  if (enoughC1Evidence && averageWords >= 36 && correctionRate <= 0.25) targetIndex = 3;

  if (targetIndex > currentIndex) return levels[currentIndex + 1] || levels[currentIndex];
  if (targetIndex < currentIndex) return levels[currentIndex - 1] || levels[currentIndex];
  return levels[currentIndex] || "B1";
}

function normalizeLevel(value: string) {
  const level = value.toUpperCase();
  return ["A2", "B1", "B2", "C1"].includes(level) ? level : "B1";
}

function countWords(value: string) {
  return value.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length || 0;
}

function trimWords(value: string, maxWords: number) {
  const words = value.split(/\s+/).filter(Boolean);
  return words.length > maxWords ? words.slice(0, maxWords).join(" ") : value;
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\w\s']/g, "").replace(/\s+/g, " ").trim();
}

function isMeaningfulCorrection(userMessage: string, correction: string, explanation: string, assistantReply: string) {
  if (!correction) return false;
  if (isNoCorrectionText(correction) || isNoCorrectionText(explanation)) return false;
  const normalizedCorrection = normalizeText(correction);
  if (!normalizedCorrection || normalizedCorrection === normalizeText(userMessage)) return false;
  if (isTutorReplyLike(correction, userMessage, assistantReply)) return false;
  return true;
}

function isTutorReplyLike(correction: string, userMessage: string, assistantReply: string) {
  const normalizedCorrection = normalizeText(correction);
  const normalizedReply = normalizeText(assistantReply);
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

function cleanMemoryList(list: string[]) {
  return list.map((item) => cleanString(item, 360)).filter((item) => item && isUsefulMemoryLine(item));
}

function cleanLevelEvidence(list: string[]) {
  return list.map((item) => cleanString(item, 160)).filter((item) => item && !isNoCorrectionText(item));
}

function isUsefulMemoryLine(value: string) {
  if (!value || isNoCorrectionText(value)) return false;
  return !/->\s*(hi|hello|nice to meet|that sounds|sounds great|what kind|how('|’)s|any specific)/i.test(value);
}

function isNoCorrectionText(value: string) {
  return /\b(no correction needed|already natural|no changes? needed|nothing to correct)\b/i.test(value);
}

function significantWords(value: string) {
  const stop = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "is", "are", "am", "i", "you", "it", "this", "that"]);
  return normalizeText(value).split(" ").filter((word) => word.length > 2 && !stop.has(word));
}
