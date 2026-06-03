/* CHANGE NOTE
Why: Keep local tutor recording and playback configurable without noisy diagnostics
What changed: Added voice/microphone selectors, first-gesture playback unlock, and simplified microphone display to input level only
Behaviour/Assumptions: Visible feedback stays concise while full feedback remains available for tutor memory; mobile browsers may still require manual playback
Rollback: git checkout -- src/components/VoiceTutor.tsx
- mj
*/

"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

type SpeechMetrics = {
  wordCount: number;
  durationSeconds?: number;
  wordsPerMinute?: number;
  pauseCount?: number;
  longestPauseSeconds?: number;
};
type Msg = {
  role: "user" | "assistant";
  text: string;
  correction?: string;
  rewrite?: string;
  explanation?: string;
  fluencyFeedback?: string;
  targetPhraseFeedback?: string;
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
type MicTrackStatus = {
  label: string;
  state: string;
  muted: boolean;
  audioContextState?: AudioContextState;
};
type VoiceOption = {
  id: string;
  name: string;
};
type Props = {
  sessionId?: string | null;
  onSession?: (id: string) => void;
  history?: Msg[];
  onMessage?: (msg: Msg) => void;
  learnerProfile?: LearnerProfile | null;
  onProfileUpdate?: (profile: LearnerProfile) => void;
  hideMessages?: boolean;
  compact?: boolean;
  roleConfig?: {
    persona?: string;
    scenario?: string;
    materials?: string | string[];
    level?: string;
    learner?: string;
    targetPhrases?: string[];
  };
};

const DEFAULT_TTS_VOICE = "af_nicole";
const FALLBACK_TTS_VOICES: VoiceOption[] = [
  { id: "af_nicole", name: "af_nicole" },
  { id: "af_bella", name: "af_bella" },
  { id: "af_sarah", name: "af_sarah" },
  { id: "af_sky", name: "af_sky" },
  { id: "am_adam", name: "am_adam" },
  { id: "am_echo", name: "am_echo" },
];
const SILENT_AUDIO_DATA_URL =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQQAAAAAAA==";

export default function VoiceTutor({
  sessionId: extSessionId = null,
  onSession,
  history: extHistory,
  onMessage,
  learnerProfile,
  onProfileUpdate,
  hideMessages = false,
  compact = false,
  roleConfig,
}: Props) {
  const [pendingAudioUrl, setPendingAudioUrl] = useState<string | null>(null);
  const [lastTutorAudioUrl, setLastTutorAudioUrl] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackUnlockedRef = useRef(false);
  const playbackUnlockPromiseRef = useRef<Promise<void> | null>(null);
  const levelFrameRef = useRef<number | null>(null);
  const maxInputLevelRef = useRef(0);
  const inputMeterAvailableRef = useRef(false);
  const levelSilenceTimerRef = useRef<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(extSessionId);
  const [showTypeBox, setShowTypeBox] = useState(false);
  const [manualText, setManualText] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
  const [micTrackStatus, setMicTrackStatus] = useState<MicTrackStatus | null>(null);
  const [micNotice, setMicNotice] = useState("");
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState("auto");
  const [ttsVoices, setTtsVoices] = useState<VoiceOption[]>(FALLBACK_TTS_VOICES);
  const [selectedVoice, setSelectedVoice] = useState(DEFAULT_TTS_VOICE);

  useEffect(() => {
    if (extSessionId && extSessionId !== sessionId) setSessionId(extSessionId);
  }, [extSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      cleanupRecordingResources();
      playbackAudioRef.current?.pause();
      playbackAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    refreshMicrophones();
    loadTtsVoices();
  }, []);

  async function sendToChat(userText: string, speechMetrics?: SpeechMetrics | null) {
    const sid = await ensureSession();
    let userMessageSaved = false;
    onMessage?.({ role: "user", text: userText });
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: userText }]);
    try {
      const historyTurns = (extHistory ?? messages).map((m) => ({ role: m.role, content: m.text }));
      const r = await fetch("/api/tutor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userText,
          history: historyTurns,
          profileId: learnerProfile?._id,
          learnerProfile,
          speechMetrics,
          ...(roleConfig || {}),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || data?.error || "Tutor chat failed");
      const reply = data?.reply ?? "";
      if (data?.learnerProfile?._id) onProfileUpdate?.(data.learnerProfile);
      const feedback = {
        correction: data?.correction ?? "",
        rewrite: data?.rewrite ?? "",
        explanation: data?.explanation ?? "",
        fluencyFeedback: data?.fluencyFeedback ?? "",
        targetPhraseFeedback: data?.targetPhraseFeedback ?? "",
      };
      const assistantMessage = {
        role: "assistant" as const,
        text: reply,
      };
      setMessages((m) => [...attachFeedbackToLastUser(m, feedback), assistantMessage]);
      onMessage?.({ ...assistantMessage, ...feedback });
      await saveMessage(sid, { role: "user", text: userText, ...feedback });
      userMessageSaved = true;

      if (reply) {
        await saveMessage(sid, assistantMessage);
        try {
          const ttsRes = await fetch("/api/tutor/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: reply, voice: selectedVoice }),
          });
          if (!ttsRes.ok) {
            const message = await readErrorMessage(ttsRes);
            throw new Error(message || "Tutor voice failed");
          }
          const blob = await ttsRes.blob();
          const url = URL.createObjectURL(blob);

          if (lastTutorAudioUrl) {
            URL.revokeObjectURL(lastTutorAudioUrl);
          }
          setLastTutorAudioUrl(url);

          try {
            await playTutorAudio(url);
            setPendingAudioUrl(null);
          } catch {
            setPendingAudioUrl(url);
          }
        } catch (error) {
          console.warn("[tutor] Voice playback skipped:", error);
        }
      }
    } catch (error) {
      if (!userMessageSaved) {
        await saveMessage(sid, { role: "user", text: userText }).catch(() => undefined);
      }
      showTutorError(error);
    } finally {
      setBusy(false);
    }
  }

  async function handleBlob(blob: Blob, clientMaxInputLevel?: number) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("audio", blob, "speech.webm");
      if (typeof clientMaxInputLevel === "number") {
        form.append("clientMaxInputLevel", String(clientMaxInputLevel));
      }
      const r = await fetch("/api/tutor/stt", { method: "POST", body: form });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || data?.error || "Speech recognition failed");
      const text = data?.text?.trim?.() ?? "";
      if (text) await sendToChat(text, data?.speechMetrics ?? null);
    } catch (error) {
      showTutorError(error);
    } finally {
      setBusy(false);
    }
  }

  async function loadTtsVoices() {
    try {
      const response = await fetch("/api/tutor/tts", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || data?.error || "Could not load voices");
      const voices = normalizeVoiceOptions(data?.voices);
      if (voices.length) {
        setTtsVoices(voices);
        setSelectedVoice((current) => voices.some((voice) => voice.id === current) ? current : voices[0].id);
      }
    } catch (error) {
      console.warn("[tutor] Voice list unavailable:", error);
      setTtsVoices(FALLBACK_TTS_VOICES);
    }
  }

  async function refreshMicrophones() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(devices.filter((device) => device.kind === "audioinput" && device.deviceId));
    } catch (error) {
      console.warn("[tutor] Microphone list unavailable:", error);
    }
  }

  async function startRec() {
    try {
      chunksRef.current = [];
      maxInputLevelRef.current = 0;
      inputMeterAvailableRef.current = false;
      setInputLevel(0);
      setMicNotice("");
      setMicTrackStatus(null);
      const { stream, notice } = await openPreferredMicrophone();
      streamRef.current = stream;
      await refreshMicrophones();
      if (notice) setMicNotice(notice);
      const track = stream.getAudioTracks()[0] ?? null;
      bindTrackDiagnostics(track);
      setMicTrackStatus(track ? describeMicTrack(track) : null);
      await startInputLevelMeter(stream);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        const clientMaxInputLevel = inputMeterAvailableRef.current
          ? roundLevel(maxInputLevelRef.current)
          : undefined;
        chunksRef.current = [];
        cleanupRecordingResources();
        if (blob.size === 0) {
          showTutorError(new Error("Recording did not produce audio data. Please check browser microphone permission and try again."));
          return;
        }
        await handleBlob(blob, clientMaxInputLevel);
      };
      rec.start(250);
      recorderRef.current = rec;
      setRecording(true);
      levelSilenceTimerRef.current = window.setTimeout(() => {
        if (recorderRef.current?.state === "recording" && maxInputLevelRef.current < 0.002) {
          setMicNotice((previous) =>
            appendMicNotice(previous, "No input movement yet. Check macOS input source or browser microphone permission.")
          );
        }
      }, 1600);
    } catch (error) {
      cleanupRecordingResources();
      setRecording(false);
      showTutorError(error);
    }
  }

  function stopRec() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  async function startInputLevelMeter(stream: MediaStream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      setMicNotice("This browser cannot show a live input meter.");
      return;
    }
    const audioContext = new AudioContextClass();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    audioContextRef.current = audioContext;
    if (audioContext.state === "suspended") {
      await audioContext.resume().catch(() => undefined);
    }
    inputMeterAvailableRef.current = true;
    setMicTrackStatus((status) => status ? { ...status, audioContextState: audioContext.state } : status);

    const samples = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        sum += sample * sample;
      }
      const level = Math.sqrt(sum / samples.length);
      maxInputLevelRef.current = Math.max(maxInputLevelRef.current, level);
      setInputLevel(level);
      levelFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  function cleanupRecordingResources() {
    if (levelSilenceTimerRef.current !== null) {
      window.clearTimeout(levelSilenceTimerRef.current);
      levelSilenceTimerRef.current = null;
    }
    if (levelFrameRef.current !== null) {
      cancelAnimationFrame(levelFrameRef.current);
      levelFrameRef.current = null;
    }
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function bindTrackDiagnostics(track: MediaStreamTrack | null) {
    if (!track) {
      setMicNotice("The browser opened a stream without an audio track.");
      return;
    }
    track.onmute = () => {
      setMicTrackStatus(describeMicTrack(track));
      setMicNotice("The browser says the microphone track is muted.");
    };
    track.onunmute = () => {
      setMicTrackStatus(describeMicTrack(track));
      setMicNotice("");
    };
    track.onended = () => {
      setMicTrackStatus(describeMicTrack(track));
      setMicNotice("The microphone track ended.");
    };
  }

  async function openPreferredMicrophone(): Promise<{ stream: MediaStream; notice: string }> {
    if (selectedMicId !== "auto") {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: selectedMicId } },
      });
      return { stream, notice: "" };
    }

    const initialStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const initialTrack = initialStream.getAudioTracks()[0] ?? null;
    const initialLabel = initialTrack?.label || "";
    if (!isVirtualAudioInput(initialLabel)) return { stream: initialStream, notice: "" };

    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const preferred = chooseRealMicrophone(devices, initialLabel);
    if (!preferred?.deviceId || preferred.deviceId === "default") {
      return {
        stream: initialStream,
        notice: `The browser default is ${initialLabel}. Change macOS input to AirPods or MacBook microphone if level stays flat.`,
      };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: preferred.deviceId } },
      });
      initialStream.getTracks().forEach((track) => track.stop());
      return {
        stream,
        notice: `Auto-switched from ${initialLabel} to ${preferred.label || "a real microphone"}.`,
      };
    } catch {
      return {
        stream: initialStream,
        notice: `The browser default is ${initialLabel}, and PAD could not auto-switch. Change macOS input to AirPods or MacBook microphone.`,
      };
    }
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    const r = await fetch("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: learnerProfile
          ? `${learnerProfile.displayName} - ${new Date().toLocaleString()}`
          : new Date().toLocaleString(),
        clientId: learnerProfile?._id,
      }),
    });
    const text = await r.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { /* empty */ }
    const id =
      parsed && typeof parsed === "object" && "_id" in parsed && typeof (parsed as { _id: unknown })._id === "string"
        ? (parsed as { _id: string })._id
        : undefined;
    if (!r.ok || !id) throw new Error("Failed to create chat session");
    setSessionId(id);
    onSession?.(id);
    return id;
  }

  async function saveMessage(sid: string, msg: Msg) {
    await fetch(`/api/chat/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
  }

  async function readErrorMessage(response: Response) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      return data?.message || data?.error || "";
    }
    return response.text();
  }

  function showTutorError(error: unknown) {
    const text = error instanceof Error ? error.message : "The tutor service failed. Please try again.";
    const msg = { role: "assistant" as const, text };
    setMessages((m) => [...m, msg]);
    onMessage?.(msg);
  }

  function getPlaybackAudio() {
    if (!playbackAudioRef.current) {
      const audio = new Audio();
      audio.preload = "auto";
      playbackAudioRef.current = audio;
    }
    return playbackAudioRef.current;
  }

  async function unlockPlaybackAudio() {
    if (playbackUnlockedRef.current) return;
    if (playbackUnlockPromiseRef.current) return playbackUnlockPromiseRef.current;
    const audio = getPlaybackAudio();
    playbackUnlockPromiseRef.current = (async () => {
      try {
        audio.pause();
        audio.src = SILENT_AUDIO_DATA_URL;
        audio.load();
        await audio.play();
        audio.pause();
        audio.currentTime = 0;
        playbackUnlockedRef.current = true;
      } catch (error) {
        console.warn("[tutor] Audio unlock skipped:", error);
      } finally {
        playbackUnlockPromiseRef.current = null;
      }
    })();
    return playbackUnlockPromiseRef.current;
  }

  async function playTutorAudio(url: string) {
    const audio = getPlaybackAudio();
    audio.pause();
    audio.src = url;
    audio.load();
    await audio.play();
  }

  function primePlaybackAudio() {
    void unlockPlaybackAudio();
  }

  const canPlay = !busy && (!!pendingAudioUrl || !!lastTutorAudioUrl);
  const shouldShowMicDiagnostics = recording || Boolean(micTrackStatus) || Boolean(micNotice);
  const renderFeedback = (m: Msg): string[] => [
    m.correction && `Correction: ${m.correction}`,
    m.explanation && `Note: ${m.explanation}`,
  ].filter((line): line is string => Boolean(line));

  return (
    <div
      onPointerDown={primePlaybackAudio}
      onTouchStart={primePlaybackAudio}
      style={{ display: 'flex', flexDirection: 'column', gap: compact ? '10px' : '12px' }}
    >
      {/* ── Control bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', flexWrap: 'wrap' }}>
        <button
          onClick={() => {
            primePlaybackAudio();
            if (recording) {
              stopRec();
            } else {
              void startRec();
            }
          }}
          disabled={busy}
          className="hover:opacity-60 disabled:opacity-30"
          style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
        >
          {recording && (
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#e55',
              display: 'inline-block',
              animation: 'pulse 1.2s ease-in-out infinite',
            }} />
          )}
          {recording ? "stop" : "record"}
        </button>

        <span style={{ opacity: 0.15 }}>·</span>

        <button
          onClick={async () => {
            await unlockPlaybackAudio();
            const audioUrl = pendingAudioUrl || lastTutorAudioUrl;
            if (audioUrl) {
              try {
                await playTutorAudio(audioUrl);
              } finally {
                if (pendingAudioUrl) setPendingAudioUrl(null);
              }
            }
          }}
          disabled={!canPlay}
          className="hover:opacity-60 disabled:opacity-30"
        >
          play
        </button>

        <span style={{ opacity: 0.15 }}>·</span>

        <button
          onClick={() => {
            primePlaybackAudio();
            setShowTypeBox((v) => !v);
          }}
          disabled={busy}
          className="hover:opacity-60 disabled:opacity-30"
          style={{
            borderBottom: showTypeBox ? '1.5px solid currentColor' : '1.5px solid transparent',
            paddingBottom: '1px',
            transition: 'border-color 0.15s ease',
          }}
        >
          type
        </button>

        {busy && <span style={{ opacity: 0.35, fontSize: '12px', marginLeft: '8px' }}>processing…</span>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', opacity: 0.55 }}>
        <span style={{ width: '54px', height: '3px', background: 'rgba(128,128,128,0.18)', display: 'inline-block' }}>
          <span
            style={{
              display: 'block',
              width: `${Math.min(100, inputLevel * 420)}%`,
              height: '100%',
              background: recording ? 'currentColor' : 'rgba(128,128,128,0.35)',
              transition: 'width 80ms linear',
            }}
          />
        </span>
        {shouldShowMicDiagnostics && <span>level {formatInputLevel(inputLevel)}</span>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12px', opacity: 0.62 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          voice
          <select
            value={selectedVoice}
            onChange={(event) => setSelectedVoice(event.target.value)}
            disabled={busy}
            style={selectStyle}
          >
            {ttsVoices.map((voice) => (
              <option key={voice.id} value={voice.id}>{voice.name || voice.id}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          mic
          <select
            value={selectedMicId}
            onChange={(event) => setSelectedMicId(event.target.value)}
            onFocus={refreshMicrophones}
            disabled={recording || busy}
            style={selectStyle}
          >
            <option value="auto">Auto</option>
            {micDevices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `Microphone ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Type box ── */}
      {showTypeBox && (
        <form
          style={{ display: 'flex', gap: '8px', alignItems: 'center' }}
          onSubmit={async (e) => {
            e.preventDefault();
            const t = manualText.trim();
            if (!t || busy) return;
            primePlaybackAudio();
            setManualText("");
            await sendToChat(t);
          }}
        >
          <input
            className="flex-1 bg-transparent focus:outline-none"
            placeholder="Type a message..."
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            style={{ borderBottom: '1px solid rgba(128,128,128,0.2)', paddingBottom: '4px', fontSize: '14px' }}
            autoFocus
          />
          <button
            disabled={busy || !manualText.trim()}
            type="submit"
            className="hover:opacity-60 disabled:opacity-30"
            style={{ fontSize: '14px' }}
          >
            →
          </button>
        </form>
      )}

      {/* ── Messages (only shown when hideMessages is false) ── */}
      {!hideMessages && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
                {m.role === "user" ? "You" : "Tutor"}
              </span>
              <span style={{ fontSize: '14px' }}>{m.text}</span>
              {m.role === "user" && renderFeedback(m).map((line) => (
                <span key={line} style={{ fontSize: '12px', opacity: 0.45, fontStyle: 'italic', marginTop: '3px' }}>
                  {line}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Recording pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

function attachFeedbackToLastUser(messages: Msg[], feedback: Partial<Msg>) {
  const hasFeedback = Boolean(
    feedback.correction ||
      feedback.rewrite ||
      feedback.explanation ||
      feedback.fluencyFeedback ||
      feedback.targetPhraseFeedback
  );
  if (!hasFeedback) return messages;

  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role === "user") {
      next[index] = { ...next[index], ...feedback };
      break;
    }
  }
  return next;
}

const selectStyle = {
  border: '1px solid rgba(128,128,128,0.22)',
  borderRadius: '4px',
  background: 'transparent',
  padding: '2px 6px',
  maxWidth: '190px',
  fontSize: '12px',
} satisfies CSSProperties;

function normalizeVoiceOptions(value: unknown): VoiceOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return { id: item, name: item };
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string"
        ? record.id
        : typeof record.name === "string"
          ? record.name
          : "";
      const name = typeof record.name === "string" ? record.name : id;
      return id ? { id, name } : null;
    })
    .filter((item): item is VoiceOption => Boolean(item));
}

function roundLevel(value: number) {
  return Math.round(value * 10000) / 10000;
}

function describeMicTrack(track: MediaStreamTrack): MicTrackStatus {
  return {
    label: track.label || "Default microphone",
    state: track.readyState,
    muted: track.muted,
  };
}

function chooseRealMicrophone(devices: MediaDeviceInfo[], currentLabel: string) {
  const current = normalizeMicLabel(currentLabel);
  const audioInputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId);
  const realInputs = audioInputs.filter((device) => {
    const label = normalizeMicLabel(device.label);
    return label && label !== current && !isVirtualAudioInput(label);
  });
  return (
    realInputs.find((device) => /airpods?|headset|bluetooth/i.test(device.label)) ||
    realInputs.find((device) => /macbook|built.?in|internal|microphone/i.test(device.label)) ||
    realInputs[0] ||
    null
  );
}

function isVirtualAudioInput(label: string) {
  return /background music|blackhole|loopback|soundflower|virtual|vb-audio|obs|aggregate|multi-output/i.test(label);
}

function normalizeMicLabel(label: string) {
  return label.toLowerCase().replace(/^default\s*[-:]\s*/, "").replace(/\s+/g, " ").trim();
}

function appendMicNotice(previous: string, next: string) {
  if (!previous) return next;
  if (previous.includes(next)) return previous;
  return `${previous} ${next}`;
}

function formatInputLevel(value: number) {
  return value.toFixed(3);
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
