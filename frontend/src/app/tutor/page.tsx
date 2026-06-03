/* CHANGE NOTE
Why: Make the tutor start from learner identity instead of per-session settings
What changed: Added profile login and fix-pair visible learner feedback
Behaviour/Assumptions: Learner profiles persist in MongoDB and full rewrites are saved for tutor memory
Rollback: git checkout -- src/app/tutor/page.tsx
- mj
*/

"use client";
import { FormEvent, useCallback, useEffect, useState } from "react";
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

export default function TutorPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [profiles, setProfiles] = useState<LearnerProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<LearnerProfile | null>(null);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [createName, setCreateName] = useState("");
  const [createPin, setCreatePin] = useState("");
  const [createGoal, setCreateGoal] = useState("");
  const [profileError, setProfileError] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

  const renderFeedback = (m: Msg): string[] => [
    ...(m.fixes?.length ? m.fixes.map(formatFixLine) : []),
    !m.fixes?.length && m.correction && `Correction: ${m.correction}`,
    !m.fixes?.length && m.explanation && `Note: ${m.explanation}`,
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
          learningGoal: createGoal,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Could not create profile");
      setProfiles((current) => [data, ...current.filter((profile) => profile._id !== data._id)]);
      setCreateName("");
      setCreatePin("");
      setCreateGoal("");
      startProfile(data);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not create profile");
    } finally {
      setProfileBusy(false);
    }
  }

  function startProfile(profile: LearnerProfile) {
    setSelectedProfile(profile);
    setActiveProfileId(profile._id);
    setLoginPin("");
    setSessionId(null);
    setMessages([]);
  }

  function switchProfile() {
    setSelectedProfile(null);
    setSessionId(null);
    setMessages([]);
  }

  function handleProfileUpdate(profile: LearnerProfile) {
    setSelectedProfile(profile);
    setProfiles((current) => [profile, ...current.filter((item) => item._id !== profile._id)]);
  }

  function pinValue(value: string) {
    return value.replace(/\D/g, "").slice(0, 4);
  }

  if (!selectedProfile) {
    return (
      <div style={{ padding: '27px 0', maxWidth: 560 }}>
        <h1 style={{ fontWeight: 700, fontSize: '16px', marginBottom: '40px' }}>Who&apos;s practicing?</h1>

        <section style={{ marginBottom: '34px' }}>
          <label style={labelStyle}>Existing learner</label>
          {profiles.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '14px' }}>
              {profiles.map((profile) => (
                <button
                  key={profile._id}
                  onClick={() => setActiveProfileId(profile._id)}
                  className="hover:opacity-60"
                  style={{
                    fontSize: '14px',
                    paddingBottom: '2px',
                    borderBottom: activeProfileId === profile._id ? '1.5px solid currentColor' : '1.5px solid transparent',
                  }}
                >
                  {profile.displayName}
                </button>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: '13px', opacity: 0.45, marginBottom: '14px' }}>No saved learners yet.</p>
          )}

          <form onSubmit={loginProfile} style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <input
              className="bg-transparent focus:outline-none"
              inputMode="numeric"
              placeholder="4-digit PIN"
              value={loginPin}
              onChange={(event) => setLoginPin(pinValue(event.target.value))}
              style={inputStyle}
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
            <input
              className="bg-transparent focus:outline-none"
              inputMode="numeric"
              placeholder="4-digit PIN"
              value={createPin}
              onChange={(event) => setCreatePin(pinValue(event.target.value))}
              style={inputStyle}
            />
            <input
              className="bg-transparent focus:outline-none"
              placeholder="Goal, e.g., daily conversation"
              value={createGoal}
              onChange={(event) => setCreateGoal(event.target.value)}
              style={inputStyle}
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

function formatFixLine(fix: TutorFix) {
  const note = fix.note ? ` (${fix.note})` : "";
  return `Fix: ${fix.original} -> ${fix.corrected}${note}`;
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
