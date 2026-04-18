/**
 * ChallengeRoom.jsx — B2 Beruf Practice App
 *
 * Fix summary (v3):
 *   1. Speech dedup — sanitizeFinalChunk() strips overlapping suffixes before
 *      appending so repeated phrases collapse. Interim is debounced 80ms.
 *   2. Real-time partner transcript — both final AND interim text are written
 *      to Firebase so the listener sees words appear word-by-word.
 *   3. AI loading lock — aiFeedbackLoading renders a full-screen glassmorphism
 *      overlay and disables the exit button until the response arrives.
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── Firebase ──────────────────────────────────────────────────────────────────
let _firebaseDb = null;
async function getFirebaseDB() {
  if (_firebaseDb) return _firebaseDb;
  try {
    const { db } = await import("./firebase-config.js");
    _firebaseDb = db;
    return _firebaseDb;
  } catch {
    console.warn("ChallengeRoom: Firebase not configured — running offline.");
    return null;
  }
}

// ── Audio ─────────────────────────────────────────────────────────────────────
function playBeep({ freq = 880, duration = 0.18, type = "sine", gain = 0.35 } = {}) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), env = ctx.createGain();
    osc.connect(env); env.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    env.gain.setValueAtTime(gain, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + duration);
  } catch {}
}

const PREP_DURATION  = 30;
const SPEAK_DURATION = 180;
const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;

const OPENAI_SYSTEM_PROMPT = `You are a professional German language tutor. Analyze the user's transcript for grammar and vocabulary errors. Provide a JSON response with:
- score (integer 1-5)
- correctedText (the perfect version of what the user said)
- feedback (concise, encouraging explanation in German, 2-4 sentences)
- errors (array of objects: { original: string, correction: string })
Respond ONLY with valid JSON. No markdown, no backticks.`;

function pickRandom(questions, usedIds) {
  const pool = questions.filter(q => !usedIds.includes(q.id));
  const src  = pool.length > 0 ? pool : questions;
  return src[Math.floor(Math.random() * src.length)];
}

function scoreAnswer(userText, redemittel) {
  if (!userText?.trim() || !redemittel?.length)
    return { score: 0, matched: [], missed: redemittel || [], pct: 0 };
  const lower = userText.toLowerCase();
  const matched = [], missed = [];
  for (const r of redemittel) {
    const kw = r.toLowerCase().split(/[\s,]+/).slice(0, 2).join(" ");
    (lower.includes(kw) ? matched : missed).push(r);
  }
  const pct = matched.length / redemittel.length;
  return { score: Math.round(2 + pct * 8), matched, missed, pct };
}

function highlightErrors(text, errors = []) {
  if (!text || !errors.length) return text;
  let result = text;
  errors.forEach(({ original }) => {
    if (!original) return;
    const esc = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(${esc})`, "gi"),
      `<span class="error-text">$1</span>`);
  });
  return result;
}

// ── FIX 1: Dedup overlapping speech chunks ────────────────────────────────────
// The Web Speech API sometimes re-emits the tail of the previous segment when
// it restarts (especially Chrome). Detect overlap by checking whether newChunk
// starts with a suffix of existing, and strip it.
function sanitizeFinalChunk(existing, newChunk) {
  const trimmed = newChunk.trim();
  if (!trimmed || !existing) return trimmed;
  const normExisting = existing.toLowerCase().replace(/\s+/g, " ").trim();
  const normNew      = trimmed.toLowerCase().replace(/\s+/g, " ").trim();
  // Try suffix overlap of up to 8 words
  const words = normExisting.split(" ");
  for (let len = Math.min(8, words.length); len >= 2; len--) {
    const suffix = words.slice(-len).join(" ");
    if (normNew.startsWith(suffix)) {
      const stripped = trimmed.slice(suffix.length).trim();
      return stripped;
    }
  }
  if (normExisting.endsWith(normNew)) return ""; // exact duplicate tail
  return trimmed;
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function fetchAIFeedback(transcript) {
  if (!OPENAI_API_KEY) { console.warn("No VITE_OPENAI_API_KEY."); return null; }
  if (!transcript?.trim()) return null;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini", max_tokens: 800, temperature: 0.3,
      messages: [
        { role: "system", content: OPENAI_SYSTEM_PROMPT },
        { role: "user",   content: transcript.trim() },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content || "";
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { console.error("AI parse error:", raw); return null; }
}

// ── FIX 1+2: Speech Recognition hook ─────────────────────────────────────────
// Changes vs v2:
//  • onInterim debounced 80ms — no flicker on engine restarts
//  • onFinal receives sanitized chunk (dedup handled by caller)
//  • onInterimSync prop → caller pushes interim to Firebase for partner
function useSpeechRecognition({ onInterim, onFinal, onInterimSync, active }) {
  const recogRef        = useRef(null);
  const activeRef       = useRef(active);
  const interimDebounce = useRef(null);
  useEffect(() => { activeRef.current = active; }, [active]);

  const start = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { console.warn("SpeechRecognition not supported"); return; }
    if (recogRef.current) { try { recogRef.current.stop(); } catch {} }
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = "de-DE"; r.maxAlternatives = 1;

    r.onresult = (e) => {
      let interimAccum = "", finalAccum = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalAccum += t + " ";
        else                       interimAccum += t;
      }
      if (interimAccum) {
        clearTimeout(interimDebounce.current);
        interimDebounce.current = setTimeout(() => {
          onInterim?.(interimAccum);
          onInterimSync?.(interimAccum); // FIX 2: push to Firebase
        }, 80);
      }
      if (finalAccum) {
        clearTimeout(interimDebounce.current);
        onFinal?.(finalAccum.trimEnd()); // FIX 1: caller will dedup
      }
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted")
        console.warn("SpeechRecognition error:", e.error);
    };
    r.onend = () => { if (activeRef.current) { try { r.start(); } catch {} } };
    recogRef.current = r;
    try { r.start(); } catch {}
  }, [onInterim, onFinal, onInterimSync]);

  const stop = useCallback(() => {
    activeRef.current = false;
    clearTimeout(interimDebounce.current);
    try { recogRef.current?.stop(); } catch {}
    recogRef.current = null;
  }, []);

  return { start, stop };
}

// ── Circular SVG Timer ────────────────────────────────────────────────────────
function CircularTimer({ timeLeft, totalTime, phase }) {
  const R = 54, C = 2 * Math.PI * R;
  const offset    = C * (1 - timeLeft / totalTime);
  const isUrgent  = timeLeft <= 5, isWarning = timeLeft <= 30;
  const pc = isUrgent ? "#ff4d4d" : isWarning ? "#f59e0b" : "#4f9eff";
  const gc = isUrgent ? "rgba(255,77,77,.5)" : isWarning ? "rgba(245,158,11,.5)" : "rgba(79,158,255,.5)";
  const mins = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const secs = String(timeLeft % 60).padStart(2, "0");
  return (
    <div className={`cr-timer-wrap${isUrgent ? " cr-timer-urgent" : ""}`}>
      <svg viewBox="0 0 128 128" width="148" height="148" style={{ overflow:"visible" }}>
        <defs>
          <radialGradient id="timerFace" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1e2236"/><stop offset="100%" stopColor="#12141d"/>
          </radialGradient>
        </defs>
        <circle cx="64" cy="64" r="58" fill="url(#timerFace)"/>
        <circle cx="64" cy="64" r="62" fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="2"/>
        <circle cx="64" cy="64" r={R} fill="none" stroke="rgba(255,255,255,.05)" strokeWidth="9"/>
        <circle cx="64" cy="64" r={R} fill="none" stroke={gc} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={offset} transform="rotate(-90 64 64)"
          style={{ filter:"blur(6px)", transition:"stroke-dashoffset .5s linear,stroke .4s ease" }}/>
        <circle cx="64" cy="64" r={R} fill="none" stroke={pc} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={offset} transform="rotate(-90 64 64)"
          style={{ transition:"stroke-dashoffset .5s linear,stroke .4s ease" }}/>
        <text x="64" y="58" textAnchor="middle" dominantBaseline="middle"
          fill={isUrgent ? "#ff4d4d" : "#fff"} fontSize="22" fontWeight="700"
          fontFamily="'Syne',sans-serif" style={{ transition:"fill .4s ease" }}>{mins}:{secs}</text>
        <text x="64" y="77" textAnchor="middle" dominantBaseline="middle"
          fill="rgba(255,255,255,.35)" fontSize="8" fontWeight="500"
          fontFamily="'Syne',sans-serif" letterSpacing="2">
          {phase === "prep" ? "VORBEREITUNG" : "SPRECHEN"}
        </text>
      </svg>
    </div>
  );
}

// ── FIX 2: Live Transcript Box ────────────────────────────────────────────────
// Listener now sees partnerInterim (from Firebase) updating word-by-word,
// not only when a sentence finalises.
function LiveTranscriptBox({ transcript, interimText, partnerTranscript, partnerInterim, isMulti, isSpeaker }) {
  const bottomRef = useRef(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); },
    [transcript, interimText, partnerTranscript, partnerInterim]);

  return (
    <div className="cr-transcript-box">
      <div className="cr-transcript-header">
        <span className="cr-transcript-icon">🎙</span>
        <span className="cr-transcript-label">
          {isSpeaker ? "Dein Live-Transkript" : "Live-Transkript"}
        </span>
        <span className="cr-transcript-dot cr-transcript-dot-live"/>
      </div>

      {isSpeaker && (
        <div className="cr-transcript-body">
          {!transcript && !interimText &&
            <span className="cr-transcript-placeholder">Fang an zu sprechen…</span>}
          <span className="cr-transcript-final">{transcript}</span>
          {interimText && <span className="cr-transcript-interim"> {interimText}</span>}
          <div ref={bottomRef}/>
        </div>
      )}

      {!isSpeaker && isMulti && (
        <div className="cr-transcript-body">
          {!partnerTranscript && !partnerInterim &&
            <span className="cr-transcript-placeholder">Wartet auf Sprecher…</span>}
          <span className="cr-transcript-final">{partnerTranscript}</span>
          {partnerInterim && <span className="cr-transcript-interim"> {partnerInterim}</span>}
          <div ref={bottomRef}/>
        </div>
      )}

      {isSpeaker && isMulti && partnerTranscript && (
        <div className="cr-transcript-partner">
          <span className="cr-transcript-partner-label">Partner:</span>
          <span className="cr-transcript-partner-text">{partnerTranscript}</span>
        </div>
      )}
    </div>
  );
}

// ── FIX 3: AI Analysing Overlay ───────────────────────────────────────────────
// Full-screen glassmorphism lock that renders while aiFeedbackLoading is true.
// User cannot exit, navigate, or interact with anything underneath.
function AIAnalyzingOverlay() {
  return (
    <div className="cr-ai-overlay" role="dialog" aria-modal="true" aria-label="KI analysiert">
      <div className="cr-ai-overlay-card">
        <div className="cr-ai-overlay-ring-wrap">
          <svg width="80" height="80" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(79,158,255,.12)" strokeWidth="5"/>
            <circle cx="40" cy="40" r="34" fill="none" stroke="#4f9eff" strokeWidth="5"
              strokeLinecap="round" strokeDasharray="60 154"
              style={{ animation:"cr-spin 1.1s linear infinite", transformOrigin:"center" }}/>
          </svg>
          <span className="cr-ai-overlay-emoji">🤖</span>
        </div>
        <h3 className="cr-ai-overlay-title">Analysiere deine Antwort…</h3>
        <p className="cr-ai-overlay-sub">
          Die KI überprüft Grammatik und Wortschatz.<br/>Bitte einen Moment warten.
        </p>
        <div className="cr-ai-overlay-dots">
          <span className="cr-ai-dot" style={{ animationDelay:"0s" }}/>
          <span className="cr-ai-dot" style={{ animationDelay:".18s" }}/>
          <span className="cr-ai-dot" style={{ animationDelay:".36s" }}/>
        </div>
        <p className="cr-ai-overlay-lock-note">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ marginRight:5, flexShrink:0 }}>
            <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/>
            <path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Ansicht bleibt geöffnet bis die Analyse abgeschlossen ist
        </p>
      </div>
    </div>
  );
}

// ── AI Feedback Card ──────────────────────────────────────────────────────────
function AIFeedbackCard({ feedback, transcript, isLoading }) {
  if (isLoading) return (
    <div className="cr-feedback-card cr-feedback-loading">
      <div className="cr-feedback-spinner">
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="12" fill="none" stroke="rgba(79,158,255,.2)" strokeWidth="3"/>
          <circle cx="16" cy="16" r="12" fill="none" stroke="#4f9eff" strokeWidth="3"
            strokeLinecap="round" strokeDasharray="40 36"
            style={{ animation:"cr-spin 1s linear infinite", transformOrigin:"center" }}/>
        </svg>
      </div>
      <p className="cr-feedback-loading-text">KI analysiert deine Antwort…</p>
    </div>
  );
  if (!feedback) return null;
  const { score = 0, correctedText, feedback: feedbackText, errors = [] } = feedback;
  const highlighted = highlightErrors(transcript, errors);
  const stars = Array.from({ length: 5 }, (_, i) => i < score);
  return (
    <div className="cr-feedback-card">
      <div className="cr-feedback-header">
        <div className="cr-feedback-title-row">
          <span className="cr-feedback-icon">🤖</span>
          <h3 className="cr-feedback-title">KI-Auswertung</h3>
        </div>
        <div className="cr-feedback-stars">
          {stars.map((f, i) => <span key={i} className={`cr-star${f ? " cr-star-filled" : ""}`}>★</span>)}
          <span className="cr-feedback-score-label">{score}/5</span>
        </div>
      </div>
      {transcript && (
        <div className="cr-feedback-section">
          <div className="cr-feedback-section-label">Dein Text</div>
          <p className="cr-feedback-original" dangerouslySetInnerHTML={{ __html: highlighted }}/>
        </div>
      )}
      {correctedText && (
        <div className="cr-feedback-section">
          <div className="cr-feedback-section-label">Korrektur</div>
          <p className="cr-feedback-corrected corrected-text">{correctedText}</p>
        </div>
      )}
      {errors.length > 0 && (
        <div className="cr-feedback-section">
          <div className="cr-feedback-section-label">Fehler</div>
          <div className="cr-feedback-errors">
            {errors.map((e, i) => (
              <div key={i} className="cr-feedback-error-row">
                <span className="error-text cr-feedback-error-orig">{e.original}</span>
                <span className="cr-feedback-arrow">→</span>
                <span className="corrected-text cr-feedback-error-fix">{e.correction}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {feedbackText && (
        <div className="cr-feedback-section cr-feedback-section-last">
          <div className="cr-feedback-section-label">Feedback</div>
          <p className="cr-feedback-text">{feedbackText}</p>
        </div>
      )}
    </div>
  );
}

// ── Redemittel Panel ──────────────────────────────────────────────────────────
function RedemittelPanel({ items = [] }) {
  const [open, setOpen] = useState(false);
  const list = items.length > 0 ? items : [
    "Ich möchte zunächst darauf hinweisen, dass …",
    "Meiner Meinung nach ist es wichtig, …",
    "Ein wesentlicher Aspekt dabei ist …",
    "Auf der anderen Seite muss man bedenken, …",
    "Zusammenfassend lässt sich sagen, dass …",
    "Ich stimme zu / Ich stimme nicht zu, weil …",
    "Das hat den Vorteil / Nachteil, dass …",
    "Darf ich kurz etwas dazu sagen?",
    "Was ich damit sagen möchte, ist …",
    "Ich finde, dass man hierbei unterscheiden muss zwischen …",
  ];
  return (
    <div className={`cr-redemittel${open ? " cr-redemittel-open" : ""}`}>
      <button className="cr-redemittel-toggle" onClick={() => setOpen(o => !o)}>
        <span className="cr-redemittel-chevron">{open ? "▾" : "▸"}</span>
        <span className="cr-redemittel-label">Redemittel</span>
        <span className="cr-redemittel-count">{list.length}</span>
      </button>
      {open && (
        <div className="cr-redemittel-body">
          <ul className="cr-redemittel-list">
            {list.map((item, i) => (
              <li key={i} className="cr-redemittel-item">
                <span className="cr-redemittel-bullet"/><span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Exit Confirm Modal ────────────────────────────────────────────────────────
function ExitConfirmModal({ onConfirm, onCancel }) {
  return (
    <div className="cr-modal-overlay">
      <div className="cr-modal-card">
        <div className="cr-modal-icon-wrap">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h3 className="cr-modal-title">Übung abbrechen?</h3>
        <p className="cr-modal-body">Bist du sicher? Dein Fortschritt wird nicht gespeichert.</p>
        <div className="cr-modal-actions">
          <button className="cr-modal-confirm" onClick={onConfirm}>Ja, beenden</button>
          <button className="cr-modal-cancel"  onClick={onCancel}>Weitermachen</button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ChallengeRoom({
  mode        = "solo",
  roomId      = null,
  currentUser,
  questions   = [],
  onExit,
  heroBgImage = "/1000188762.png",
}) {
  const me      = currentUser || { uid: "demo", displayName: "Du" };
  const isSolo  = mode === "solo";
  const isMulti = mode === "multi";

  const [phase,             setPhase]             = useState("intro");
  const [timerPhase,        setTimerPhase]        = useState("prep");
  const [timeLeft,          setTimeLeft]          = useState(PREP_DURATION);
  const [currentQ,          setCurrentQ]          = useState(null);
  const [usedIds,           setUsedIds]           = useState([]);
  const [round,             setRound]             = useState(1);
  const [myRole,            setMyRole]            = useState("speaker");
  const [partnerName,       setPartnerName]       = useState("Partner");
  const [sessionHistory,    setSessionHistory]    = useState([]);
  const [showExitConfirm,   setShowExitConfirm]   = useState(false);
  const [room,              setRoom]              = useState(null);
  const [fbLoading,         setFbLoading]         = useState(isMulti);
  const [phaseAnim,         setPhaseAnim]         = useState("in");

  const [transcript,        setTranscript]        = useState("");
  const [interimText,       setInterimText]       = useState("");
  const [partnerTranscript, setPartnerTranscript] = useState(""); // FIX 2: final from Firebase
  const [partnerInterim,    setPartnerInterim]    = useState(""); // FIX 2: interim from Firebase
  const [isRecording,       setIsRecording]       = useState(false);

  const [aiFeedback,        setAiFeedback]        = useState(null);
  const [partnerAiFeedback, setPartnerAiFeedback] = useState(null);
  const [aiFeedbackLoading, setAiFeedbackLoading] = useState(false); // FIX 3

  const timerRef      = useRef(null);
  const startedAtRef  = useRef(null);
  const transcriptRef = useRef("");

  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => () => clearInterval(timerRef.current), []);

  // ── FIX 1: Dedup-aware final handler ────────────────────────────────────────
  const handleFinal = useCallback((rawChunk) => {
    setTranscript(prev => {
      const clean = sanitizeFinalChunk(prev, rawChunk);
      if (!clean) return prev;
      const updated = (prev + (prev ? " " : "") + clean).replace(/\s{2,}/g, " ").trim();
      transcriptRef.current = updated;
      // FIX 2: write confirmed text to Firebase
      if (isMulti && roomId) {
        getFirebaseDB().then(db => {
          if (!db) return;
          import("firebase/database").then(({ ref, set }) =>
            set(ref(db, `rooms/${roomId}/liveTranscript/${me.uid}/final`), updated));
        });
      }
      return updated;
    });
    setInterimText("");
  }, [isMulti, roomId, me.uid]);

  const handleInterim = useCallback((text) => { setInterimText(text); }, []);

  // FIX 2: Push interim to Firebase so partner sees real-time word flow
  const handleInterimSync = useCallback((text) => {
    if (!isMulti || !roomId) return;
    getFirebaseDB().then(db => {
      if (!db) return;
      import("firebase/database").then(({ ref, set }) =>
        set(ref(db, `rooms/${roomId}/liveTranscript/${me.uid}/interim`), text));
    });
  }, [isMulti, roomId, me.uid]);

  const isSpeakerPhase = phase === "speaking" && myRole === "speaker";
  const { start: startRecog, stop: stopRecog } = useSpeechRecognition({
    onInterim:     handleInterim,
    onFinal:       handleFinal,
    onInterimSync: handleInterimSync,
    active:        isSpeakerPhase && isRecording,
  });

  useEffect(() => {
    if (isSpeakerPhase && isRecording) startRecog();
    else { stopRecog(); setInterimText(""); }
    return () => stopRecog();
  }, [isSpeakerPhase, isRecording]);

  function transitionPhase(newPhase) {
    setPhaseAnim("out");
    setTimeout(() => { setPhase(newPhase); setPhaseAnim("in"); }, 240);
  }

  // FIX 3: Block exit while loading
  function handleExitRequest() {
    if (aiFeedbackLoading) return;
    if (phase === "intro" || phase === "finished") { onExit?.(); return; }
    setShowExitConfirm(true);
  }

  function startLocalTimer(duration, onComplete) {
    clearInterval(timerRef.current);
    startedAtRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      const left    = Math.max(0, duration - elapsed);
      setTimeLeft(left);
      if (left === 0) { clearInterval(timerRef.current); onComplete(); }
    }, 500);
  }

  // ── Firebase multiplayer listener ────────────────────────────────────────────
  useEffect(() => {
    if (!isMulti || !roomId) return;
    let cleanup = () => {};
    (async () => {
      const db = await getFirebaseDB();
      if (!db) { setFbLoading(false); return; }
      const { ref, onValue, off } = await import("firebase/database");
      const roomRef = ref(db, `rooms/${roomId}`);
      onValue(roomRef, snap => {
        const data = snap.val();
        setFbLoading(false);
        if (!data) return;
        setRoom(data);
        const amA = data.players?.A?.uid === me.uid;
        if (amA)       setMyRole(data.players.A.role);
        else if (data.players?.B?.uid === me.uid) setMyRole(data.players.B.role);
        const partner = amA ? data.players?.B : data.players?.A;
        if (partner?.displayName) setPartnerName(partner.displayName);
        setRound(data.round || 1);
        if (data.currentQuestionId && questions.length) {
          const q = questions.find(q => q.id === data.currentQuestionId);
          if (q) setCurrentQ(q);
        }
        if (data.status) setPhase(data.status);
        if (data.timer?.startedAt && data.timer?.state === "running") {
          const elapsed = Math.floor((Date.now() - data.timer.startedAt) / 1000);
          setTimerPhase(data.timer.phase || "prep");
          setTimeLeft(Math.max(0, data.timer.durationSec - elapsed));
        }
        // FIX 2: read partner final + interim from liveTranscript path
        if (data.liveTranscript && partner?.uid) {
          const pt = data.liveTranscript[partner.uid];
          if (pt) {
            setPartnerTranscript(pt.final   || "");
            setPartnerInterim   (pt.interim || "");
          }
        }
        if (data.aiFeedback) {
          const myFb = data.aiFeedback[me.uid];
          const pFb  = data.aiFeedback[partner?.uid];
          if (myFb) setAiFeedback(myFb);
          if (pFb)  setPartnerAiFeedback(pFb);
        }
      });
      cleanup = () => off(roomRef);
    })();
    return () => cleanup();
  }, [isMulti, roomId]);

  async function fbSet(path, value) {
    if (!isMulti) return;
    const db = await getFirebaseDB(); if (!db) return;
    const { ref, set } = await import("firebase/database");
    await set(ref(db, path), value);
  }

  function beginPrep(questionOverride) {
    setTranscript(""); setInterimText(""); setAiFeedback(null);
    setPartnerTranscript(""); setPartnerInterim("");
    const q = questionOverride || pickRandom(questions, usedIds);
    setCurrentQ(q); setUsedIds(prev => [...prev, q.id]);
    setTimerPhase("prep"); setTimeLeft(PREP_DURATION);
    transitionPhase("prep");
    startLocalTimer(PREP_DURATION, () => beginSpeaking(q));
    if (isMulti) {
      fbSet(`rooms/${roomId}`, {
        ...room, status:"prep", currentQuestionId:q.id, round,
        timer:{ startedAt:Date.now(), durationSec:PREP_DURATION, phase:"prep", state:"running" },
      });
    }
  }

  function beginSpeaking(q) {
    clearInterval(timerRef.current);
    setTimerPhase("speak"); setTimeLeft(SPEAK_DURATION); setIsRecording(true);
    playBeep({ freq:660, gain:.4 });
    transitionPhase("speaking");
    startLocalTimer(SPEAK_DURATION, handleSpeakEnd);
    if (isMulti) {
      fbSet(`rooms/${roomId}/status`, "speaking");
      fbSet(`rooms/${roomId}/timer`, { startedAt:Date.now(), durationSec:SPEAK_DURATION, phase:"speak", state:"running" });
    }
  }

  // FIX 3: Set loading BEFORE phase change — overlay appears immediately
  async function handleSpeakEnd() {
    clearInterval(timerRef.current);
    setIsRecording(false); stopRecog();
    playBeep({ freq:440, gain:.3 });
    const finalTranscript = transcriptRef.current;
    if (isMulti && roomId)
      fbSet(`rooms/${roomId}/liveTranscript/${me.uid}/interim`, "");

    setAiFeedbackLoading(true);   // FIX 3: lock FIRST
    transitionPhase("selfAssess");

    try {
      const result = await fetchAIFeedback(finalTranscript);
      setAiFeedback(result);
      if (isMulti && roomId && result)
        fbSet(`rooms/${roomId}/aiFeedback/${me.uid}`, { ...result, transcript:finalTranscript });
    } catch (err) {
      console.error("AI feedback error:", err);
    } finally {
      setAiFeedbackLoading(false); // FIX 3: unlock only after result is set
    }
  }

  const totalTime = timerPhase === "prep" ? PREP_DURATION : SPEAK_DURATION;

  return (
    <>
      <style>{CSS}</style>
      <link rel="preconnect" href="https://fonts.googleapis.com"/>
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
      <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,400&display=swap" rel="stylesheet"/>

      <div className="cr-root">
        <div className="cr-bg-dim"/>

        {/* FIX 3: overlay rendered at root level, above everything */}
        {aiFeedbackLoading && <AIAnalyzingOverlay/>}

        {showExitConfirm && !aiFeedbackLoading && (
          <ExitConfirmModal
            onConfirm={() => { setShowExitConfirm(false); onExit?.(); }}
            onCancel={() => setShowExitConfirm(false)}
          />
        )}

        {/* ── INTRO ───────────────────────────────────────────────────────── */}
        {phase === "intro" && (
          <div className="cr-intro-stage">
            <div className="cr-hero-bg" style={{ backgroundImage:`url(${heroBgImage})` }}/>
            <div className="cr-hero-overlay-top"/><div className="cr-hero-overlay-bottom"/>
            <header className="cr-header cr-header-hero">
              <div className="cr-logo">
                <span className="cr-logo-b2">B2</span><span className="cr-logo-beruf">Beruf</span>
              </div>
              <div className="cr-header-meta">
                {isMulti && <span className="cr-partner-badge"><span className="cr-partner-dot"/>{partnerName}</span>}
                <span className="cr-round-badge">Runde {round} / 2</span>
              </div>
              <button className="cr-exit-btn" onClick={handleExitRequest} aria-label="Beenden">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </header>
            <div className="cr-hero-content">
              <div className="cr-hero-eyebrow">Deutschprüfung B2 · Mündliche Kommunikation</div>
              <h1 className="cr-hero-title">Bereit für<br/><span className="cr-hero-title-accent">deine Prüfung?</span></h1>
              <p className="cr-hero-sub">
                {isSolo ? "Solo-Übung · 30 s Vorbereitung · 3 min Sprechen · KI-Feedback"
                        : `Duell mit ${partnerName} · 2 Runden · Live-Transkript · KI-Auswertung`}
              </p>
              <div className="cr-hero-meta-row">
                <div className="cr-hero-meta-item"><span className="cr-hero-meta-icon">⏱</span><span>30 s Vorbereitung</span></div>
                <div className="cr-hero-meta-divider"/>
                <div className="cr-hero-meta-item"><span className="cr-hero-meta-icon">🎙</span><span>3 min Sprechen</span></div>
                <div className="cr-hero-meta-divider"/>
                <div className="cr-hero-meta-item"><span className="cr-hero-meta-icon">🤖</span><span>KI-Auswertung</span></div>
                <div className="cr-hero-meta-divider"/>
                <div className="cr-hero-meta-item"><span className="cr-hero-meta-icon">📋</span><span>Redemittel</span></div>
              </div>
              <button className="cr-hero-start-btn" onClick={() => beginPrep()}>
                <span>Übung starten</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* ── ALL OTHER PHASES ────────────────────────────────────────────── */}
        {phase !== "intro" && (
          <>
            <header className="cr-header">
              <div className="cr-logo">
                <span className="cr-logo-b2">B2</span><span className="cr-logo-beruf">Beruf</span>
              </div>
              <div className="cr-header-meta">
                {isMulti && <span className="cr-partner-badge"><span className="cr-partner-dot"/>{partnerName}</span>}
                <span className="cr-round-badge">Runde {round} / 2</span>
                {isRecording && <span className="cr-recording-badge"><span className="cr-recording-dot"/>REC</span>}
              </div>
              {/* FIX 3: disabled + lock icon while AI loading */}
              <button
                className={`cr-exit-btn${aiFeedbackLoading ? " cr-exit-btn-locked" : ""}`}
                onClick={handleExitRequest}
                disabled={aiFeedbackLoading}
                aria-label={aiFeedbackLoading ? "Bitte warten" : "Beenden"}
                title={aiFeedbackLoading ? "Warte auf KI-Analyse…" : undefined}
              >
                {aiFeedbackLoading
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/>
                      <path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                  : <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                }
              </button>
            </header>

            <main className={`cr-main cr-phase-${phaseAnim}`}>

              {/* PREP / SPEAKING */}
              {(phase === "prep" || phase === "speaking") && currentQ && (
                <div className="cr-game-layout">
                  <div className="cr-timer-col">
                    <CircularTimer timeLeft={timeLeft} totalTime={totalTime} phase={timerPhase}/>
                    <div className={`cr-phase-pill cr-phase-pill-${timerPhase}`}>
                      {timerPhase === "prep" ? "Vorbereitung" : "Sprechen"}
                    </div>
                    {phase === "prep" && (
                      <button className="cr-skip-btn" onClick={() => beginSpeaking(currentQ)}>
                        Jetzt sprechen →
                      </button>
                    )}
                    {isMulti && <div className="cr-role-badge">{myRole === "speaker" ? "🎙 Sprecher" : "👂 Zuhörer"}</div>}
                    {phase === "speaking" && myRole === "speaker" && (
                      <button
                        className={`cr-mic-toggle${isRecording ? " cr-mic-active" : ""}`}
                        onClick={() => setIsRecording(r => !r)}
                        title={isRecording ? "Mikrofon stummschalten" : "Mikrofon aktivieren"}
                      >
                        {isRecording
                          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" fill="currentColor"/>
                              <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                            </svg>
                          : <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                              <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                              <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v4M8 23h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                        }
                        <span>{isRecording ? "Aktiv" : "Stumm"}</span>
                      </button>
                    )}
                  </div>

                  <div className="cr-card-col">
                    <div className="cr-topic-chip">{currentQ.topic || "Thema"}</div>
                    <div className="cr-question-card">
                      <div className="cr-question-number">Aufgabe</div>
                      <p className="cr-question-text">{currentQ.question}</p>
                    </div>
                    <RedemittelPanel items={currentQ.redemittel}/>
                    {phase === "speaking" && (
                      <LiveTranscriptBox
                        transcript={transcript}
                        interimText={interimText}
                        partnerTranscript={partnerTranscript}
                        partnerInterim={partnerInterim}
                        isMulti={isMulti}
                        isSpeaker={myRole === "speaker"}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* SELF ASSESS */}
              {phase === "selfAssess" && currentQ && (
                <div className="cr-center-stage">
                  <div className="cr-assess-wide">
                    <div className="cr-assess-header">
                      <div className="cr-assess-icon">✍️</div>
                      <h2 className="cr-assess-heading">Auswertung</h2>
                      <p className="cr-assess-sub">Deine KI-gestützte Sprachanalyse</p>
                    </div>
                    <AIFeedbackCard feedback={aiFeedback} transcript={transcript} isLoading={aiFeedbackLoading}/>
                    {isMulti && partnerAiFeedback && (
                      <div className="cr-partner-feedback-wrap">
                        <div className="cr-partner-feedback-label">🤝 {partnerName}s Auswertung</div>
                        <AIFeedbackCard feedback={partnerAiFeedback} transcript={partnerAiFeedback.transcript} isLoading={false}/>
                      </div>
                    )}
                    <div className="cr-assess-card cr-assess-card-notes">
                      <p className="cr-assess-notes-label">Eigene Notizen (optional)</p>
                      <textarea className="cr-assess-textarea" placeholder="Notizen auf Deutsch …" rows={3}/>
                      <button
                        className="cr-primary-btn"
                        style={{ marginTop:8, alignSelf:"flex-end" }}
                        disabled={aiFeedbackLoading}
                        onClick={() => {
                          const result = scoreAnswer(transcript, currentQ.redemittel || []);
                          setSessionHistory(h => [...h, { q:currentQ, result, aiFeedback }]);
                          if (isSolo || round >= 2) transitionPhase("finished");
                          else                      transitionPhase("switching");
                        }}
                      >
                        {isSolo || round >= 2 ? "Zur Abschlussbewertung →" : "Nächste Runde →"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* SWITCHING */}
              {phase === "switching" && (
                <div className="cr-center-stage">
                  <div className="cr-switch-card">
                    <div className="cr-switch-icon-wrap">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                        <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"
                          stroke="#4f9eff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                    <h2 className="cr-switch-title">Rollenwechsel</h2>
                    <p className="cr-switch-sub">Du bist jetzt: <strong>{myRole === "speaker" ? "Zuhörer" : "Sprecher"}</strong></p>
                    <button className="cr-primary-btn" onClick={() => {
                      setRound(r => r + 1); beginPrep();
                      fbSet(`rooms/${roomId}/round`, round + 1);
                    }}>Nächste Runde →</button>
                  </div>
                </div>
              )}

              {/* FINISHED */}
              {phase === "finished" && (
                <div className="cr-center-stage">
                  <div className="cr-finish-wide">
                    <div className="cr-finish-card">
                      <div className="cr-finish-confetti">🏆</div>
                      <h1 className="cr-finish-title">Geschafft!</h1>
                      <p className="cr-finish-sub">Hervorragende Arbeit!</p>
                      {aiFeedback && (
                        <div className="cr-finish-summary">
                          <div className="cr-finish-score-wrap">
                            <svg viewBox="0 0 120 120" width="130" height="130">
                              <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(79,158,255,.1)" strokeWidth="10"/>
                              <circle cx="60" cy="60" r="52" fill="none" stroke="#4f9eff" strokeWidth="10" strokeLinecap="round"
                                strokeDasharray={`${2*Math.PI*52}`}
                                strokeDashoffset={`${2*Math.PI*52*(1-(aiFeedback.score||0)/5)}`}
                                transform="rotate(-90 60 60)"
                                style={{ transition:"stroke-dashoffset 1s ease" }}/>
                              <text x="60" y="56" textAnchor="middle" dominantBaseline="middle"
                                fill="#fff" fontSize="28" fontWeight="700" fontFamily="Syne,sans-serif">{aiFeedback.score}</text>
                              <text x="60" y="76" textAnchor="middle" dominantBaseline="middle"
                                fill="rgba(255,255,255,.4)" fontSize="10" fontFamily="Syne,sans-serif">VON 5</text>
                            </svg>
                          </div>
                          {aiFeedback.feedback && <p className="cr-finish-feedback-text">{aiFeedback.feedback}</p>}
                        </div>
                      )}
                      <button className="cr-primary-btn cr-finish-btn" onClick={() => onExit?.()}>Beenden</button>
                    </div>
                    {aiFeedback && <AIFeedbackCard feedback={aiFeedback} transcript={transcript} isLoading={false}/>}
                    {isMulti && partnerAiFeedback && (
                      <div className="cr-partner-feedback-wrap">
                        <div className="cr-partner-feedback-label">🤝 {partnerName}s Auswertung</div>
                        <AIFeedbackCard feedback={partnerAiFeedback} transcript={partnerAiFeedback.transcript} isLoading={false}/>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </main>
          </>
        )}
      </div>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,400&display=swap');

  .cr-root {
    --bg:#0e1018; --surface:#161925; --surface2:#1c2030; --surface3:#232840;
    --border:rgba(255,255,255,.07); --border-bright:rgba(255,255,255,.12);
    --border-accent:rgba(79,158,255,.3); --text:#e8eaf2; --text-muted:#7e8aaa;
    --text-dim:#464e6a; --accent:#4f9eff; --accent-dim:rgba(79,158,255,.15);
    --accent-glow:rgba(79,158,255,.3); --red:#ff4d4d; --red-dim:rgba(255,77,77,.12);
    --amber:#f59e0b; --green:#34d399; --green-dim:rgba(52,211,153,.12);
    --radius:18px; --radius-sm:12px;
    --font-display:'Syne',system-ui,sans-serif; --font-body:'DM Sans',system-ui,sans-serif;
    background:var(--bg); color:var(--text); min-height:100vh;
    font-family:var(--font-body); position:relative; overflow-x:hidden;
    display:flex; flex-direction:column;
  }
  .cr-bg-dim { position:fixed; inset:0; background:radial-gradient(ellipse 80% 60% at 20% 10%,rgba(30,40,80,.4) 0%,transparent 70%),radial-gradient(ellipse 60% 50% at 80% 90%,rgba(10,20,50,.5) 0%,transparent 70%); pointer-events:none; z-index:0; }

  @keyframes cr-slow-zoom { 0%{transform:scale(1)} 100%{transform:scale(1.12)} }
  @keyframes cr-fade-up   { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
  @keyframes timerPulse   { 0%,100%{transform:scale(1)} 50%{transform:scale(1.05)} }
  @keyframes modalIn      { from{opacity:0;transform:scale(.94) translateY(10px)} to{opacity:1;transform:none} }
  @keyframes cr-glow-pulse{ 0%,100%{box-shadow:0 0 24px rgba(79,158,255,.2)} 50%{box-shadow:0 0 40px rgba(79,158,255,.45)} }
  @keyframes cr-spin      { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes cr-blink     { 0%,100%{opacity:1} 50%{opacity:.3} }
  @keyframes cr-dot-bounce{ 0%,80%,100%{transform:scale(0);opacity:0} 40%{transform:scale(1);opacity:1} }
  @keyframes cr-overlay-in{ from{opacity:0} to{opacity:1} }

  /* ── FIX 3: AI Analysing Overlay ── */
  .cr-ai-overlay {
    position:fixed; inset:0; z-index:1200;
    background:rgba(6,8,18,.84); backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px);
    display:flex; align-items:center; justify-content:center; padding:24px;
    animation:cr-overlay-in .28s ease;
  }
  .cr-ai-overlay-card {
    background:linear-gradient(145deg,#1c2138 0%,#141828 100%);
    border:1px solid rgba(79,158,255,.3); border-radius:var(--radius);
    padding:48px 44px; text-align:center; max-width:400px; width:100%;
    box-shadow:0 0 0 1px rgba(255,255,255,.05) inset,0 0 80px rgba(79,158,255,.1),0 40px 80px rgba(0,0,0,.7);
    display:flex; flex-direction:column; align-items:center; gap:16px;
    position:relative; overflow:hidden;
  }
  .cr-ai-overlay-card::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,rgba(79,158,255,.5),transparent); }
  .cr-ai-overlay-ring-wrap { position:relative; width:80px; height:80px; display:flex; align-items:center; justify-content:center; }
  .cr-ai-overlay-ring-wrap svg { position:absolute; inset:0; }
  .cr-ai-overlay-emoji { font-size:28px; position:relative; z-index:1; }
  .cr-ai-overlay-title { font-family:var(--font-display); font-size:20px; font-weight:700; color:#fff; margin:0; }
  .cr-ai-overlay-sub { font-family:var(--font-body); font-size:14px; color:var(--text-muted); line-height:1.7; margin:0; }
  .cr-ai-overlay-dots { display:flex; gap:6px; align-items:center; }
  .cr-ai-dot { width:8px; height:8px; border-radius:50%; background:var(--accent); animation:cr-dot-bounce 1.2s ease-in-out infinite; }
  .cr-ai-overlay-lock-note { display:flex; align-items:center; justify-content:center; font-family:var(--font-body); font-size:11px; color:var(--text-dim); margin-top:4px; line-height:1.5; }

  /* ── Hero ── */
  .cr-intro-stage { position:relative; min-height:100vh; display:flex; flex-direction:column; overflow:hidden; }
  .cr-hero-bg { position:absolute; inset:-8%; background-size:cover; background-position:center; animation:cr-slow-zoom 18s ease-in-out infinite alternate; will-change:transform; z-index:0; }
  .cr-hero-overlay-top { position:absolute; top:0; left:0; right:0; height:220px; background:linear-gradient(to bottom,rgba(10,12,22,.92) 0%,transparent 100%); z-index:1; pointer-events:none; }
  .cr-hero-overlay-bottom { position:absolute; bottom:0; left:0; right:0; height:75%; background:linear-gradient(to top,rgba(8,10,20,.98) 0%,rgba(8,10,20,.9) 30%,rgba(8,10,20,.6) 60%,transparent 100%); z-index:1; pointer-events:none; }
  .cr-header-hero { position:relative; z-index:10; background:transparent!important; border-bottom:1px solid rgba(255,255,255,.06)!important; }
  .cr-hero-content { position:relative; z-index:5; flex:1; display:flex; flex-direction:column; align-items:flex-start; justify-content:flex-end; padding:0 56px 64px; max-width:800px; animation:cr-fade-up .8s ease both; animation-delay:.15s; }
  .cr-hero-eyebrow { font-family:var(--font-display); font-size:11px; font-weight:600; letter-spacing:3px; text-transform:uppercase; color:var(--accent); margin-bottom:18px; }
  .cr-hero-title { font-family:var(--font-display); font-size:clamp(44px,7vw,80px); font-weight:800; line-height:1.05; letter-spacing:-2px; color:#fff; margin:0 0 20px; }
  .cr-hero-title-accent { background:linear-gradient(120deg,#4f9eff 0%,#a78bfa 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
  .cr-hero-sub { font-family:var(--font-body); font-size:16px; color:rgba(255,255,255,.55); margin-bottom:32px; line-height:1.6; }
  .cr-hero-meta-row { display:flex; align-items:center; margin-bottom:40px; flex-wrap:wrap; gap:8px; }
  .cr-hero-meta-item { display:flex; align-items:center; gap:7px; font-size:13px; color:rgba(255,255,255,.5); }
  .cr-hero-meta-icon { font-size:14px; }
  .cr-hero-meta-divider { width:1px; height:14px; background:rgba(255,255,255,.18); margin:0 12px; }
  .cr-hero-start-btn { display:inline-flex; align-items:center; gap:12px; background:linear-gradient(135deg,#3b82f6 0%,#6366f1 100%); color:#fff; border:none; padding:16px 36px; border-radius:100px; font-family:var(--font-display); font-size:16px; font-weight:700; cursor:pointer; box-shadow:0 0 0 1px rgba(255,255,255,.1) inset,0 12px 32px rgba(79,100,255,.45); transition:transform .18s,box-shadow .18s; animation:cr-glow-pulse 3s ease-in-out infinite; }
  .cr-hero-start-btn:hover { transform:translateY(-3px); box-shadow:0 0 0 1px rgba(255,255,255,.15) inset,0 18px 44px rgba(79,100,255,.55); }
  @media(max-width:640px){ .cr-hero-content{padding:0 24px 48px} .cr-hero-title{font-size:40px;letter-spacing:-1px} }

  /* ── Header ── */
  .cr-header { display:flex; align-items:center; justify-content:space-between; padding:18px 28px; border-bottom:1px solid var(--border); position:relative; z-index:10; background:rgba(14,16,24,.88); backdrop-filter:blur(16px); flex-shrink:0; }
  .cr-logo { display:flex; align-items:baseline; gap:6px; }
  .cr-logo-b2 { font-family:var(--font-display); font-weight:800; font-size:22px; color:var(--accent); }
  .cr-logo-beruf { font-family:var(--font-display); font-weight:600; font-size:12px; color:var(--text-muted); letter-spacing:2.5px; text-transform:uppercase; }
  .cr-header-meta { display:flex; align-items:center; gap:10px; }
  .cr-round-badge { background:var(--surface2); border:1px solid var(--border-bright); color:var(--text-muted); font-family:var(--font-display); font-size:11px; font-weight:600; letter-spacing:.5px; padding:5px 14px; border-radius:100px; }
  .cr-partner-badge { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--text-muted); }
  .cr-partner-dot { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 7px var(--green); }
  .cr-recording-badge { display:flex; align-items:center; gap:5px; background:rgba(255,77,77,.1); border:1px solid rgba(255,77,77,.3); color:var(--red); font-family:var(--font-display); font-size:10px; font-weight:700; letter-spacing:1.5px; padding:4px 10px; border-radius:100px; }
  .cr-recording-dot { width:6px; height:6px; border-radius:50%; background:var(--red); animation:cr-blink 1s ease-in-out infinite; }
  /* FIX 3: locked exit */
  .cr-exit-btn { background:var(--surface2); border:1px solid var(--border-bright); color:var(--text-muted); cursor:pointer; width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition:all .2s; flex-shrink:0; }
  .cr-exit-btn:hover:not(:disabled) { background:var(--surface3); color:var(--text); border-color:rgba(255,255,255,.22); }
  .cr-exit-btn-locked { opacity:.35; cursor:not-allowed!important; }
  .cr-exit-btn:disabled { pointer-events:none; }

  /* ── Phase transitions ── */
  .cr-main { position:relative; z-index:1; flex:1; display:flex; flex-direction:column; transition:opacity .24s ease,transform .24s ease; }
  .cr-phase-in  { opacity:1; transform:translateY(0); }
  .cr-phase-out { opacity:0; transform:translateY(12px); }

  /* ── Center stage ── */
  .cr-center-stage { display:flex; align-items:flex-start; justify-content:center; flex:1; padding:40px 24px; min-height:70vh; }

  /* ── Game layout ── */
  .cr-game-layout { display:grid; grid-template-columns:180px 1fr; gap:36px; padding:40px 48px; align-items:start; max-width:1020px; margin:0 auto; width:100%; box-sizing:border-box; }
  @media(max-width:740px){ .cr-game-layout{grid-template-columns:1fr;padding:24px 20px;gap:24px} }

  /* ── Timer col ── */
  .cr-timer-col { display:flex; flex-direction:column; align-items:center; gap:14px; position:sticky; top:28px; }
  .cr-timer-wrap { position:relative; filter:drop-shadow(0 0 20px rgba(79,158,255,.15)); }
  .cr-timer-urgent { animation:timerPulse .7s ease-in-out infinite; }
  .cr-phase-pill { font-family:var(--font-display); font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; padding:5px 16px; border-radius:100px; }
  .cr-phase-pill-prep  { background:rgba(245,158,11,.1); color:var(--amber); border:1px solid rgba(245,158,11,.25); }
  .cr-phase-pill-speak { background:var(--accent-dim); color:var(--accent); border:1px solid var(--border-accent); }
  .cr-skip-btn { background:none; border:1px solid var(--border-bright); color:var(--text-muted); font-family:var(--font-body); font-size:12px; padding:7px 16px; border-radius:100px; cursor:pointer; transition:all .2s; }
  .cr-skip-btn:hover { background:var(--surface2); color:var(--text); border-color:rgba(255,255,255,.2); }
  .cr-role-badge { background:var(--surface2); border:1px solid var(--border); color:var(--text-muted); font-size:11px; padding:5px 12px; border-radius:100px; }
  .cr-mic-toggle { display:flex; align-items:center; gap:6px; background:var(--surface2); border:1px solid var(--border-bright); color:var(--text-muted); font-family:var(--font-body); font-size:11px; padding:7px 14px; border-radius:100px; cursor:pointer; transition:all .2s; }
  .cr-mic-toggle:hover { background:var(--surface3); color:var(--text); }
  .cr-mic-active { background:rgba(255,77,77,.12); border-color:rgba(255,77,77,.3); color:var(--red); }
  .cr-mic-active:hover { background:rgba(255,77,77,.2); }

  /* ── Card col ── */
  .cr-card-col { display:flex; flex-direction:column; gap:16px; }
  .cr-topic-chip { display:inline-flex; align-items:center; background:var(--accent-dim); border:1px solid var(--border-accent); color:var(--accent); font-family:var(--font-display); font-size:10px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; padding:5px 14px; border-radius:100px; align-self:flex-start; }
  .cr-question-card { background:linear-gradient(145deg,#1a1f32 0%,#141828 100%); border:1px solid var(--border-bright); border-radius:var(--radius); padding:28px 32px; box-shadow:0 0 0 1px rgba(255,255,255,.04) inset,6px 6px 20px rgba(0,0,0,.5); position:relative; overflow:hidden; }
  .cr-question-card::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.1),transparent); }
  .cr-question-number { font-family:var(--font-display); font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--text-dim); margin-bottom:14px; }
  .cr-question-text { font-family:var(--font-body); font-size:18px; line-height:1.75; color:var(--text); margin:0; }

  /* ── FIX 2: Live Transcript Box ── */
  .cr-transcript-box { background:rgba(255,255,255,.03); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); border:1px solid rgba(79,158,255,.2); border-radius:var(--radius-sm); overflow:hidden; }
  .cr-transcript-header { display:flex; align-items:center; gap:8px; padding:10px 16px; border-bottom:1px solid rgba(255,255,255,.06); }
  .cr-transcript-icon { font-size:13px; }
  .cr-transcript-label { font-family:var(--font-display); font-size:10px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--text-muted); flex:1; }
  .cr-transcript-dot-live { width:6px; height:6px; border-radius:50%; background:var(--accent); animation:cr-blink 1.2s ease-in-out infinite; }
  .cr-transcript-body { padding:14px 16px; min-height:80px; max-height:180px; overflow-y:auto; font-family:var(--font-body); font-size:14px; line-height:1.7; }
  .cr-transcript-placeholder { color:var(--text-dim); font-style:italic; }
  .cr-transcript-final { color:var(--text); }
  .cr-transcript-interim { color:rgba(255,255,255,.38); font-style:italic; }
  .cr-transcript-partner { padding:10px 16px; border-top:1px solid rgba(255,255,255,.06); }
  .cr-transcript-partner-label { font-size:11px; color:var(--text-dim); font-family:var(--font-display); font-weight:600; letter-spacing:1px; text-transform:uppercase; margin-right:8px; }
  .cr-transcript-partner-text { font-size:13px; color:rgba(255,255,255,.45); }

  /* ── Redemittel ── */
  .cr-redemittel { background:rgba(255,255,255,.03); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); border:1px solid rgba(255,255,255,.09); border-radius:var(--radius-sm); overflow:hidden; transition:border-color .25s,background .25s; position:relative; }
  .cr-redemittel::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent); pointer-events:none; }
  .cr-redemittel-open { background:rgba(79,158,255,.04); border-color:rgba(79,158,255,.22); }
  .cr-redemittel-toggle { width:100%; background:none; border:none; color:var(--text-muted); font-family:var(--font-display); font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; padding:14px 18px; display:flex; align-items:center; gap:9px; cursor:pointer; text-align:left; transition:color .2s; }
  .cr-redemittel-toggle:hover { color:var(--text); }
  .cr-redemittel-chevron { font-size:11px; color:var(--accent); width:13px; flex-shrink:0; }
  .cr-redemittel-label { flex:1; }
  .cr-redemittel-count { background:var(--surface3); border:1px solid var(--border); color:var(--text-dim); font-size:10px; padding:2px 9px; border-radius:100px; }
  .cr-redemittel-body { border-top:1px solid rgba(255,255,255,.06); padding:4px 0 12px; }
  .cr-redemittel-list { list-style:none; margin:0; padding:0 18px; display:flex; flex-direction:column; gap:6px; max-height:260px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--surface3) transparent; }
  .cr-redemittel-item { display:flex; align-items:flex-start; gap:10px; font-family:var(--font-body); font-size:13px; line-height:1.65; color:rgba(255,255,255,.55); padding:6px 0; border-bottom:1px solid rgba(255,255,255,.04); transition:color .15s; }
  .cr-redemittel-item:last-child { border-bottom:none; }
  .cr-redemittel-item:hover { color:rgba(255,255,255,.8); }
  .cr-redemittel-bullet { width:4px; height:4px; border-radius:50%; background:var(--accent); margin-top:8px; flex-shrink:0; box-shadow:0 0 4px var(--accent); }

  /* ── AI Feedback Card ── */
  .cr-feedback-card { background:rgba(255,255,255,.03); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); border:1px solid rgba(79,158,255,.25); border-radius:var(--radius); padding:28px 32px; box-shadow:0 0 0 1px rgba(255,255,255,.03) inset,0 12px 40px rgba(0,0,0,.4); position:relative; overflow:hidden; }
  .cr-feedback-card::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,rgba(79,158,255,.4),transparent); }
  .cr-feedback-loading { display:flex; flex-direction:column; align-items:center; gap:14px; padding:36px; }
  .cr-feedback-spinner { display:flex; }
  .cr-feedback-loading-text { font-family:var(--font-display); font-size:13px; color:var(--text-muted); letter-spacing:.5px; }
  .cr-feedback-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:22px; }
  .cr-feedback-title-row { display:flex; align-items:center; gap:10px; }
  .cr-feedback-icon { font-size:20px; }
  .cr-feedback-title { font-family:var(--font-display); font-size:16px; font-weight:700; color:var(--text); margin:0; }
  .cr-feedback-stars { display:flex; align-items:center; gap:3px; }
  .cr-star { font-size:18px; color:var(--surface3); transition:color .2s; }
  .cr-star-filled { color:#f59e0b; filter:drop-shadow(0 0 4px rgba(245,158,11,.5)); }
  .cr-feedback-score-label { font-family:var(--font-display); font-size:12px; font-weight:700; color:var(--text-muted); margin-left:6px; }
  .cr-feedback-section { margin-bottom:18px; }
  .cr-feedback-section-last { margin-bottom:0; }
  .cr-feedback-section-label { font-family:var(--font-display); font-size:9px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--text-dim); margin-bottom:8px; }
  .cr-feedback-original { font-family:var(--font-body); font-size:14px; line-height:1.75; color:rgba(255,255,255,.65); margin:0; }
  .cr-feedback-corrected { font-family:var(--font-body); font-size:14px; line-height:1.75; margin:0; }
  .cr-feedback-errors { display:flex; flex-direction:column; gap:8px; }
  .cr-feedback-error-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:13px; }
  .cr-feedback-error-orig { background:var(--red-dim); border:1px solid rgba(255,77,77,.2); padding:2px 8px; border-radius:6px; }
  .cr-feedback-error-fix  { background:var(--green-dim); border:1px solid rgba(52,211,153,.2); padding:2px 8px; border-radius:6px; }
  .cr-feedback-arrow { color:var(--text-dim); font-size:14px; }
  .cr-feedback-text { font-family:var(--font-body); font-size:14px; line-height:1.75; color:rgba(255,255,255,.6); margin:0; }

  .error-text { color:var(--red); background:var(--red-dim); border-radius:3px; padding:1px 4px; font-style:italic; text-decoration:underline wavy rgba(255,77,77,.6); }
  .corrected-text { color:var(--green); background:var(--green-dim); border-radius:3px; padding:1px 4px; }

  /* ── Assess ── */
  .cr-assess-wide { display:flex; flex-direction:column; gap:20px; width:100%; max-width:680px; }
  .cr-assess-header { text-align:center; display:flex; flex-direction:column; align-items:center; gap:8px; }
  .cr-assess-icon { font-size:36px; }
  .cr-assess-heading { font-family:var(--font-display); font-size:26px; font-weight:700; margin:0; color:var(--text); }
  .cr-assess-sub { font-family:var(--font-body); color:var(--text-muted); font-size:14px; margin:0; line-height:1.6; }
  .cr-assess-card { background:linear-gradient(145deg,#1a1f32 0%,#141828 100%); border:1px solid var(--border-bright); border-radius:var(--radius); padding:24px 28px; box-shadow:0 0 0 1px rgba(255,255,255,.04) inset,0 16px 40px rgba(0,0,0,.5); display:flex; flex-direction:column; gap:12px; }
  .cr-assess-notes-label { font-family:var(--font-display); font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--text-muted); }
  .cr-assess-textarea { width:100%; background:var(--surface3); border:1px solid var(--border-bright); border-radius:var(--radius-sm); color:var(--text); font-family:var(--font-body); font-size:15px; line-height:1.65; padding:14px 18px; resize:vertical; outline:none; transition:border-color .2s,box-shadow .2s; box-sizing:border-box; }
  .cr-assess-textarea:focus { border-color:var(--border-accent); box-shadow:0 0 0 3px rgba(79,158,255,.1); }
  .cr-assess-textarea::placeholder { color:var(--text-dim); }

  .cr-partner-feedback-wrap { display:flex; flex-direction:column; gap:10px; }
  .cr-partner-feedback-label { font-family:var(--font-display); font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--text-muted); }

  .cr-primary-btn { display:inline-flex; align-items:center; justify-content:center; background:linear-gradient(135deg,#3b82f6 0%,#6366f1 100%); color:#fff; border:none; padding:14px 34px; border-radius:100px; font-family:var(--font-display); font-size:15px; font-weight:700; cursor:pointer; box-shadow:0 0 0 1px rgba(255,255,255,.12) inset,0 8px 28px rgba(79,100,255,.4); transition:transform .15s,box-shadow .15s; }
  .cr-primary-btn:hover:not(:disabled) { transform:translateY(-2px); box-shadow:0 0 0 1px rgba(255,255,255,.15) inset,0 14px 36px rgba(79,100,255,.55); }
  .cr-primary-btn:disabled { opacity:.4; cursor:not-allowed; }

  .cr-switch-card { background:linear-gradient(145deg,#1a1f32 0%,#141828 100%); border:1px solid var(--border-bright); border-radius:var(--radius); padding:52px 44px; text-align:center; max-width:380px; width:100%; box-shadow:0 0 0 1px rgba(255,255,255,.04) inset,0 24px 56px rgba(0,0,0,.55); display:flex; flex-direction:column; align-items:center; gap:14px; }
  .cr-switch-icon-wrap { width:62px; height:62px; border-radius:50%; background:var(--accent-dim); border:1px solid var(--border-accent); display:flex; align-items:center; justify-content:center; margin-bottom:6px; }
  .cr-switch-title { font-family:var(--font-display); font-size:26px; font-weight:700; margin:0; color:var(--text); }
  .cr-switch-sub { font-family:var(--font-body); color:var(--text-muted); font-size:14px; margin:0; line-height:1.6; }
  .cr-switch-sub strong { color:var(--accent); font-weight:500; }

  .cr-finish-wide { display:flex; flex-direction:column; gap:20px; width:100%; max-width:680px; }
  .cr-finish-card { background:linear-gradient(145deg,#1a1f32 0%,#141828 100%); border:1px solid var(--border-bright); border-radius:var(--radius); padding:52px 48px; text-align:center; width:100%; box-shadow:0 0 0 1px rgba(255,255,255,.04) inset,0 32px 72px rgba(0,0,0,.6); display:flex; flex-direction:column; align-items:center; gap:8px; }
  .cr-finish-confetti { font-size:52px; margin-bottom:8px; }
  .cr-finish-title { font-family:var(--font-display); font-size:40px; font-weight:800; margin:0; color:var(--text); letter-spacing:-1px; }
  .cr-finish-sub { font-family:var(--font-body); color:var(--text-muted); font-size:14px; margin:0 0 12px; }
  .cr-finish-btn { margin-top:20px; }
  .cr-finish-summary { display:flex; flex-direction:column; align-items:center; gap:14px; margin:8px 0 4px; }
  .cr-finish-score-wrap { display:flex; }
  .cr-finish-feedback-text { font-family:var(--font-body); font-size:14px; color:rgba(255,255,255,.55); line-height:1.7; max-width:380px; text-align:center; }

  .cr-modal-overlay { position:fixed; inset:0; background:rgba(6,8,16,.88); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); display:flex; align-items:center; justify-content:center; z-index:999; padding:24px; }
  .cr-modal-card { background:linear-gradient(145deg,#1c2036 0%,#161926 100%); border:1px solid var(--border-bright); border-radius:var(--radius); padding:38px 34px; text-align:center; max-width:380px; width:100%; box-shadow:0 0 0 1px rgba(255,255,255,.05) inset,0 40px 80px rgba(0,0,0,.7); animation:modalIn .22s ease; }
  .cr-modal-icon-wrap { width:58px; height:58px; border-radius:50%; background:rgba(245,158,11,.08); border:1px solid rgba(245,158,11,.2); display:flex; align-items:center; justify-content:center; margin:0 auto 20px; }
  .cr-modal-title { font-family:var(--font-display); font-size:20px; font-weight:700; margin:0 0 10px; color:var(--text); }
  .cr-modal-body { font-family:var(--font-body); color:var(--text-muted); font-size:14px; line-height:1.65; margin:0; }
  .cr-modal-actions { display:flex; gap:10px; margin-top:26px; }
  .cr-modal-confirm { flex:1; background:rgba(255,77,77,.1); color:var(--red); border:1px solid rgba(255,77,77,.25); font-family:var(--font-display); font-size:13px; font-weight:700; padding:13px; border-radius:var(--radius-sm); cursor:pointer; transition:background .2s; }
  .cr-modal-confirm:hover { background:rgba(255,77,77,.2); }
  .cr-modal-cancel { flex:1; background:var(--surface2); color:var(--text-muted); border:1px solid var(--border-bright); font-family:var(--font-display); font-size:13px; font-weight:700; padding:13px; border-radius:var(--radius-sm); cursor:pointer; transition:all .2s; }
  .cr-modal-cancel:hover { background:var(--surface3); color:var(--text); }
`;
