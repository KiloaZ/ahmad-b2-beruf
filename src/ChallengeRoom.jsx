/**
 * ChallengeRoom.jsx — B2 Beruf · v6 Corrected Sync
 *
 * ══════════════════════════════════════════════════════════════════════
 *  FIXES FROM v5
 * ══════════════════════════════════════════════════════════════════════
 *
 *  FIX 1 — SINGLE onValue LISTENER, NO LOCAL STATE RACES
 *    pushRS / pushRSPath never call setRs directly in multi mode.
 *    setRs is called ONLY inside the onValue callback. This eliminates
 *    the split-source-of-truth race where one client ran ahead.
 *
 *  FIX 2 — MASTER COUNTDOWN GUARD (timerEndsAt ref-equality check)
 *    startMasterCountdown is now guarded by masterEndsAtRef.
 *    It only restarts when timerEndsAt actually changes, not on every
 *    Firebase snapshot (transcript updates, flag changes, etc.) which
 *    was silently resetting the countdown on every keystroke.
 *
 *  FIX 3 — TRANSCRIPT AT SEPARATE PATH (not inside roomState)
 *    Live transcript is written to rooms/{roomId}/transcript/{uid}
 *    instead of roomState/liveTranscript. This prevents every transcript
 *    word from triggering a full roomState merge on both clients and
 *    eliminates the stale-override bug where ...prev clobbered fresh data.
 *
 *  FIX 4 — AI ANALYSIS AT SEPARATE PATH rooms/{roomId}/analysis/{uid}
 *    The speaker writes analysis results here. Both clients listen to
 *    this path independently. The review screen triggers when the data
 *    lands, not when an analyzingFlag is cleared — eliminating the
 *    async stale-ref race in handleSpeakEnd.
 *
 *  FIX 5 — analyzingFlags USE TRANSACTION-SAFE SEPARATE PATHS
 *    Each uid writes only its own flag: rooms/{roomId}/analyzing/{uid}
 *    instead of merging the whole object, preventing last-write-wins
 *    collisions when both users clear flags near-simultaneously.
 *
 *  FIX 6 — amSpeaker DERIVED PURELY FROM FIREBASE (never optimistic)
 *    After pushRS({currentSpeaker: nextSpeaker}), the local amSpeaker
 *    is NOT recomputed until the listener confirms it. The switching
 *    screen now renders based on confirmed Firebase state, not hopeful
 *    local state that hasn't round-tripped yet.
 *
 *  FIX 7 — QUESTION SYNC VIA rooms/{roomId}/questions
 *    Questions are written to Firebase by the room creator and read by
 *    both clients, ensuring both always answer the same question and
 *    the used-IDs pool is shared.
 *
 *  DATA SHAPE (v6)
 *  ───────────────
 *  rooms/{roomId}/
 *    roomState/      — control plane (status, speaker, timer, round)
 *    transcript/     — data plane (live speech per uid)
 *      {uid}/
 *        final       string
 *        interim     string
 *    analysis/       — results plane (AI feedback per uid)
 *      {uid}/        feedbackObj + transcript field
 *    analyzing/      — overlay flags (per uid boolean)
 *      {uid}         boolean
 *    questions/      — shared question list (array, written at room creation)
 *    usedQuestions/  — array of used question IDs (shared)
 *    players/        — A/B uid + displayName (written by matchmaking)
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Firebase thin wrappers
// ─────────────────────────────────────────────────────────────────────────────
let _db = null;
async function getDB() {
  if (_db) return _db;
  try {
    const mod = await import("./firebase-config.js");
    _db = mod.db;
    return _db;
  } catch {
    console.warn("ChallengeRoom: Firebase not configured — solo/offline only.");
    return null;
  }
}

async function fbSet(path, value) {
  const db = await getDB();
  if (!db) return;
  const { ref, set } = await import("firebase/database");
  await set(ref(db, path), value);
}

async function fbUpdate(path, partial) {
  const db = await getDB();
  if (!db) return;
  const { ref, update } = await import("firebase/database");
  await update(ref(db, path), partial);
}

/** Subscribe and return an unsubscribe fn. */
async function fbListen(path, cb) {
  const db = await getDB();
  if (!db) return () => {};
  const { ref, onValue, off } = await import("firebase/database");
  const r = ref(db, path);
  onValue(r, (snap) => cb(snap.exists() ? snap.val() : null));
  return () => off(r);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio
// ─────────────────────────────────────────────────────────────────────────────
function playBeep({ freq = 880, duration = 0.18, type = "sine", gain = 0.35 } = {}) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(),
      env = ctx.createGain();
    osc.connect(env);
    env.connect(ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(gain, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch {
    /* ignore */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const PREP_SEC = 30;
const SPEAK_SEC = 180;
const OA_KEY = import.meta.env.VITE_OPENAI_API_KEY;

const AI_PROMPT = `You are a professional German language tutor. Analyze the user's transcript for grammar and vocabulary errors. Provide a JSON response with:
- score (integer 1-5)
- correctedText (the perfect version of what the user said)
- feedback (concise, encouraging explanation in German, 2-4 sentences)
- errors (array of objects: { original: string, correction: string })
Respond ONLY with valid JSON. No markdown, no backticks.`;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────
function pickRandom(questions, usedIds) {
  const pool = questions.filter((q) => !usedIds.includes(q.id));
  const src = pool.length ? pool : questions;
  return src[Math.floor(Math.random() * src.length)];
}

function highlightErrors(text, errors = []) {
  if (!text || !errors.length) return text;
  let out = text;
  errors.forEach(({ original }) => {
    if (!original) return;
    const esc = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(${esc})`, "gi"),
      `<span class="error-text">$1</span>`
    );
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Android / Samsung Dedup — v5 triple-check (unchanged, solid)
// ─────────────────────────────────────────────────────────────────────────────
function levenshtein(a, b, cap = 40) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val =
        a[i - 1] === b[j - 1] ? row[j - 1] : 1 + Math.min(row[j - 1], row[j], prev);
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

function sanitizeFinalChunk(existing, chunk) {
  const trimmed = chunk.trim();
  if (!trimmed) return "";
  if (!existing) return trimmed;

  const normE = existing.toLowerCase().replace(/\s+/g, " ").trim();
  const normC = trimmed.toLowerCase().replace(/\s+/g, " ").trim();

  if (normE.includes(normC)) return "";

  const words = normE.split(" ");
  for (let len = Math.min(12, words.length); len >= 2; len--) {
    const suffix = words.slice(-len).join(" ");
    if (normC.startsWith(suffix)) {
      const stripped = trimmed.slice(suffix.length).trimStart();
      if (!stripped) return "";
      if (normE.includes(stripped.toLowerCase())) return "";
      return stripped;
    }
  }

  const window = normE.slice(-Math.min(normC.length * 2, normE.length));
  const dist = levenshtein(normC, window, Math.ceil(normC.length * 0.5));
  const sim = 1 - dist / Math.max(normC.length, window.length, 1);
  if (sim > 0.85) return "";

  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAIFeedback(transcript) {
  if (!OA_KEY || !transcript?.trim()) return null;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OA_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 800,
      temperature: 0.3,
      messages: [
        { role: "system", content: AI_PROMPT },
        { role: "user", content: transcript.trim() },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    console.error("AI JSON parse:", raw);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Speech Recognition Hook (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function useSpeechRecognition({ onFinal, onInterim, active }) {
  const recogRef = useRef(null);
  const activeRef = useRef(active);
  const debounceRef = useRef(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const start = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn("SpeechRecognition not available");
      return;
    }
    if (recogRef.current) {
      try {
        recogRef.current.stop();
      } catch {
        /* ignore */
      }
    }

    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "de-DE";
    r.maxAlternatives = 1;

    r.onresult = (e) => {
      let interim = "",
        finals = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finals += t + " ";
        else interim += t;
      }
      if (interim) {
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => onInterim?.(interim), 80);
      }
      if (finals) {
        clearTimeout(debounceRef.current);
        onFinal?.(finals.trimEnd());
      }
    };

    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted")
        console.warn("Speech error:", e.error);
    };

    r.onend = () => {
      if (activeRef.current) try { r.start(); } catch { /* ignore */ }
    };

    recogRef.current = r;
    try {
      r.start();
    } catch {
      /* permission denied */
    }
  }, [onFinal, onInterim]);

  const stop = useCallback(() => {
    activeRef.current = false;
    clearTimeout(debounceRef.current);
    try {
      recogRef.current?.stop();
    } catch {
      /* ignore */
    }
    recogRef.current = null;
  }, []);

  return { start, stop };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timer display hook — purely reads timerEndsAt, ZERO Firebase writes
// ─────────────────────────────────────────────────────────────────────────────
function useTimerDisplay(timerEndsAt, totalSec) {
  const [timeLeft, setTimeLeft] = useState(totalSec);
  useEffect(() => {
    if (!timerEndsAt) {
      setTimeLeft(totalSec);
      return;
    }
    const tick = () =>
      setTimeLeft(Math.max(0, Math.round((timerEndsAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [timerEndsAt, totalSec]);
  return timeLeft;
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG Circular Timer
// ─────────────────────────────────────────────────────────────────────────────
function CircularTimer({ timeLeft, totalTime, phase }) {
  const R = 54,
    C = 2 * Math.PI * R;
  const off = C * (1 - timeLeft / totalTime);
  const urgent = timeLeft <= 5,
    warn = timeLeft <= 30;
  const pc = urgent ? "#ff4d4d" : warn ? "#f59e0b" : "#4f9eff";
  const gc = urgent
    ? "rgba(255,77,77,.5)"
    : warn
    ? "rgba(245,158,11,.5)"
    : "rgba(79,158,255,.5)";
  const mm = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const ss = String(timeLeft % 60).padStart(2, "0");
  return (
    <div className={`cr-timer-wrap${urgent ? " cr-timer-urgent" : ""}`}>
      <svg viewBox="0 0 128 128" width="148" height="148" style={{ overflow: "visible" }}>
        <defs>
          <radialGradient id="crTF" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1e2236" />
            <stop offset="100%" stopColor="#12141d" />
          </radialGradient>
        </defs>
        <circle cx="64" cy="64" r="58" fill="url(#crTF)" />
        <circle
          cx="64" cy="64" r="62" fill="none"
          stroke="rgba(255,255,255,.06)" strokeWidth="2"
        />
        <circle
          cx="64" cy="64" r={R} fill="none"
          stroke="rgba(255,255,255,.05)" strokeWidth="9"
        />
        <circle
          cx="64" cy="64" r={R} fill="none" stroke={gc} strokeWidth="9"
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={off}
          transform="rotate(-90 64 64)"
          style={{ filter: "blur(6px)", transition: "stroke-dashoffset .5s linear,stroke .4s" }}
        />
        <circle
          cx="64" cy="64" r={R} fill="none" stroke={pc} strokeWidth="7"
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={off}
          transform="rotate(-90 64 64)"
          style={{ transition: "stroke-dashoffset .5s linear,stroke .4s" }}
        />
        <text
          x="64" y="57" textAnchor="middle" dominantBaseline="middle"
          fill={urgent ? "#ff4d4d" : "#fff"} fontSize="22" fontWeight="700"
          fontFamily="'Syne',sans-serif" style={{ transition: "fill .4s" }}
        >
          {mm}:{ss}
        </text>
        <text
          x="64" y="76" textAnchor="middle" dominantBaseline="middle"
          fill="rgba(255,255,255,.35)" fontSize="8"
          fontFamily="'Syne',sans-serif" letterSpacing="2"
        >
          {phase === "prep" ? "VORBEREITUNG" : "SPRECHEN"}
        </text>
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Live Transcript Box
// ─────────────────────────────────────────────────────────────────────────────
function LiveTranscriptBox({ myFinal, myInterim, partnerFinal, partnerInterim, isSpeaker, isMulti }) {
  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [myFinal, myInterim, partnerFinal, partnerInterim]);

  return (
    <div className="cr-transcript-box">
      <div className="cr-transcript-header">
        <span className="cr-ti-icon">🎙</span>
        <span className="cr-ti-label">
          {isSpeaker ? "Dein Live-Transkript" : "Sprecher · Live"}
        </span>
        <span className="cr-ti-live-dot" />
      </div>
      <div className="cr-ti-body">
        {isSpeaker ? (
          <>
            {!myFinal && !myInterim && (
              <span className="cr-ti-ph">Fang an zu sprechen…</span>
            )}
            <span className="cr-ti-final">{myFinal}</span>
            {myInterim && <span className="cr-ti-interim"> {myInterim}</span>}
          </>
        ) : (
          <>
            {!partnerFinal && !partnerInterim && (
              <span className="cr-ti-ph">Wartet auf Sprecher…</span>
            )}
            <span className="cr-ti-final">{partnerFinal}</span>
            {partnerInterim && (
              <span className="cr-ti-interim"> {partnerInterim}</span>
            )}
          </>
        )}
        <div ref={endRef} />
      </div>
      {/* In multi mode, speaker also sees partner's side in a sub-row */}
      {isSpeaker && isMulti && partnerFinal && (
        <div className="cr-ti-partner">
          <span className="cr-ti-plabel">Partner:</span>
          <span className="cr-ti-ptext">{partnerFinal}</span>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Analysing Overlay
// ─────────────────────────────────────────────────────────────────────────────
function AIAnalyzingOverlay() {
  return (
    <div className="cr-ai-overlay" role="dialog" aria-modal="true" aria-label="KI analysiert">
      <div className="cr-ai-card">
        <div className="cr-ai-ring">
          <svg width="80" height="80" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(79,158,255,.12)" strokeWidth="5" />
            <circle
              cx="40" cy="40" r="34" fill="none" stroke="#4f9eff" strokeWidth="5"
              strokeLinecap="round" strokeDasharray="60 154"
              style={{ animation: "cr-spin 1.1s linear infinite", transformOrigin: "center" }}
            />
          </svg>
          <span className="cr-ai-emoji">🤖</span>
        </div>
        <h3 className="cr-ai-title">Analysiere deine Antwort…</h3>
        <p className="cr-ai-sub">
          Die KI überprüft Grammatik und Wortschatz.
          <br />
          Bitte einen Moment warten.
        </p>
        <div className="cr-ai-dots">
          {[0, 0.18, 0.36].map((d, i) => (
            <span key={i} className="cr-ai-dot" style={{ animationDelay: `${d}s` }} />
          ))}
        </div>
        <p className="cr-ai-lock">
          <LockIcon size={12} style={{ marginRight: 5 }} />
          Ansicht bleibt geöffnet bis die Analyse abgeschlossen ist
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Icon helpers
// ─────────────────────────────────────────────────────────────────────────────
function LockIcon({ size = 17, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function CloseIcon({ size = 17 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function MicOnIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" fill="currentColor" />
      <path
        d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      />
    </svg>
  );
}
function MicOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v4M8 23h8"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Feedback Card  (Glassmorphism, shows error-text + corrected-text)
// ─────────────────────────────────────────────────────────────────────────────
function AIFeedbackCard({ feedback, transcript, isLoading, ownerLabel }) {
  if (isLoading)
    return (
      <div className="cr-fc cr-fc-loading">
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="12" fill="none" stroke="rgba(79,158,255,.2)" strokeWidth="3" />
          <circle
            cx="16" cy="16" r="12" fill="none" stroke="#4f9eff" strokeWidth="3"
            strokeLinecap="round" strokeDasharray="40 36"
            style={{ animation: "cr-spin 1s linear infinite", transformOrigin: "center" }}
          />
        </svg>
        <p className="cr-fc-loading-text">KI analysiert…</p>
      </div>
    );

  if (!feedback) return null;
  const { score = 0, correctedText, feedback: fb, errors = [] } = feedback;
  const hl = highlightErrors(transcript, errors);
  const stars = Array.from({ length: 5 }, (_, i) => i < score);

  return (
    <div className="cr-fc">
      {ownerLabel && <div className="cr-fc-owner-label">{ownerLabel}</div>}
      <div className="cr-fc-header">
        <div className="cr-fc-title-row">
          <span className="cr-fc-icon">🤖</span>
          <h3 className="cr-fc-title">KI-Auswertung</h3>
        </div>
        <div className="cr-fc-stars">
          {stars.map((f, i) => (
            <span key={i} className={`cr-star${f ? " cr-star-on" : ""}`}>★</span>
          ))}
          <span className="cr-fc-score">{score}/5</span>
        </div>
      </div>

      {transcript && (
        <div className="cr-fc-sec">
          <div className="cr-fc-label">Dein Text</div>
          <p className="cr-fc-orig" dangerouslySetInnerHTML={{ __html: hl }} />
        </div>
      )}

      {correctedText && (
        <div className="cr-fc-sec">
          <div className="cr-fc-label">Korrektur</div>
          <p className="cr-fc-corr corrected-text">{correctedText}</p>
        </div>
      )}

      {errors.length > 0 && (
        <div className="cr-fc-sec">
          <div className="cr-fc-label">Fehler</div>
          <div className="cr-fc-errors">
            {errors.map((e, i) => (
              <div key={i} className="cr-fc-erow">
                <span className="error-text cr-fc-eorig">{e.original}</span>
                <span className="cr-fc-arrow">→</span>
                <span className="corrected-text cr-fc-efix">{e.correction}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {fb && (
        <div className="cr-fc-sec cr-fc-sec-last">
          <div className="cr-fc-label">Feedback</div>
          <p className="cr-fc-text">{fb}</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Redemittel Panel
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_RDMT = [
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
function RedemittelPanel({ items = [] }) {
  const [open, setOpen] = useState(false);
  const list = items.length ? items : DEFAULT_RDMT;
  return (
    <div className={`cr-rdm${open ? " cr-rdm-open" : ""}`}>
      <button className="cr-rdm-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="cr-rdm-chev">{open ? "▾" : "▸"}</span>
        <span className="cr-rdm-lbl">Redemittel</span>
        <span className="cr-rdm-cnt">{list.length}</span>
      </button>
      {open && (
        <ul className="cr-rdm-list">
          {list.map((item, i) => (
            <li key={i} className="cr-rdm-item">
              <span className="cr-rdm-dot" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit Confirm Modal
// ─────────────────────────────────────────────────────────────────────────────
function ExitModal({ onConfirm, onCancel }) {
  return (
    <div className="cr-modal-overlay">
      <div className="cr-modal">
        <div className="cr-modal-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </div>
        <h3 className="cr-modal-title">Übung abbrechen?</h3>
        <p className="cr-modal-body">
          Bist du sicher? Dein Fortschritt wird nicht gespeichert.
        </p>
        <div className="cr-modal-btns">
          <button className="cr-modal-yes" onClick={onConfirm}>Ja, beenden</button>
          <button className="cr-modal-no" onClick={onCancel}>Weitermachen</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn Badge
// ─────────────────────────────────────────────────────────────────────────────
function TurnBadge({ mine, partnerName }) {
  return (
    <div className={`cr-turn${mine ? " cr-turn-mine" : " cr-turn-other"}`}>
      <span className={`cr-turn-dot${mine ? " cr-turn-dot-mine" : ""}`} />
      {mine ? "Du bist dran" : `${partnerName} spricht`}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────
function Header({ round, partnerName, isMulti, blockExit, onExit, isRecording, amSpeaker }) {
  return (
    <header className="cr-header">
      <div className="cr-logo">
        <span className="cr-logo-b2">B2</span>
        <span className="cr-logo-beruf">Beruf</span>
      </div>
      <div className="cr-header-meta">
        {isMulti && (
          <span className="cr-partner-badge">
            <span className="cr-partner-dot" />
            {partnerName}
          </span>
        )}
        <span className="cr-round-badge">Runde {round} / 2</span>
        {isRecording && amSpeaker && (
          <span className="cr-rec-badge">
            <span className="cr-rec-dot" />
            REC
          </span>
        )}
      </div>
      <button
        className={`cr-exit-btn${blockExit ? " cr-exit-locked" : ""}`}
        onClick={onExit}
        disabled={blockExit}
        aria-label={blockExit ? "Bitte warten" : "Beenden"}
      >
        {blockExit ? <LockIcon size={14} /> : <CloseIcon size={17} />}
      </button>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────
export default function ChallengeRoom({
  mode = "solo",
  roomId = null,
  currentUser,
  questions: propQuestions = [],
  onExit,
  heroBgImage = "/1000188762.png",
}) {
  const me = currentUser || { uid: "demo", displayName: "Du" };
  const isSolo = mode === "solo";
  const isMulti = mode === "multi";

  // ── roomState — control plane (status, speaker, timer, round) ────────────
  const [rs, setRs] = useState({
    status: "intro",
    currentSpeaker: me.uid,
    timerPhase: "prep",
    timerEndsAt: null,
    currentQuestionId: null,
    round: 1,
  });

  // ── Separate data-plane state (own listeners, never inside roomState) ─────
  const [myTranscript,      setMyTranscript]      = useState({ final: "", interim: "" });
  const [partnerTranscript, setPartnerTranscript] = useState({ final: "", interim: "" });
  const [myAnalysis,        setMyAnalysis]        = useState(null);   // feedbackObj | null
  const [partnerAnalysis,   setPartnerAnalysis]   = useState(null);
  const [isAnalyzingMe,     setIsAnalyzingMe]     = useState(false);  // rooms/.../analyzing/{uid}
  const [isAnalyzingPartner,setIsAnalyzingPartner]= useState(false);
  // Questions can come from Firebase (multi) or props (solo)
  const [fbQuestions,       setFbQuestions]       = useState([]);
  const [fbUsedIds,         setFbUsedIds]         = useState([]);

  // ── Local-only UI state ───────────────────────────────────────────────────
  const [phaseAnim,       setPhaseAnim]       = useState("in");
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [localUsedIds,    setLocalUsedIds]    = useState([]);   // solo only
  const [isRecording,     setIsRecording]     = useState(false);
  const [fbReady,         setFbReady]         = useState(!isMulti);
  const [partnerName,     setPartnerName]     = useState("Partner");
  const [partnerUid,      setPartnerUid]      = useState(null);

  // ── Stable refs ──────────────────────────────────────────────────────────
  const transcriptRef   = useRef("");     // always-current confirmed transcript (local to speaker)
  const partnerUidRef   = useRef(null);
  const masterTimerRef  = useRef(null);
  // FIX 2: track which timerEndsAt value the master interval was started for
  const masterEndsAtRef = useRef(null);
  const rsRef           = useRef(rs);

  useEffect(() => { rsRef.current = rs; }, [rs]);
  useEffect(() => { partnerUidRef.current = partnerUid; }, [partnerUid]);

  useEffect(() => () => clearInterval(masterTimerRef.current), []);

  // ── Derived ───────────────────────────────────────────────────────────────
  const questions  = isMulti && fbQuestions.length ? fbQuestions : propQuestions;
  const usedIds    = isMulti ? fbUsedIds : localUsedIds;
  const status     = rs.status;
  const amSpeaker  = rs.currentSpeaker === me.uid;
  const totalSec   = rs.timerPhase === "prep" ? PREP_SEC : SPEAK_SEC;

  // Overlay shows if either user is analyzing
  const anyAnalyzing = isAnalyzingMe || isAnalyzingPartner;
  const blockExit    = anyAnalyzing;

  const currentQ = questions.find((q) => q.id === rs.currentQuestionId) || null;

  // ── Timer display ─────────────────────────────────────────────────────────
  const timeLeft = useTimerDisplay(rs.timerEndsAt, totalSec);

  // ─────────────────────────────────────────────────────────────────────────
  // Firebase listeners — multi only
  // FIX 1: setRs is called ONLY from the onValue callback, never from UI code
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isMulti || !roomId) return;
    const cleanups = [];

    (async () => {
      // ── Players ──
      cleanups.push(
        await fbListen(`rooms/${roomId}/players`, (players) => {
          if (!players) return;
          const amA = players.A?.uid === me.uid;
          const p   = amA ? players.B : players.A;
          if (p?.displayName) setPartnerName(p.displayName);
          if (p?.uid)         setPartnerUid(p.uid);
        })
      );

      // ── roomState (control plane) ──
      // FIX 1: This is the ONLY place setRs is called in multi mode.
      // FIX 2: masterEndsAtRef prevents countdown restart on unrelated snapshots.
      cleanups.push(
        await fbListen(`rooms/${roomId}/roomState`, (data) => {
          setFbReady(true);
          if (!data) return;
          setRs((prev) => ({ ...prev, ...data }));

          // FIX 2: only restart countdown when timerEndsAt actually changes
          if (
            data.currentSpeaker === me.uid &&
            data.timerEndsAt &&
            data.timerEndsAt !== masterEndsAtRef.current
          ) {
            masterEndsAtRef.current = data.timerEndsAt;
            startMasterCountdown(data.timerEndsAt, data.timerPhase);
          } else if (data.currentSpeaker !== me.uid) {
            clearInterval(masterTimerRef.current);
            masterEndsAtRef.current = null;
          }
        })
      );

      // ── FIX 3: Transcript listeners (separate path, not inside roomState) ──
      // My own transcript (written by me, confirmed round-trip)
      cleanups.push(
        await fbListen(`rooms/${roomId}/transcript/${me.uid}`, (data) => {
          if (!data) return;
          setMyTranscript({ final: data.final || "", interim: data.interim || "" });
          // Keep transcriptRef current for the speaker
          if (data.final !== undefined) transcriptRef.current = data.final;
        })
      );

      // Partner transcript (written by partner, read by us)
      // Partner uid might not be known yet — re-subscribe when it arrives
    })();

    return () => cleanups.forEach((fn) => fn?.());
  }, [isMulti, roomId]);

  // Re-subscribe to partner transcript when partnerUid resolves
  useEffect(() => {
    if (!isMulti || !roomId || !partnerUid) return;
    let cleanup = () => {};
    (async () => {
      // FIX 3: partner transcript at separate path
      cleanup = await fbListen(
        `rooms/${roomId}/transcript/${partnerUid}`,
        (data) => {
          setPartnerTranscript({
            final:   data?.final   || "",
            interim: data?.interim || "",
          });
        }
      );

      // FIX 4: analysis results listener
      const cleanAnalysisMe = await fbListen(
        `rooms/${roomId}/analysis/${me.uid}`,
        (data) => { if (data) setMyAnalysis(data); }
      );
      const cleanAnalysisPartner = await fbListen(
        `rooms/${roomId}/analysis/${partnerUid}`,
        (data) => { if (data) setPartnerAnalysis(data); }
      );

      // FIX 5: analyzing flags — separate per-uid paths
      const cleanFlagMe = await fbListen(
        `rooms/${roomId}/analyzing/${me.uid}`,
        (val) => setIsAnalyzingMe(!!val)
      );
      const cleanFlagPartner = await fbListen(
        `rooms/${roomId}/analyzing/${partnerUid}`,
        (val) => setIsAnalyzingPartner(!!val)
      );

      // Questions and used IDs (shared)
      const cleanQ = await fbListen(
        `rooms/${roomId}/questions`,
        (data) => { if (Array.isArray(data)) setFbQuestions(data); }
      );
      const cleanUsed = await fbListen(
        `rooms/${roomId}/usedQuestions`,
        (data) => { if (Array.isArray(data)) setFbUsedIds(data); }
      );

      cleanup = () => {
        cleanAnalysisMe();
        cleanAnalysisPartner();
        cleanFlagMe();
        cleanFlagPartner();
        cleanQ();
        cleanUsed();
      };
    })();

    return () => cleanup();
  }, [isMulti, roomId, partnerUid]);

  // ─────────────────────────────────────────────────────────────────────────
  // pushRS — writes to Firebase (multi) or local state (solo)
  // FIX 1: In multi mode ONLY writes to Firebase; setRs is driven by listener
  // ─────────────────────────────────────────────────────────────────────────
  const pushRS = useCallback(
    async (partial) => {
      if (isMulti && roomId) {
        await fbUpdate(`rooms/${roomId}/roomState`, partial);
        // Do NOT call setRs here. The onValue listener will call it.
      } else {
        setRs((prev) => ({ ...prev, ...partial }));
      }
    },
    [isMulti, roomId]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Room Master countdown — FIX 2: guarded by masterEndsAtRef
  // ─────────────────────────────────────────────────────────────────────────
  function startMasterCountdown(endsAt, timerPhase) {
    clearInterval(masterTimerRef.current);
    masterTimerRef.current = setInterval(() => {
      const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      if (left <= 0) {
        clearInterval(masterTimerRef.current);
        masterEndsAtRef.current = null;
        if (timerPhase === "prep") {
          const q = questions.find((q) => q.id === rsRef.current.currentQuestionId);
          if (q) beginSpeaking(q);
        } else {
          handleSpeakEnd();
        }
      }
    }, 500);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Transcript push — FIX 3: writes to separate transcript path, not roomState
  // ─────────────────────────────────────────────────────────────────────────
  const pushTranscript = useCallback(
    async (field, value) => {
      if (isMulti && roomId) {
        await fbSet(`rooms/${roomId}/transcript/${me.uid}/${field}`, value);
      } else {
        // Solo: update local state directly
        setMyTranscript((prev) => ({ ...prev, [field]: value }));
        if (field === "final") transcriptRef.current = value;
      }
    },
    [isMulti, roomId, me.uid]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Speech recognition handlers
  // ─────────────────────────────────────────────────────────────────────────
  const handleFinal = useCallback(
    (rawChunk) => {
      const existing = transcriptRef.current;
      const clean    = sanitizeFinalChunk(existing, rawChunk);
      if (!clean) return;

      const updated = (existing + (existing ? " " : "") + clean)
        .replace(/\s{2,}/g, " ")
        .trim();

      transcriptRef.current = updated;
      pushTranscript("final", updated);
      pushTranscript("interim", "");
    },
    [pushTranscript]
  );

  const handleInterim = useCallback(
    (text) => {
      // Interim: only push for partner display; does NOT touch transcriptRef
      pushTranscript("interim", text);
    },
    [pushTranscript]
  );

  const micActive = status === "speaking" && amSpeaker && isRecording;

  const { start: startRecog, stop: stopRecog } = useSpeechRecognition({
    onFinal:  handleFinal,
    onInterim: handleInterim,
    active:   micActive,
  });

  useEffect(() => {
    if (micActive) startRecog();
    else stopRecog();
    return () => stopRecog();
  }, [micActive]);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase animation
  // ─────────────────────────────────────────────────────────────────────────
  function animTransition() {
    setPhaseAnim("out");
    setTimeout(() => setPhaseAnim("in"), 220);
  }

  function handleExitRequest() {
    if (blockExit) return;
    if (status === "intro" || status === "finished") { onExit?.(); return; }
    setShowExitConfirm(true);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Game flow helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Mark used question IDs in Firebase (multi) or local (solo) */
  async function markUsed(qId) {
    if (isMulti && roomId) {
      const next = [...fbUsedIds, qId];
      await fbSet(`rooms/${roomId}/usedQuestions`, next);
    } else {
      setLocalUsedIds((prev) => [...prev, qId]);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1: Prep
  // ─────────────────────────────────────────────────────────────────────────
  async function beginPrep(questionOverride) {
    if (isMulti && !amSpeaker) return;

    transcriptRef.current = "";
    setMyTranscript({ final: "", interim: "" });
    setPartnerTranscript({ final: "", interim: "" });
    setMyAnalysis(null);
    setPartnerAnalysis(null);

    const q      = questionOverride || pickRandom(questions, usedIds);
    const endsAt = Date.now() + PREP_SEC * 1000;

    await markUsed(q.id);

    // FIX 3: Clear transcript paths before new round
    if (isMulti && roomId) {
      await fbSet(`rooms/${roomId}/transcript/${me.uid}`, { final: "", interim: "" });
      if (partnerUidRef.current) {
        await fbSet(`rooms/${roomId}/transcript/${partnerUidRef.current}`, { final: "", interim: "" });
      }
      // FIX 4: Clear analysis paths
      await fbSet(`rooms/${roomId}/analysis/${me.uid}`, null);
      if (partnerUidRef.current) {
        await fbSet(`rooms/${roomId}/analysis/${partnerUidRef.current}`, null);
      }
    }

    await pushRS({
      status:            "prep",
      currentSpeaker:    me.uid,
      timerPhase:        "prep",
      timerEndsAt:       endsAt,
      currentQuestionId: q.id,
      round:             rsRef.current.round,
    });

    // In solo, start master countdown directly (no Firebase listener)
    if (isSolo) {
      masterEndsAtRef.current = endsAt;
      startMasterCountdown(endsAt, "prep");
    }

    animTransition();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2: Speaking
  // ─────────────────────────────────────────────────────────────────────────
  async function beginSpeaking(q) {
    if (isMulti && !amSpeaker) return;
    clearInterval(masterTimerRef.current);

    setIsRecording(true);
    playBeep({ freq: 660, gain: 0.4 });

    const endsAt = Date.now() + SPEAK_SEC * 1000;

    await pushRS({
      status:      "speaking",
      timerPhase:  "speak",
      timerEndsAt: endsAt,
    });

    if (isSolo) {
      masterEndsAtRef.current = endsAt;
      startMasterCountdown(endsAt, "speak");
    }

    animTransition();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3: Speak end → analyzing
  // FIX 4: AI result written to rooms/.../analysis/{uid} (not inside roomState)
  // FIX 5: analyzing flag written to rooms/.../analyzing/{uid} (not merged object)
  // ─────────────────────────────────────────────────────────────────────────
  async function handleSpeakEnd() {
    if (isMulti && !amSpeaker) return;
    clearInterval(masterTimerRef.current);
    masterEndsAtRef.current = null;

    setIsRecording(false);
    stopRecog();
    playBeep({ freq: 440, gain: 0.3 });

    const finalTranscript = transcriptRef.current;

    // Transition status to analyzing (both users see this phase)
    await pushRS({ status: "analyzing", timerEndsAt: null });

    // FIX 5: write ONLY our own flag (no object merge race)
    const flagPath = isMulti && roomId
      ? `rooms/${roomId}/analyzing/${me.uid}`
      : null;

    if (flagPath) await fbSet(flagPath, true);
    else          setIsAnalyzingMe(true);

    animTransition();

    try {
      const result = await fetchAIFeedback(finalTranscript);
      if (result) {
        const payload = { ...result, transcript: finalTranscript };
        if (isMulti && roomId) {
          // FIX 4: write to dedicated analysis path — both clients' listeners pick it up
          await fbSet(`rooms/${roomId}/analysis/${me.uid}`, payload);
        } else {
          setMyAnalysis(payload);
        }
      }
    } catch (err) {
      console.error("AI error:", err);
    } finally {
      // FIX 5: clear ONLY our own flag
      if (flagPath) await fbSet(flagPath, false);
      else          setIsAnalyzingMe(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 4: Continue from review screen
  // FIX 6: amSpeaker is derived from confirmed Firebase state after pushRS,
  //   so we check rs.round against the VALUE BEFORE pushRS, then switch speaker.
  // ─────────────────────────────────────────────────────────────────────────
  async function handleContinue() {
    if (isSolo || rs.round >= 2) {
      await pushRS({ status: "finished" });
    } else {
      // Transfer speaker role to partner for round 2
      // FIX 6: nextSpeaker resolved before pushRS so there's no timing ambiguity
      const nextSpeaker = partnerUidRef.current || me.uid;
      await pushRS({
        status:         "switching",
        round:          rs.round + 1,
        currentSpeaker: nextSpeaker,
        timerEndsAt:    null,
      });
    }
    animTransition();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 5: Switch — the new Room Master starts their prep
  // FIX 6: amSpeaker here is already confirmed from Firebase listener,
  //   so this button only appears when Firebase has confirmed the role swap.
  // ─────────────────────────────────────────────────────────────────────────
  async function handleSwitchStart() {
    await beginPrep();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,400&display=swap"
        rel="stylesheet"
      />

      <div className="cr-root">
        <div className="cr-bg-dim" />

        {/* Global AI overlay — shown when EITHER user is analyzing */}
        {anyAnalyzing && <AIAnalyzingOverlay />}

        {showExitConfirm && !blockExit && (
          <ExitModal
            onConfirm={() => { setShowExitConfirm(false); onExit?.(); }}
            onCancel={() => setShowExitConfirm(false)}
          />
        )}

        {/* ── INTRO ──────────────────────────────────────────────────── */}
        {status === "intro" && (
          <div className="cr-intro">
            <div
              className="cr-hero-bg"
              style={{ backgroundImage: `url(${heroBgImage})` }}
            />
            <div className="cr-hero-top" />
            <div className="cr-hero-bot" />
            <Header
              round={rs.round} partnerName={partnerName} isMulti={isMulti}
              blockExit={blockExit} onExit={handleExitRequest}
              isRecording={false} amSpeaker={amSpeaker}
            />
            <div className="cr-hero-content">
              <div className="cr-hero-eyebrow">
                Deutschprüfung B2 · Mündliche Kommunikation
              </div>
              <h1 className="cr-hero-title">
                Bereit für
                <br />
                <span className="cr-hero-accent">deine Prüfung?</span>
              </h1>
              <p className="cr-hero-sub">
                {isSolo
                  ? "Solo-Übung · 30 s Vorbereitung · 3 min Sprechen · KI-Feedback"
                  : `Duell mit ${partnerName} · 2 Runden · Live-Transkript · KI-Auswertung`}
              </p>
              <div className="cr-hero-meta-row">
                {[
                  ["⏱", "30 s Vorbereitung"],
                  ["🎙", "3 min Sprechen"],
                  ["🤖", "KI-Auswertung"],
                  ["📋", "Redemittel"],
                ].map(([icon, label], i, arr) => (
                  <span key={i} style={{ display: "contents" }}>
                    <div className="cr-hero-meta-item">
                      <span>{icon}</span>
                      <span>{label}</span>
                    </div>
                    {i < arr.length - 1 && <div className="cr-hero-meta-div" />}
                  </span>
                ))}
              </div>
              {!isMulti || fbReady ? (
                <button className="cr-hero-btn" onClick={() => beginPrep()}>
                  <span>Übung starten</span>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M5 12h14M13 6l6 6-6 6"
                      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : (
                <p className="cr-hero-sub" style={{ marginTop: 24, color: "var(--acc)" }}>
                  Verbinde mit Raum…
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── ALL NON-INTRO PHASES ────────────────────────────────────── */}
        {status !== "intro" && (
          <>
            <Header
              round={rs.round} partnerName={partnerName} isMulti={isMulti}
              blockExit={blockExit} onExit={handleExitRequest}
              isRecording={isRecording} amSpeaker={amSpeaker}
            />

            <main className={`cr-main cr-main-${phaseAnim}`}>

              {/* ── PREP / SPEAKING ─────────────────────────────────── */}
              {(status === "prep" || status === "speaking") && currentQ && (
                <div className="cr-game">
                  {/* Timer column */}
                  <div className="cr-timer-col">
                    <CircularTimer
                      timeLeft={timeLeft} totalTime={totalSec} phase={rs.timerPhase}
                    />
                    <div className={`cr-phase-pill cr-phase-pill-${rs.timerPhase}`}>
                      {rs.timerPhase === "prep" ? "Vorbereitung" : "Sprechen"}
                    </div>

                    {status === "prep" && amSpeaker && (
                      <button className="cr-skip" onClick={() => beginSpeaking(currentQ)}>
                        Jetzt sprechen →
                      </button>
                    )}

                    {isMulti && (
                      <TurnBadge mine={amSpeaker} partnerName={partnerName} />
                    )}
                    {isMulti && (
                      <div className="cr-role-badge">
                        {amSpeaker ? "🎙 Sprecher" : "👂 Zuhörer"}
                      </div>
                    )}

                    {/* Mic button — only shown to Room Master */}
                    {status === "speaking" && amSpeaker && (
                      <button
                        className={`cr-mic${isRecording ? " cr-mic-on" : ""}`}
                        onClick={() => setIsRecording((r) => !r)}
                        title={isRecording ? "Stumm" : "Aktivieren"}
                      >
                        {isRecording ? <MicOnIcon /> : <MicOffIcon />}
                        <span>{isRecording ? "Aktiv" : "Stumm"}</span>
                      </button>
                    )}

                    {/* FIX: Listener mic is visually locked — no onClick, no pointer events */}
                    {status === "speaking" && !amSpeaker && isMulti && (
                      <>
                        <div className="cr-listening-badge">
                          <span className="cr-listening-dot" />
                          Zuhören…
                        </div>
                        <div className="cr-mic cr-mic-locked" aria-disabled="true">
                          <LockIcon size={14} />
                          <span>Gesperrt</span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Card column */}
                  <div className="cr-card-col">
                    <div className="cr-topic-chip">{currentQ.topic || "Thema"}</div>
                    <div className="cr-q-card">
                      <div className="cr-q-num">Aufgabe</div>
                      <p className="cr-q-text">{currentQ.question}</p>
                    </div>
                    <RedemittelPanel items={currentQ.redemittel} />
                    {status === "speaking" && (
                      <LiveTranscriptBox
                        myFinal={myTranscript.final}
                        myInterim={myTranscript.interim}
                        partnerFinal={partnerTranscript.final}
                        partnerInterim={partnerTranscript.interim}
                        isSpeaker={amSpeaker}
                        isMulti={isMulti}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* ── ANALYZING ───────────────────────────────────────── */}
              {status === "analyzing" && (
                <div className="cr-center">
                  <div className="cr-assess-wide">
                    <div className="cr-assess-hdr">
                      <div className="cr-assess-icon-lbl">✍️</div>
                      <h2 className="cr-assess-h">Auswertung</h2>
                      <p className="cr-assess-sub">KI-gestützte Sprachanalyse</p>
                    </div>

                    {/* My feedback card */}
                    <AIFeedbackCard
                      feedback={myAnalysis}
                      transcript={myTranscript.final}
                      isLoading={!myAnalysis && isAnalyzingMe}
                    />

                    {/* Partner feedback card (multi only) */}
                    {isMulti && (
                      <AIFeedbackCard
                        ownerLabel={`🤝 ${partnerName}s Auswertung`}
                        feedback={partnerAnalysis}
                        transcript={partnerTranscript.final}
                        isLoading={!partnerAnalysis && isAnalyzingPartner}
                      />
                    )}

                    {/* Continue button — only shown once MY analysis is ready */}
                    {myAnalysis && (
                      <div className="cr-assess-card">
                        <p className="cr-assess-note-lbl">Eigene Notizen (optional)</p>
                        <textarea
                          className="cr-assess-ta"
                          placeholder="Notizen auf Deutsch …"
                          rows={3}
                        />
                        <button
                          className="cr-primary-btn"
                          style={{ alignSelf: "flex-end" }}
                          disabled={anyAnalyzing}
                          onClick={handleContinue}
                        >
                          {isSolo || rs.round >= 2
                            ? "Zur Abschlussbewertung →"
                            : "Nächste Runde →"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── SWITCHING ───────────────────────────────────────── */}
              {/* FIX 6: amSpeaker here is confirmed from Firebase, so the button
                  only appears on the client that Firebase says is the new speaker */}
              {status === "switching" && (
                <div className="cr-center">
                  <div className="cr-switch-card">
                    <div className="cr-switch-icon">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"
                          stroke="#4f9eff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <h2 className="cr-switch-title">Rollenwechsel</h2>
                    <p className="cr-switch-sub">
                      Runde {rs.round} · Nächster Sprecher:&nbsp;
                      <strong>{amSpeaker ? "Du" : partnerName}</strong>
                    </p>
                    {/* Only the confirmed new speaker sees this button */}
                    {amSpeaker ? (
                      <button className="cr-primary-btn" onClick={handleSwitchStart}>
                        Runde {rs.round} starten →
                      </button>
                    ) : (
                      <p className="cr-switch-wait">Warte auf {partnerName}…</p>
                    )}
                  </div>
                </div>
              )}

              {/* ── FINISHED ────────────────────────────────────────── */}
              {status === "finished" && (
                <div className="cr-center">
                  <div className="cr-finish-wide">
                    <div className="cr-finish-card">
                      <div className="cr-finish-trophy">🏆</div>
                      <h1 className="cr-finish-title">Geschafft!</h1>
                      <p className="cr-finish-sub">Hervorragende Arbeit!</p>
                      {myAnalysis && (
                        <div className="cr-finish-score">
                          <svg viewBox="0 0 120 120" width="130" height="130">
                            <circle
                              cx="60" cy="60" r="52" fill="none"
                              stroke="rgba(79,158,255,.1)" strokeWidth="10"
                            />
                            <circle
                              cx="60" cy="60" r="52" fill="none" stroke="#4f9eff"
                              strokeWidth="10" strokeLinecap="round"
                              strokeDasharray={`${2 * Math.PI * 52}`}
                              strokeDashoffset={`${2 * Math.PI * 52 * (1 - (myAnalysis.score || 0) / 5)}`}
                              transform="rotate(-90 60 60)"
                              style={{ transition: "stroke-dashoffset 1.2s ease" }}
                            />
                            <text
                              x="60" y="56" textAnchor="middle" dominantBaseline="middle"
                              fill="#fff" fontSize="28" fontWeight="700" fontFamily="Syne"
                            >
                              {myAnalysis.score}
                            </text>
                            <text
                              x="60" y="76" textAnchor="middle" dominantBaseline="middle"
                              fill="rgba(255,255,255,.4)" fontSize="10" fontFamily="Syne"
                            >
                              VON 5
                            </text>
                          </svg>
                          {myAnalysis.feedback && (
                            <p className="cr-finish-fb">{myAnalysis.feedback}</p>
                          )}
                        </div>
                      )}
                      <button
                        className="cr-primary-btn cr-finish-btn"
                        onClick={() => onExit?.()}
                      >
                        Beenden
                      </button>
                    </div>

                    <AIFeedbackCard
                      feedback={myAnalysis}
                      transcript={myTranscript.final}
                      isLoading={false}
                    />

                    {isMulti && partnerAnalysis && (
                      <AIFeedbackCard
                        ownerLabel={`🤝 ${partnerName}s Auswertung`}
                        feedback={partnerAnalysis}
                        transcript={partnerTranscript.final}
                        isLoading={false}
                      />
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

// ─────────────────────────────────────────────────────────────────────────────
// Styles (unchanged from v5 except cr-fc-owner-label addition)
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,400&display=swap');

.cr-root {
  --bg:#0e1018; --surface:#161925; --surface2:#1c2030; --surface3:#232840;
  --border:rgba(255,255,255,.07); --border-b:rgba(255,255,255,.12);
  --border-acc:rgba(79,158,255,.3); --text:#e8eaf2; --muted:#7e8aaa;
  --dim:#464e6a; --acc:#4f9eff; --acc-dim:rgba(79,158,255,.15);
  --acc-glow:rgba(79,158,255,.3); --red:#ff4d4d; --red-dim:rgba(255,77,77,.12);
  --amber:#f59e0b; --green:#34d399; --green-dim:rgba(52,211,153,.12);
  --r:18px; --rs:12px; --fd:'Syne',system-ui,sans-serif; --fb:'DM Sans',system-ui,sans-serif;
  background:var(--bg); color:var(--text); min-height:100vh;
  font-family:var(--fb); position:relative; overflow-x:hidden;
  display:flex; flex-direction:column;
}
.cr-bg-dim {
  position:fixed; inset:0; pointer-events:none; z-index:0;
  background:
    radial-gradient(ellipse 80% 60% at 20% 10%,rgba(30,40,80,.4),transparent 70%),
    radial-gradient(ellipse 60% 50% at 80% 90%,rgba(10,20,50,.5),transparent 70%);
}
@keyframes cr-slow-zoom { 0%{transform:scale(1)} 100%{transform:scale(1.12)} }
@keyframes cr-fade-up   { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:none} }
@keyframes cr-pulse     { 0%,100%{transform:scale(1)} 50%{transform:scale(1.05)} }
@keyframes cr-glow      { 0%,100%{box-shadow:0 0 24px rgba(79,158,255,.2)} 50%{box-shadow:0 0 40px rgba(79,158,255,.45)} }
@keyframes cr-spin      { to{transform:rotate(360deg)} }
@keyframes cr-blink     { 0%,100%{opacity:1} 50%{opacity:.3} }
@keyframes cr-bounce    { 0%,80%,100%{transform:scale(0);opacity:0} 40%{transform:scale(1);opacity:1} }
@keyframes cr-modal-in  { from{opacity:0;transform:scale(.94) translateY(10px)} to{opacity:1;transform:none} }
@keyframes cr-ol-in     { from{opacity:0} to{opacity:1} }

.cr-ai-overlay {
  position:fixed; inset:0; z-index:1200;
  background:rgba(6,8,18,.86); backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px);
  display:flex; align-items:center; justify-content:center; padding:24px;
  animation:cr-ol-in .28s ease;
}
.cr-ai-card {
  background:linear-gradient(145deg,#1c2138,#141828);
  border:1px solid rgba(79,158,255,.3); border-radius:var(--r);
  padding:48px 44px; text-align:center; max-width:400px; width:100%;
  box-shadow:0 0 80px rgba(79,158,255,.1),0 40px 80px rgba(0,0,0,.7);
  display:flex; flex-direction:column; align-items:center; gap:16px;
  position:relative; overflow:hidden;
}
.cr-ai-card::before {
  content:''; position:absolute; top:0; left:0; right:0; height:1px;
  background:linear-gradient(90deg,transparent,rgba(79,158,255,.5),transparent);
}
.cr-ai-ring  { position:relative; width:80px; height:80px; display:flex; align-items:center; justify-content:center; }
.cr-ai-ring svg { position:absolute; inset:0; }
.cr-ai-emoji { font-size:28px; position:relative; z-index:1; }
.cr-ai-title { font-family:var(--fd); font-size:20px; font-weight:700; color:#fff; margin:0; }
.cr-ai-sub   { font-family:var(--fb); font-size:14px; color:var(--muted); line-height:1.7; margin:0; }
.cr-ai-dots  { display:flex; gap:6px; }
.cr-ai-dot   { width:8px; height:8px; border-radius:50%; background:var(--acc); animation:cr-bounce 1.2s ease-in-out infinite; }
.cr-ai-lock  { display:flex; align-items:center; justify-content:center; font-family:var(--fb); font-size:11px; color:var(--dim); line-height:1.5; }

.cr-header {
  display:flex; align-items:center; justify-content:space-between;
  padding:18px 28px; border-bottom:1px solid var(--border);
  position:relative; z-index:10;
  background:rgba(14,16,24,.88); backdrop-filter:blur(16px); flex-shrink:0;
}
.cr-logo        { display:flex; align-items:baseline; gap:6px; }
.cr-logo-b2     { font-family:var(--fd); font-weight:800; font-size:22px; color:var(--acc); }
.cr-logo-beruf  { font-family:var(--fd); font-weight:600; font-size:12px; color:var(--muted); letter-spacing:2.5px; text-transform:uppercase; }
.cr-header-meta { display:flex; align-items:center; gap:10px; }
.cr-round-badge { background:var(--surface2); border:1px solid var(--border-b); color:var(--muted); font-family:var(--fd); font-size:11px; font-weight:600; padding:5px 14px; border-radius:100px; }
.cr-partner-badge { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--muted); }
.cr-partner-dot   { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 7px var(--green); }
.cr-rec-badge   { display:flex; align-items:center; gap:5px; background:rgba(255,77,77,.1); border:1px solid rgba(255,77,77,.3); color:var(--red); font-family:var(--fd); font-size:10px; font-weight:700; letter-spacing:1.5px; padding:4px 10px; border-radius:100px; }
.cr-rec-dot     { width:6px; height:6px; border-radius:50%; background:var(--red); animation:cr-blink 1s ease-in-out infinite; }
.cr-exit-btn    { background:var(--surface2); border:1px solid var(--border-b); color:var(--muted); cursor:pointer; width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition:all .2s; flex-shrink:0; }
.cr-exit-btn:hover:not(:disabled) { background:var(--surface3); color:var(--text); border-color:rgba(255,255,255,.22); }
.cr-exit-locked { opacity:.35; cursor:not-allowed!important; pointer-events:none; }

.cr-intro       { position:relative; min-height:100vh; display:flex; flex-direction:column; overflow:hidden; }
.cr-hero-bg     { position:absolute; inset:-8%; background-size:cover; background-position:center; animation:cr-slow-zoom 18s ease-in-out infinite alternate; z-index:0; }
.cr-hero-top    { position:absolute; top:0; left:0; right:0; height:220px; background:linear-gradient(to bottom,rgba(10,12,22,.92),transparent); z-index:1; pointer-events:none; }
.cr-hero-bot    { position:absolute; bottom:0; left:0; right:0; height:75%; background:linear-gradient(to top,rgba(8,10,20,.98) 0%,rgba(8,10,20,.9) 30%,rgba(8,10,20,.6) 60%,transparent); z-index:1; pointer-events:none; }
.cr-hero-content{ position:relative; z-index:5; flex:1; display:flex; flex-direction:column; align-items:flex-start; justify-content:flex-end; padding:0 56px 64px; max-width:800px; animation:cr-fade-up .8s ease both .15s; }
.cr-hero-eyebrow{ font-family:var(--fd); font-size:11px; font-weight:600; letter-spacing:3px; text-transform:uppercase; color:var(--acc); margin-bottom:18px; }
.cr-hero-title  { font-family:var(--fd); font-size:clamp(44px,7vw,80px); font-weight:800; line-height:1.05; letter-spacing:-2px; color:#fff; margin:0 0 20px; }
.cr-hero-accent { background:linear-gradient(120deg,#4f9eff,#a78bfa); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
.cr-hero-sub    { font-family:var(--fb); font-size:16px; color:rgba(255,255,255,.55); margin-bottom:32px; line-height:1.6; }
.cr-hero-meta-row  { display:flex; align-items:center; margin-bottom:40px; flex-wrap:wrap; gap:8px; }
.cr-hero-meta-item { display:flex; align-items:center; gap:7px; font-size:13px; color:rgba(255,255,255,.5); }
.cr-hero-meta-div  { width:1px; height:14px; background:rgba(255,255,255,.18); margin:0 12px; }
.cr-hero-btn {
  display:inline-flex; align-items:center; gap:12px;
  background:linear-gradient(135deg,#3b82f6,#6366f1);
  color:#fff; border:none; padding:16px 36px; border-radius:100px;
  font-family:var(--fd); font-size:16px; font-weight:700; cursor:pointer;
  box-shadow:0 0 0 1px rgba(255,255,255,.1) inset,0 12px 32px rgba(79,100,255,.45);
  transition:transform .18s,box-shadow .18s; animation:cr-glow 3s ease-in-out infinite;
}
.cr-hero-btn:hover { transform:translateY(-3px); box-shadow:0 0 0 1px rgba(255,255,255,.15) inset,0 18px 44px rgba(79,100,255,.55); }
@media(max-width:640px){ .cr-hero-content{padding:0 24px 48px} .cr-hero-title{font-size:40px;letter-spacing:-1px} }

.cr-main      { position:relative; z-index:1; flex:1; display:flex; flex-direction:column; transition:opacity .22s,transform .22s; }
.cr-main-in   { opacity:1; transform:none; }
.cr-main-out  { opacity:0; transform:translateY(12px); }
.cr-center    { display:flex; align-items:flex-start; justify-content:center; flex:1; padding:40px 24px; min-height:70vh; }

.cr-game { display:grid; grid-template-columns:180px 1fr; gap:36px; padding:40px 48px; align-items:start; max-width:1020px; margin:0 auto; width:100%; box-sizing:border-box; }
@media(max-width:740px){ .cr-game{grid-template-columns:1fr;padding:24px 20px;gap:24px} }

.cr-timer-col   { display:flex; flex-direction:column; align-items:center; gap:14px; position:sticky; top:28px; }
.cr-timer-wrap  { position:relative; filter:drop-shadow(0 0 20px rgba(79,158,255,.15)); }
.cr-timer-urgent{ animation:cr-pulse .7s ease-in-out infinite; }
.cr-phase-pill  { font-family:var(--fd); font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; padding:5px 16px; border-radius:100px; }
.cr-phase-pill-prep  { background:rgba(245,158,11,.1); color:var(--amber); border:1px solid rgba(245,158,11,.25); }
.cr-phase-pill-speak { background:var(--acc-dim); color:var(--acc); border:1px solid var(--border-acc); }
.cr-skip  { background:none; border:1px solid var(--border-b); color:var(--muted); font-family:var(--fb); font-size:12px; padding:7px 16px; border-radius:100px; cursor:pointer; transition:all .2s; }
.cr-skip:hover { background:var(--surface2); color:var(--text); }
.cr-role-badge { background:var(--surface2); border:1px solid var(--border); color:var(--muted); font-size:11px; padding:5px 12px; border-radius:100px; }

.cr-turn      { display:flex; align-items:center; gap:7px; font-family:var(--fd); font-size:11px; font-weight:700; padding:6px 14px; border-radius:100px; border:1px solid; }
.cr-turn-mine { background:rgba(52,211,153,.1); border-color:rgba(52,211,153,.3); color:var(--green); }
.cr-turn-other{ background:var(--surface2); border-color:var(--border); color:var(--muted); }
.cr-turn-dot      { width:7px; height:7px; border-radius:50%; background:var(--dim); }
.cr-turn-dot-mine { background:var(--green); box-shadow:0 0 6px var(--green); animation:cr-blink 1.2s ease-in-out infinite; }

.cr-mic { display:flex; align-items:center; gap:6px; background:var(--surface2); border:1px solid var(--border-b); color:var(--muted); font-family:var(--fb); font-size:11px; padding:7px 14px; border-radius:100px; cursor:pointer; transition:all .2s; }
.cr-mic:hover:not(.cr-mic-locked) { background:var(--surface3); color:var(--text); }
.cr-mic-on     { background:rgba(255,77,77,.12); border-color:rgba(255,77,77,.3); color:var(--red); }
.cr-mic-on:hover { background:rgba(255,77,77,.2); }
.cr-mic-locked { opacity:.42; cursor:not-allowed; pointer-events:none; }

.cr-listening-badge { display:flex; align-items:center; gap:6px; font-family:var(--fd); font-size:11px; font-weight:600; color:var(--muted); padding:6px 14px; border-radius:100px; background:var(--surface2); border:1px solid var(--border); }
.cr-listening-dot   { width:7px; height:7px; border-radius:50%; background:var(--acc); animation:cr-blink 1.2s ease-in-out infinite; }

.cr-card-col { display:flex; flex-direction:column; gap:16px; }
.cr-topic-chip { display:inline-flex; align-items:center; background:var(--acc-dim); border:1px solid var(--border-acc); color:var(--acc); font-family:var(--fd); font-size:10px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; padding:5px 14px; border-radius:100px; align-self:flex-start; }
.cr-q-card { background:linear-gradient(145deg,#1a1f32,#141828); border:1px solid var(--border-b); border-radius:var(--r); padding:28px 32px; box-shadow:0 0 0 1px rgba(255,255,255,.04) inset,6px 6px 20px rgba(0,0,0,.5); position:relative; overflow:hidden; }
.cr-q-card::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.1),transparent); }
.cr-q-num  { font-family:var(--fd); font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--dim); margin-bottom:14px; }
.cr-q-text { font-family:var(--fb); font-size:18px; line-height:1.75; color:var(--text); margin:0; }

.cr-transcript-box    { background:rgba(255,255,255,.03); backdrop-filter:blur(20px); border:1px solid rgba(79,158,255,.2); border-radius:var(--rs); overflow:hidden; }
.cr-transcript-header { display:flex; align-items:center; gap:8px; padding:10px 16px; border-bottom:1px solid rgba(255,255,255,.06); }
.cr-ti-icon      { font-size:13px; }
.cr-ti-label     { font-family:var(--fd); font-size:10px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); flex:1; }
.cr-ti-live-dot  { width:6px; height:6px; border-radius:50%; background:var(--acc); animation:cr-blink 1.2s ease-in-out infinite; }
.cr-ti-body      { padding:14px 16px; min-height:80px; max-height:180px; overflow-y:auto; font-family:var(--fb); font-size:14px; line-height:1.7; }
.cr-ti-ph        { color:var(--dim); font-style:italic; }
.cr-ti-final     { color:var(--text); }
.cr-ti-interim   { color:rgba(255,255,255,.38); font-style:italic; }
.cr-ti-partner   { padding:10px 16px; border-top:1px solid rgba(255,255,255,.06); }
.cr-ti-plabel    { font-size:11px; color:var(--dim); font-family:var(--fd); font-weight:600; letter-spacing:1px; text-transform:uppercase; margin-right:8px; }
.cr-ti-ptext     { font-size:13px; color:rgba(255,255,255,.45); }

.cr-rdm        { background:rgba(255,255,255,.03); backdrop-filter:blur(20px); border:1px solid rgba(255,255,255,.09); border-radius:var(--rs); overflow:hidden; transition:all .25s; position:relative; }
.cr-rdm::before{ content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent); pointer-events:none; }
.cr-rdm-open   { background:rgba(79,158,255,.04); border-color:rgba(79,158,255,.22); }
.cr-rdm-toggle { width:100%; background:none; border:none; color:var(--muted); font-family:var(--fd); font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; padding:14px 18px; display:flex; align-items:center; gap:9px; cursor:pointer; transition:color .2s; }
.cr-rdm-toggle:hover { color:var(--text); }
.cr-rdm-chev   { font-size:11px; color:var(--acc); width:13px; }
.cr-rdm-lbl    { flex:1; text-align:left; }
.cr-rdm-cnt    { background:var(--surface3); border:1px solid var(--border); color:var(--dim); font-size:10px; padding:2px 9px; border-radius:100px; }
.cr-rdm-list   { list-style:none; margin:0; padding:8px 18px 12px; display:flex; flex-direction:column; gap:6px; max-height:260px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--surface3) transparent; border-top:1px solid rgba(255,255,255,.06); }
.cr-rdm-item   { display:flex; align-items:flex-start; gap:10px; font-family:var(--fb); font-size:13px; line-height:1.65; color:rgba(255,255,255,.55); padding:6px 0; border-bottom:1px solid rgba(255,255,255,.04); transition:color .15s; }
.cr-rdm-item:last-child { border-bottom:none; }
.cr-rdm-item:hover { color:rgba(255,255,255,.8); }
.cr-rdm-dot    { width:4px; height:4px; border-radius:50%; background:var(--acc); margin-top:8px; flex-shrink:0; box-shadow:0 0 4px var(--acc); }

.cr-fc { background:rgba(255,255,255,.03); backdrop-filter:blur(20px); border:1px solid rgba(79,158,255,.25); border-radius:var(--r); padding:28px 32px; box-shadow:0 0 0 1px rgba(255,255,255,.03) inset,0 12px 40px rgba(0,0,0,.4); position:relative; overflow:hidden; }
.cr-fc::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,rgba(79,158,255,.4),transparent); }
.cr-fc-owner-label { font-family:var(--fd); font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); margin-bottom:16px; padding-bottom:14px; border-bottom:1px solid var(--border); }
.cr-fc-loading { display:flex; flex-direction:column; align-items:center; gap:14px; padding:36px; }
.cr-fc-loading-text { font-family:var(--fd); font-size:13px; color:var(--muted); }
.cr-fc-header  { display:flex; align-items:center; justify-content:space-between; margin-bottom:22px; }
.cr-fc-title-row { display:flex; align-items:center; gap:10px; }
.cr-fc-icon    { font-size:20px; }
.cr-fc-title   { font-family:var(--fd); font-size:16px; font-weight:700; color:var(--text); margin:0; }
.cr-fc-stars   { display:flex; align-items:center; gap:3px; }
.cr-star       { font-size:18px; color:var(--surface3); }
.cr-star-on    { color:#f59e0b; filter:drop-shadow(0 0 4px rgba(245,158,11,.5)); }
.cr-fc-score   { font-family:var(--fd); font-size:12px; font-weight:700; color:var(--muted); margin-left:6px; }
.cr-fc-sec     { margin-bottom:18px; }
.cr-fc-sec-last{ margin-bottom:0; }
.cr-fc-label   { font-family:var(--fd); font-size:9px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--dim); margin-bottom:8px; }
.cr-fc-orig    { font-family:var(--fb); font-size:14px; line-height:1.75; color:rgba(255,255,255,.65); margin:0; }
.cr-fc-corr    { font-family:var(--fb); font-size:14px; line-height:1.75; margin:0; }
.cr-fc-errors  { display:flex; flex-direction:column; gap:8px; }
.cr-fc-erow    { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:13px; }
.cr-fc-eorig   { background:var(--red-dim); border:1px solid rgba(255,77,77,.2); padding:2px 8px; border-radius:6px; }
.cr-fc-efix    { background:var(--green-dim); border:1px solid rgba(52,211,153,.2); padding:2px 8px; border-radius:6px; }
.cr-fc-arrow   { color:var(--dim); font-size:14px; }
.cr-fc-text    { font-family:var(--fb); font-size:14px; line-height:1.75; color:rgba(255,255,255,.6); margin:0; }
.error-text     { color:var(--red); background:var(--red-dim); border-radius:3px; padding:1px 4px; font-style:italic; text-decoration:underline wavy rgba(255,77,77,.6); }
.corrected-text { color:var(--green); background:var(--green-dim); border-radius:3px; padding:1px 4px; }

.cr-assess-wide     { display:flex; flex-direction:column; gap:20px; width:100%; max-width:680px; }
.cr-assess-hdr      { text-align:center; display:flex; flex-direction:column; align-items:center; gap:8px; }
.cr-assess-icon-lbl { font-size:36px; }
.cr-assess-h        { font-family:var(--fd); font-size:26px; font-weight:700; margin:0; color:var(--text); }
.cr-assess-sub      { font-family:var(--fb); color:var(--muted); font-size:14px; margin:0; }
.cr-assess-card     { background:linear-gradient(145deg,#1a1f32,#141828); border:1px solid var(--border-b); border-radius:var(--r); padding:24px 28px; box-shadow:0 0 0 1px rgba(255,255,255,.04) inset,0 16px 40px rgba(0,0,0,.5); display:flex; flex-direction:column; gap:12px; }
.cr-assess-note-lbl { font-family:var(--fd); font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); }
.cr-assess-ta       { width:100%; background:var(--surface3); border:1px solid var(--border-b); border-radius:var(--rs); color:var(--text); font-family:var(--fb); font-size:15px; line-height:1.65; padding:14px 18px; resize:vertical; outline:none; transition:border-color .2s,box-shadow .2s; box-sizing:border-box; }
.cr-assess-ta:focus { border-color:var(--border-acc); box-shadow:0 0 0 3px rgba(79,158,255,.1); }
.cr-assess-ta::placeholder { color:var(--dim); }
.cr-pfb-wrap  { display:flex; flex-direction:column; gap:10px; }
.cr-pfb-label { font-family:var(--fd); font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); }

.cr-primary-btn { display:inline-flex; align-items:center; justify-content:center; background:linear-gradient(135deg,#3b82f6,#6366f1); color:#fff; border:none; padding:14px 34px; border-radius:100px; font-family:var(--fd); font-size:15px; font-weight:700; cursor:pointer; box-shadow:0 0 0 1px rgba(255,255,255,.12) inset,0 8px 28px rgba(79,100,255,.4); transition:transform .15s,box-shadow .15s; }
.cr-primary-btn:hover:not(:disabled) { transform:translateY(-2px); box-shadow:0 0 0 1px rgba(255,255,255,.15) inset,0 14px 36px rgba(79,100,255,.55); }
.cr-primary-btn:disabled { opacity:.4; cursor:not-allowed; }

.cr-switch-card  { background:linear-gradient(145deg,#1a1f32,#141828); border:1px solid var(--border-b); border-radius:var(--r); padding:52px 44px; text-align:center; max-width:380px; width:100%; box-shadow:0 0 0 1px rgba(255,255,255,.04) inset,0 24px 56px rgba(0,0,0,.55); display:flex; flex-direction:column; align-items:center; gap:14px; }
.cr-switch-icon  { width:62px; height:62px; border-radius:50%; background:var(--acc-dim); border:1px solid var(--border-acc); display:flex; align-items:center; justify-content:center; margin-bottom:6px; }
.cr-switch-title { font-family:var(--fd); font-size:26px; font-weight:700; margin:0; color:var(--text); }
.cr-switch-sub   { font-family:var(--fb); color:var(--muted); font-size:14px; margin:0; line-height:1.6; }
.cr-switch-sub strong { color:var(--acc); font-weight:500; }
.cr-switch-wait  { font-family:var(--fb); font-size:14px; color:var(--dim); margin:0; animation:cr-blink 2s ease-in-out infinite; }

.cr-finish-wide  { display:flex; flex-direction:column; gap:20px; width:100%; max-width:680px; }
.cr-finish-card  { background:linear-gradient(145deg,#1a1f32,#141828); border:1px solid var(--border-b); border-radius:var(--r); padding:52px 48px; text-align:center; width:100%; box-shadow:0 0 0 1px rgba(255,255,255,.04) inset,0 32px 72px rgba(0,0,0,.6); display:flex; flex-direction:column; align-items:center; gap:8px; }
.cr-finish-trophy{ font-size:52px; margin-bottom:8px; }
.cr-finish-title { font-family:var(--fd); font-size:40px; font-weight:800; margin:0; color:var(--text); letter-spacing:-1px; }
.cr-finish-sub   { font-family:var(--fb); color:var(--muted); font-size:14px; margin:0 0 12px; }
.cr-finish-btn   { margin-top:20px; }
.cr-finish-score { display:flex; flex-direction:column; align-items:center; gap:14px; margin:8px 0 4px; }
.cr-finish-fb    { font-family:var(--fb); font-size:14px; color:rgba(255,255,255,.55); line-height:1.7; max-width:380px; text-align:center; }

.cr-modal-overlay { position:fixed; inset:0; background:rgba(6,8,16,.88); backdrop-filter:blur(12px); display:flex; align-items:center; justify-content:center; z-index:999; padding:24px; }
.cr-modal         { background:linear-gradient(145deg,#1c2036,#161926); border:1px solid var(--border-b); border-radius:var(--r); padding:38px 34px; text-align:center; max-width:380px; width:100%; box-shadow:0 0 0 1px rgba(255,255,255,.05) inset,0 40px 80px rgba(0,0,0,.7); animation:cr-modal-in .22s ease; }
.cr-modal-icon    { width:58px; height:58px; border-radius:50%; background:rgba(245,158,11,.08); border:1px solid rgba(245,158,11,.2); display:flex; align-items:center; justify-content:center; margin:0 auto 20px; }
.cr-modal-title   { font-family:var(--fd); font-size:20px; font-weight:700; margin:0 0 10px; color:var(--text); }
.cr-modal-body    { font-family:var(--fb); color:var(--muted); font-size:14px; line-height:1.65; margin:0; }
.cr-modal-btns    { display:flex; gap:10px; margin-top:26px; }
.cr-modal-yes     { flex:1; background:rgba(255,77,77,.1); color:var(--red); border:1px solid rgba(255,77,77,.25); font-family:var(--fd); font-size:13px; font-weight:700; padding:13px; border-radius:var(--rs); cursor:pointer; transition:background .2s; }
.cr-modal-yes:hover { background:rgba(255,77,77,.2); }
.cr-modal-no      { flex:1; background:var(--surface2); color:var(--muted); border:1px solid var(--border-b); font-family:var(--fd); font-size:13px; font-weight:700; padding:13px; border-radius:var(--rs); cursor:pointer; transition:all .2s; }
.cr-modal-no:hover { background:var(--surface3); color:var(--text); }
`;
