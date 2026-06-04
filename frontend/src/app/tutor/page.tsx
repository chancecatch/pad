/* CHANGE NOTE
Why: Make the tutor start from learner identity instead of per-session settings
What changed: Added profile login, one-exchange returning context, and fix-pair visible learner feedback
Behaviour/Assumptions: Learner profiles persist in MongoDB and recent practice context can seed a new session
Rollback: git checkout -- src/app/tutor/page.tsx
- mj
*/

"use client";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import VoiceTutor from "@/components/VoiceTutor";

type Msg = {
  role: "user" | "assistant";
  text: string;
  fixes?: TutorFix[];
  correction?: string;
  rewrite?: string;
  explanation?: string;
  fluencyFeedback?: string;
  targetPhraseFeedback?: string;
};

type TutorFix = {
  original: string;
  corrected: string;
  note?: string;
};

type LearnerProfile = {
  _id: string;
  displayName: string;
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

type SavedChatMessage = Msg & { createdAt?: string };

type ChatSession = {
  _id: string;
  title?: string;
  clientId?: string;
  updatedAt?: string;
  messages?: SavedChatMessage[];
};

type ResumeStatus = "idle" | "loading" | "ready" | "empty" | "error";

export default function TutorPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [profiles, setProfiles] = useState<LearnerProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<LearnerProfile | null>(null);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [createName, setCreateName] = useState("");
  const [createPin, setCreatePin] = useState("");
  const [showLoginPin, setShowLoginPin] = useState(false);
  const [showCreatePin, setShowCreatePin] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [resumeStatus, setResumeStatus] = useState<ResumeStatus>("idle");
  const [resumeError, setResumeError] = useState("");
  const contextRequestRef = useRef(0);

  const renderFeedback = (m: Msg): string[] => [
    ...(m.fixes?.length ? m.fixes.map(formatFixLine) : []),
    !m.fixes?.length && m.correction && `Correction: ${m.correction}`,
    m.explanation && `Note: ${m.explanation}`,
  ].filter((line): line is string => Boolean(line));

  const loadProfiles = useCallback(async () => {
    try {
      const response = await fetch("/api/tutor/profiles", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Could not load profiles");
      setProfiles(Array.isArray(data) ? data : []);
      if (!activeProfileId && Array.isArray(data) && data[0]?._id) setActiveProfileId(data[0]._id);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not load profiles");
    }
  }, [activeProfileId]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  async function loginProfile(event: FormEvent) {
    event.preventDefault();
    if (!activeProfileId || loginPin.length !== 4 || profileBusy) return;
    setProfileBusy(true);
    setProfileError("");
    try {
      const response = await fetch("/api/tutor/profiles/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: activeProfileId, pin: loginPin }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Could not unlock profile");
      startProfile(data);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not unlock profile");
    } finally {
      setProfileBusy(false);
    }
  }

  async function createProfile(event: FormEvent) {
    event.preventDefault();
    if (!createName.trim() || createPin.length !== 4 || profileBusy) return;
    setProfileBusy(true);
    setProfileError("");
    try {
      const response = await fetch("/api/tutor/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: createName,
          pin: createPin,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Could not create profile");
      setProfiles((current) => [data, ...current.filter((profile) => profile._id !== data._id)]);
      setCreateName("");
      setCreatePin("");
      setShowCreatePin(false);
      startProfile(data);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not create profile");
    } finally {
      setProfileBusy(false);
    }
  }

  function startProfile(profile: LearnerProfile) {
    contextRequestRef.current += 1;
    setSelectedProfile(profile);
    setActiveProfileId(profile._id);
    setLoginPin("");
    setShowLoginPin(false);
    setSessionId(null);
    setMessages([]);
    setResumeStatus("loading");
    setResumeError("");
    void loadPracticeContext(profile, contextRequestRef.current);
  }

  function switchProfile() {
    contextRequestRef.current += 1;
    setSelectedProfile(null);
    setSessionId(null);
    setMessages([]);
    setResumeStatus("idle");
    setResumeError("");
  }

  function handleProfileUpdate(profile: LearnerProfile) {
    setSelectedProfile(profile);
    setProfiles((current) => [profile, ...current.filter((item) => item._id !== profile._id)]);
  }

  async function loadPracticeContext(profile: LearnerProfile, requestId: number) {
    try {
      const response = await fetch(`/api/chat/sessions?clientId=${encodeURIComponent(profile._id)}&limit=3`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Could not load recent practice");
      if (contextRequestRef.current !== requestId) return;

      const resumeMessages = buildResumeMessages(Array.isArray(data) ? data : []);
      setMessages(resumeMessages);
      setResumeStatus(resumeMessages.length ? "ready" : "empty");
    } catch (error) {
      if (contextRequestRef.current !== requestId) return;
      setResumeStatus("error");
      setResumeError(error instanceof Error ? error.message : "Could not load recent practice");
    }
  }

  if (!selectedProfile) {
    return (
      <div style={{ padding: '27px 0', maxWidth: 560 }}>
        <h1 style={{ fontWeight: 700, fontSize: '16px', marginBottom: '40px' }}>Who&apos;s practicing?</h1>

        <section style={{ marginBottom: '34px' }}>
          <label style={labelStyle}>Existing learner</label>
          {profiles.length > 0 ? (
            <select
              className="bg-transparent focus:outline-none"
              value={activeProfileId}
              onChange={(event) => setActiveProfileId(event.target.value)}
              style={{ ...selectLearnerStyle, marginBottom: '14px' }}
            >
              {profiles.map((profile) => (
                <option key={profile._id} value={profile._id}>
                  {profile.displayName}
                </option>
              ))}
            </select>
          ) : (
            <p style={{ fontSize: '13px', opacity: 0.45, marginBottom: '14px' }}>No saved learners yet.</p>
          )}

          <form onSubmit={loginProfile} style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <PinInput
              value={loginPin}
              visible={showLoginPin}
              onChange={setLoginPin}
              onToggle={() => setShowLoginPin((value) => !value)}
            />
            <button
              className="hover:opacity-60 disabled:opacity-30"
              disabled={!activeProfileId || loginPin.length !== 4 || profileBusy}
              type="submit"
              style={{ fontSize: '14px' }}
            >
              start
            </button>
          </form>
        </section>

        <section>
          <label style={labelStyle}>New learner</label>
          <form onSubmit={createProfile} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <input
              className="bg-transparent focus:outline-none"
              placeholder="Name"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              style={inputStyle}
            />
            <PinInput
              value={createPin}
              visible={showCreatePin}
              onChange={setCreatePin}
              onToggle={() => setShowCreatePin((value) => !value)}
              fullWidth
            />
            <button
              className="hover:opacity-60 disabled:opacity-30"
              disabled={!createName.trim() || createPin.length !== 4 || profileBusy}
              type="submit"
              style={{ fontSize: '14px', alignSelf: 'flex-start' }}
            >
              create and start
            </button>
          </form>
        </section>

        {profileError && (
          <p style={{ marginTop: '20px', fontSize: '12px', opacity: 0.55 }}>{profileError}</p>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '27px 0', maxWidth: 560 }}>
      <h1 style={{ fontWeight: 700, fontSize: '16px', marginBottom: '30px' }}>Tutor</h1>

      <section style={{ marginBottom: '30px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ opacity: 0.45 }}>practicing as</span>
        <span>{selectedProfile.displayName}</span>
        <span style={{ opacity: 0.15 }}>·</span>
        <button onClick={switchProfile} className="hover:opacity-60" style={{ fontSize: '13px' }}>
          switch
        </button>
      </section>

      {resumeStatus === "loading" && (
        <p style={{ fontSize: '12px', opacity: 0.45, marginBottom: '18px' }}>Loading recent practice...</p>
      )}

      {resumeStatus === "error" && resumeError && (
        <p style={{ fontSize: '12px', opacity: 0.55, marginBottom: '18px' }}>{resumeError}</p>
      )}

      <section>
        {messages.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px' }}>
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                <span style={{ fontSize: '11px', opacity: 0.35, marginBottom: '2px' }}>
                  {m.role === 'user' ? 'You' : 'Tutor'}
                </span>
                <span style={{ fontSize: '14px', maxWidth: '85%' }}>{m.text}</span>
                {m.role === 'user' && (
                  renderFeedback(m).map((line) => (
                    <span key={line} style={{ fontSize: '12px', opacity: 0.45, fontStyle: 'italic', marginTop: '4px', maxWidth: '85%' }}>
                      {line}
                    </span>
                  ))
                )}
              </div>
            ))}
          </div>
        )}

        <VoiceTutor
          sessionId={sessionId}
          onSession={(id) => setSessionId(id)}
          history={messages}
          learnerProfile={selectedProfile}
          onProfileUpdate={handleProfileUpdate}
          onMessage={(msg) => {
            contextRequestRef.current += 1;
            setMessages((m) => attachFeedbackForTutorMessage(m, msg));
          }}
          hideMessages
          compact
          roleConfig={{ level: selectedProfile.level || "B1" }}
        />
      </section>
    </div>
  );
}

function attachFeedbackForTutorMessage(messages: Msg[], msg: Msg) {
  if (msg.role !== "assistant") return [...messages, msg];

  const { fixes, correction, rewrite, explanation, fluencyFeedback, targetPhraseFeedback, ...assistantMessage } = msg;
  const feedback = { fixes, correction, rewrite, explanation, fluencyFeedback, targetPhraseFeedback };
  const hasFeedback = Boolean(fixes?.length || correction || rewrite || explanation || fluencyFeedback || targetPhraseFeedback);
  if (!hasFeedback) return [...messages, assistantMessage];

  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role === "user") {
      next[index] = { ...next[index], ...feedback };
      break;
    }
  }
  return [...next, assistantMessage];
}

function buildResumeMessages(sessions: ChatSession[]): Msg[] {
  return extractRecentExchange(sessions);
}

function extractRecentExchange(sessions: ChatSession[]) {
  const latestSession = sessions.find((session) => Array.isArray(session.messages) && session.messages.some((message) => message?.text));
  if (!latestSession?.messages) return [];
  const messages = latestSession.messages
    .map(normalizeResumeMessage)
    .filter((message): message is Msg => Boolean(message));

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    if (messages[index].role === "user" && messages[index + 1]?.role === "assistant") {
      return [messages[index], messages[index + 1]];
    }
  }
  return [];
}

function normalizeResumeMessage(message: SavedChatMessage): Msg | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const text = cleanResumeText(message.text, 260);
  if (!text) return null;
  const fixes = normalizeResumeFixes(message.fixes);
  return {
    role: message.role,
    text,
    fixes,
    explanation: cleanResumeText(message.explanation, 360),
  };
}

function normalizeResumeFixes(value: unknown): TutorFix[] {
  if (!Array.isArray(value)) return [];
  const fixes: TutorFix[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const original = cleanResumeText(record.original, 120);
    const corrected = cleanResumeText(record.corrected, 120);
    const note = cleanResumeText(record.note, 60);
    if (original && corrected) fixes.push({ original, corrected, note });
    if (fixes.length >= 3) break;
  }
  return fixes;
}

function cleanResumeText(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function formatFixLine(fix: TutorFix) {
  const note = fix.note ? ` (${fix.note})` : "";
  return `Fix: ${fix.original} -> ${fix.corrected}${note}`;
}

function PinInput({
  value,
  visible,
  onChange,
  onToggle,
  fullWidth = false,
}: {
  value: string;
  visible: boolean;
  onChange: (value: string) => void;
  onToggle: () => void;
  fullWidth?: boolean;
}) {
  return (
    <div style={{ ...pinInputWrapStyle, width: fullWidth ? '100%' : '292px' }}>
      <input
        className="bg-transparent focus:outline-none"
        inputMode="numeric"
        maxLength={4}
        placeholder="4-digit PIN"
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(pinValue(event.target.value))}
        style={pinInputStyle}
      />
      <button
        type="button"
        aria-label={visible ? "Hide PIN" : "Show PIN"}
        title={visible ? "Hide PIN" : "Show PIN"}
        onClick={onToggle}
        className="hover:opacity-60"
        style={pinToggleStyle}
      >
        <EyeIcon hidden={!visible} />
      </button>
    </div>
  );
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
      {hidden && <path d="M4 4l16 16" />}
    </svg>
  );
}

function pinValue(value: string) {
  return value.replace(/\D/g, "").slice(0, 4);
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 500,
  marginBottom: '8px',
  opacity: 0.55,
};

const inputStyle: React.CSSProperties = {
  borderBottom: '1px solid rgba(128,128,128,0.2)',
  paddingBottom: '4px',
  fontSize: '14px',
  minWidth: '0',
};

const selectLearnerStyle: React.CSSProperties = {
  border: '1px solid rgba(128,128,128,0.22)',
  borderRadius: '4px',
  padding: '7px 34px 7px 10px',
  fontSize: '14px',
  minWidth: '160px',
};

const pinInputWrapStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  borderBottom: '1px solid rgba(128,128,128,0.2)',
  maxWidth: '100%',
};

const pinInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  paddingBottom: '4px',
  fontSize: '14px',
};

const pinToggleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '28px',
  height: '28px',
  opacity: 0.55,
};
