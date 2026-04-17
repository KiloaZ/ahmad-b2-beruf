/**
 * ChallengeRoom.jsx — B2 Beruf Practice App
 * Full implementation: Hero bg image, slow-zoom animation, dark metallic theme,
 * circular SVG timer, glassmorphism Redemittel, Firebase multiplayer, round switching, exit modal.
 */

import { useState, useEffect, useRef } from "react";

// ── Firebase ─────────────────────────────────────────────────────────────────
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

// ── Audio beep helper ─────────────────────────────────────────────────────────
function playBeep({ freq = 880, duration = 0.18, type = "sine", gain = 0.35 } = {}) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.connect(env);
    env.connect(ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(gain, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (e) { /* Ignore */ }
}

const PREP_DURATION  = 30;
const SPEAK_DURATION = 180;

function pickRandom(questions, usedIds) {
  const pool = questions.filter(q => !usedIds.includes(q.id));
  const src  = pool.length > 0 ? pool : questions;
  return src[Math.floor(Math.random() * src.length)];
}

function scoreAnswer(userText, redemittel) {
  if (!userText?.trim() || !redemittel?.length) {
    return { score: 0, matched: [], missed: redemittel || [], pct: 0 };
  }
  const lower = userText.toLowerCase();
  const matched = [], missed = [];
  for (const r of redemittel) {
    const keyword = r.toLowerCase().split(/[\s,]+/).slice(0, 2).join(" ");
    (lower.includes(keyword) ? matched : missed).push(r);
  }
  const pct   = matched.length / redemittel.length;
  const score = Math.round(2 + pct * 8);
  return { score, matched, missed, pct };
}

// ── Circular SVG Timer ────────────────────────────────────────────────────────
function CircularTimer({ timeLeft, totalTime, phase }) {
  const radius       = 54;
  const circumference = 2 * Math.PI * radius;
  const pct    = timeLeft / totalTime;
  const offset = circumference * (1 - pct);
  const isUrgent  = timeLeft <= 5;
  const isWarning = timeLeft <= 30;

  const progressColor = isUrgent ? "#ff4d4d" : isWarning ? "#f59e0b" : "#4f9eff";
  const glowColor     = isUrgent ? "rgba(255,77,77,0.5)" : isWarning ? "rgba(245,158,11,0.5)" : "rgba(79,158,255,0.5)";

  const mins = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const secs = String(timeLeft % 60).padStart(2, "0");

  return (
    <div className={`cr-timer-wrap${isUrgent ? " cr-timer-urgent" : ""}`}>
      <svg viewBox="0 0 128 128" width="148" height="148" style={{ overflow: "visible" }}>
        <defs>
          <filter id="timerGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
          <radialGradient id="timerFace" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#1e2236" />
            <stop offset="100%" stopColor="#12141d" />
          </radialGradient>
        </defs>
        {/* Face */}
        <circle cx="64" cy="64" r="58" fill="url(#timerFace)" />
        {/* Outer metallic ring */}
        <circle cx="64" cy="64" r="62" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2" />
        {/* Track */}
        <circle
          cx="64" cy="64" r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.05)"
          strokeWidth="9"
        />
        {/* Glow behind progress */}
        <circle
          cx="64" cy="64" r={radius}
          fill="none"
          stroke={glowColor}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 64 64)"
          style={{ filter: "blur(6px)", transition: "stroke-dashoffset 0.5s linear, stroke 0.4s ease" }}
        />
        {/* Progress arc */}
        <circle
          cx="64" cy="64" r={radius}
          fill="none"
          stroke={progressColor}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 64 64)"
          style={{ transition: "stroke-dashoffset 0.5s linear, stroke 0.4s ease" }}
        />
        {/* Time text */}
        <text
          x="64" y="58"
          textAnchor="middle"
          dominantBaseline="middle"
          fill={isUrgent ? "#ff4d4d" : "#ffffff"}
          fontSize="22"
          fontWeight="700"
          fontFamily="'Syne', 'Space Grotesk', sans-serif"
          style={{ transition: "fill 0.4s ease" }}
        >
          {mins}:{secs}
        </text>
        <text
          x="64" y="77"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="rgba(255,255,255,0.35)"
          fontSize="8"
          fontWeight="500"
          fontFamily="'Syne', sans-serif"
          letterSpacing="2"
        >
          {phase === "prep" ? "VORBEREITUNG" : "SPRECHEN"}
        </text>
      </svg>
    </div>
  );
}

// ── Redemittel Panel — Glassmorphism ─────────────────────────────────────────
function RedemittelPanel({ items = [] }) {
  const [open, setOpen] = useState(false);

  const defaultItems = items.length > 0 ? items : [
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
        <span className="cr-redemittel-count">{defaultItems.length}</span>
      </button>
      {open && (
        <div className="cr-redemittel-body">
          <ul className="cr-redemittel-list">
            {defaultItems.map((item, i) => (
              <li key={i} className="cr-redemittel-item">
                <span className="cr-redemittel-bullet" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Exit Confirmation Modal ───────────────────────────────────────────────────
function ExitConfirmModal({ onConfirm, onCancel }) {
  return (
    <div className="cr-modal-overlay">
      <div className="cr-modal-card">
        <div className="cr-modal-icon-wrap">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h3 className="cr-modal-title">Übung abbrechen?</h3>
        <p className="cr-modal-body">
          Bist du sicher, dass du die aktuelle Übung beenden möchtest?
          Dein Fortschritt wird nicht gespeichert.
        </p>
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
  heroBgImage = "/1000188762.png",   // Pass the path to your uploaded image here
}) {
  const me     = currentUser || { uid: "demo", displayName: "Du" };
  const isSolo = mode === "solo";
  const isMulti = mode === "multi";

  const [phase,          setPhase]          = useState("intro");
  const [timerPhase,     setTimerPhase]     = useState("prep");
  const [timeLeft,       setTimeLeft]       = useState(PREP_DURATION);
  const [currentQ,       setCurrentQ]       = useState(null);
  const [usedIds,        setUsedIds]        = useState([]);
  const [round,          setRound]          = useState(1);
  const [myRole,         setMyRole]         = useState("speaker");
  const [partnerName,    setPartnerName]    = useState("Partner");
  const [sessionHistory, setSessionHistory] = useState([]);
  const [showExitConfirm,setShowExitConfirm]= useState(false);
  const [userText,       setUserText]       = useState("");
  const [scoreResult,    setScoreResult]    = useState(null);
  const [room,           setRoom]           = useState(null);
  const [fbLoading,      setFbLoading]      = useState(isMulti);
  const [phaseAnim,      setPhaseAnim]      = useState("in");

  const timerRef     = useRef(null);
  const startedAtRef = useRef(null);

  useEffect(() => () => clearInterval(timerRef.current), []);

  function transitionPhase(newPhase) {
    setPhaseAnim("out");
    setTimeout(() => {
      setPhase(newPhase);
      setPhaseAnim("in");
    }, 240);
  }

  function handleExitRequest() {
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

  // Firebase multiplayer listener
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
        if (data.players?.A?.uid === me.uid)      setMyRole(data.players.A.role);
        else if (data.players?.B?.uid === me.uid) setMyRole(data.players.B.role);
        const partner = data.players?.A?.uid === me.uid ? data.players?.B : data.players?.A;
        if (partner?.displayName) setPartnerName(partner.displayName);
        setRound(data.round || 1);
        if (data.currentQuestionId && questions.length) {
          const q = questions.find(q => q.id === data.currentQuestionId);
          if (q) setCurrentQ(q);
        }
        if (data.status)                                              setPhase(data.status);
        if (data.timer?.startedAt && data.timer?.state === "running") {
          const elapsed = Math.floor((Date.now() - data.timer.startedAt) / 1000);
          const left    = Math.max(0, data.timer.durationSec - elapsed);
          setTimerPhase(data.timer.phase || "prep");
          setTimeLeft(left);
        }
      });
      cleanup = () => off(roomRef);
    })();
    return () => cleanup();
  }, [isMulti, roomId]);

  async function fbSet(path, value) {
    if (!isMulti) return;
    const db = await getFirebaseDB();
    if (!db) return;
    const { ref, set } = await import("firebase/database");
    await set(ref(db, path), value);
  }

  function beginPrep(questionOverride) {
    const q = questionOverride || pickRandom(questions, usedIds);
    setCurrentQ(q);
    setUsedIds(prev => [...prev, q.id]);
    setTimerPhase("prep");
    setTimeLeft(PREP_DURATION);
    transitionPhase("prep");
    startLocalTimer(PREP_DURATION, () => beginSpeaking(q));
    if (isMulti) {
      fbSet(`rooms/${roomId}`, {
        ...room,
        status: "prep",
        currentQuestionId: q.id,
        round,
        timer: { startedAt: Date.now(), durationSec: PREP_DURATION, phase: "prep", state: "running" },
      });
    }
  }

  function beginSpeaking(q) {
    clearInterval(timerRef.current);
    setTimerPhase("speak");
    setTimeLeft(SPEAK_DURATION);
    playBeep({ freq: 660, gain: 0.4 });
    transitionPhase("speaking");
    startLocalTimer(SPEAK_DURATION, handleSpeakEnd);
    if (isMulti) {
      fbSet(`rooms/${roomId}/status`, "speaking");
      fbSet(`rooms/${roomId}/timer`, { startedAt: Date.now(), durationSec: SPEAK_DURATION, phase: "speak", state: "running" });
    }
  }

  function handleSpeakEnd() {
    clearInterval(timerRef.current);
    playBeep({ freq: 440, gain: 0.3 });
    if (isSolo)     { transitionPhase("selfAssess"); return; }
    if (round >= 2) { transitionPhase("finished");   return; }
    transitionPhase("switching");
    fbSet(`rooms/${roomId}/status`, "switching");
  }

  const totalTime = timerPhase === "prep" ? PREP_DURATION : SPEAK_DURATION;

  return (
    <>
      <style>{CSS}</style>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,400&display=swap" rel="stylesheet" />

      <div className="cr-root">
        {/* Persistent bg for non-intro phases */}
        <div className="cr-bg-dim" />

        {showExitConfirm && (
          <ExitConfirmModal
            onConfirm={() => { setShowExitConfirm(false); onExit?.(); }}
            onCancel={() => setShowExitConfirm(false)}
          />
        )}

        {/* ── INTRO / LANDING ──────────────────────────────────────────────── */}
        {phase === "intro" && (
          <div className="cr-intro-stage">
            {/* Hero background with slow-zoom */}
            <div
              className="cr-hero-bg"
              style={{ backgroundImage: `url(${heroBgImage})` }}
            />
            {/* Gradient overlays */}
            <div className="cr-hero-overlay-top" />
            <div className="cr-hero-overlay-bottom" />

            {/* Header bar */}
            <header className="cr-header cr-header-hero">
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
              </div>
              <button className="cr-exit-btn" onClick={handleExitRequest} aria-label="Beenden">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </header>

            {/* Hero content */}
            <div className="cr-hero-content">
              <div className="cr-hero-eyebrow">Deutschprüfung B2 · Mündliche Kommunikation</div>
              <h1 className="cr-hero-title">
                Bereit für<br />
                <span className="cr-hero-title-accent">deine Prüfung?</span>
              </h1>
              <p className="cr-hero-sub">
                {isSolo
                  ? "Solo-Übung · 30 s Vorbereitung · 3 min Sprechen"
                  : `Duell mit ${partnerName} · 2 Runden · Rollenwechsel`}
              </p>

              <div className="cr-hero-meta-row">
                <div className="cr-hero-meta-item">
                  <span className="cr-hero-meta-icon">⏱</span>
                  <span>30 s Vorbereitung</span>
                </div>
                <div className="cr-hero-meta-divider" />
                <div className="cr-hero-meta-item">
                  <span className="cr-hero-meta-icon">🎙</span>
                  <span>3 min Sprechen</span>
                </div>
                <div className="cr-hero-meta-divider" />
                <div className="cr-hero-meta-item">
                  <span className="cr-hero-meta-icon">📋</span>
                  <span>Redemittel inklusive</span>
                </div>
              </div>

              <button className="cr-hero-start-btn" onClick={() => beginPrep()}>
                <span>Übung starten</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* ── ALL OTHER PHASES ─────────────────────────────────────────────── */}
        {phase !== "intro" && (
          <>
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
              </div>
              <button className="cr-exit-btn" onClick={handleExitRequest} aria-label="Beenden">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </header>

            <main className={`cr-main cr-phase-${phaseAnim}`}>

              {/* PREP / SPEAKING */}
              {(phase === "prep" || phase === "speaking") && currentQ && (
                <div className="cr-game-layout">
                  {/* Timer column */}
                  <div className="cr-timer-col">
                    <CircularTimer timeLeft={timeLeft} totalTime={totalTime} phase={timerPhase} />

                    <div className={`cr-phase-pill cr-phase-pill-${timerPhase}`}>
                      {timerPhase === "prep" ? "Vorbereitung" : "Sprechen"}
                    </div>

                    {phase === "prep" && (
                      <button className="cr-skip-btn" onClick={() => beginSpeaking(currentQ)}>
                        Jetzt sprechen →
                      </button>
                    )}

                    {/* Role indicator for multiplayer */}
                    {isMulti && (
                      <div className="cr-role-badge">
                        {myRole === "speaker" ? "🎙 Sprecher" : "👂 Zuhörer"}
                      </div>
                    )}
                  </div>

                  {/* Question + Redemittel column */}
                  <div className="cr-card-col">
                    <div className="cr-topic-chip">{currentQ.topic || "Thema"}</div>

                    <div className="cr-question-card">
                      <div className="cr-question-number">Aufgabe</div>
                      <p className="cr-question-text">{currentQ.question}</p>
                    </div>

                    <RedemittelPanel items={currentQ.redemittel} />
                  </div>
                </div>
              )}

              {/* SELF ASSESS */}
              {phase === "selfAssess" && currentQ && (
                <div className="cr-center-stage">
                  <div className="cr-assess-card">
                    <div className="cr-assess-icon">✍️</div>
                    <h2 className="cr-assess-heading">Selbstbewertung</h2>
                    <p className="cr-assess-sub">Wie lief deine Antwort? Schreib sie hier auf (optional).</p>
                    <textarea
                      className="cr-assess-textarea"
                      placeholder="Deine Antwort auf Deutsch …"
                      value={userText}
                      onChange={e => setUserText(e.target.value)}
                      rows={5}
                    />
                    <button
                      className="cr-primary-btn"
                      onClick={() => {
                        const result = scoreAnswer(userText, currentQ.redemittel || []);
                        setScoreResult(result);
                        setSessionHistory(h => [...h, { q: currentQ, result }]);
                        transitionPhase("finished");
                      }}
                    >
                      Weiter zur Auswertung →
                    </button>
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
                    <p className="cr-switch-sub">
                      Du bist jetzt: <strong>{myRole === "speaker" ? "Zuhörer" : "Sprecher"}</strong>
                    </p>
                    <button className="cr-primary-btn" onClick={() => {
                      setRound(r => r + 1);
                      beginPrep();
                      fbSet(`rooms/${roomId}/round`, round + 1);
                    }}>
                      Nächste Runde →
                    </button>
                  </div>
                </div>
              )}

              {/* FINISHED */}
              {phase === "finished" && (
                <div className="cr-center-stage">
                  <div className="cr-finish-card">
                    <div className="cr-finish-confetti">🏆</div>
                    <h1 className="cr-finish-title">Geschafft!</h1>
                    <p className="cr-finish-sub">Hervorragende Arbeit!</p>

                    {scoreResult && (
                      <div className="cr-score-ring">
                        <svg viewBox="0 0 120 120" width="140" height="140">
                          <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(79,158,255,0.1)" strokeWidth="10" />
                          <circle cx="60" cy="60" r="52" fill="none"
                            stroke="#4f9eff" strokeWidth="10" strokeLinecap="round"
                            strokeDasharray={`${2 * Math.PI * 52}`}
                            strokeDashoffset={`${2 * Math.PI * 52 * (1 - scoreResult.score / 10)}`}
                            transform="rotate(-90 60 60)"
                            style={{ transition: "stroke-dashoffset 1s ease" }}
                          />
                          <text x="60" y="56" textAnchor="middle" dominantBaseline="middle"
                            fill="#fff" fontSize="28" fontWeight="700" fontFamily="Syne, sans-serif">
                            {scoreResult.score}
                          </text>
                          <text x="60" y="76" textAnchor="middle" dominantBaseline="middle"
                            fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="Syne, sans-serif">
                            VON 10
                          </text>
                        </svg>

                        {scoreResult.matched.length > 0 && (
                          <div className="cr-score-matched">
                            <span className="cr-score-matched-label">✓ Verwendet:</span>
                            {scoreResult.matched.slice(0, 3).map((m, i) => (
                              <span key={i} className="cr-score-tag">{m.split(" ").slice(0, 3).join(" ")}…</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <button className="cr-primary-btn cr-finish-btn" onClick={() => onExit?.()}>
                      Beenden
                    </button>
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

  /* ── Root & tokens ──────────────────────────────────────────────────────── */
  .cr-root {
    --bg:            #0e1018;
    --surface:       #161925;
    --surface2:      #1c2030;
    --surface3:      #232840;
    --border:        rgba(255,255,255,0.07);
    --border-bright: rgba(255,255,255,0.12);
    --border-accent: rgba(79,158,255,0.3);
    --text:          #e8eaf2;
    --text-muted:    #7e8aaa;
    --text-dim:      #464e6a;
    --accent:        #4f9eff;
    --accent-dim:    rgba(79,158,255,0.15);
    --accent-glow:   rgba(79,158,255,0.3);
    --red:           #ff4d4d;
    --amber:         #f59e0b;
    --green:         #34d399;
    --radius:        18px;
    --radius-sm:     12px;
    --font-display:  'Syne', system-ui, sans-serif;
    --font-body:     'DM Sans', system-ui, sans-serif;

    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    font-family: var(--font-body);
    position: relative;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
  }

  .cr-bg-dim {
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse 80% 60% at 20% 10%, rgba(30,40,80,0.4) 0%, transparent 70%),
      radial-gradient(ellipse 60% 50% at 80% 90%, rgba(10,20,50,0.5) 0%, transparent 70%);
    pointer-events: none;
    z-index: 0;
  }

  /* ── Slow-Zoom keyframes for hero bg ────────────────────────────────────── */
  @keyframes cr-slow-zoom {
    0%   { transform: scale(1.0); }
    100% { transform: scale(1.12); }
  }

  @keyframes cr-fade-up {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @keyframes timerPulse {
    0%, 100% { transform: scale(1); }
    50%       { transform: scale(1.05); }
  }

  @keyframes modalIn {
    from { opacity: 0; transform: scale(0.94) translateY(10px); }
    to   { opacity: 1; transform: scale(1)    translateY(0); }
  }

  @keyframes cr-glow-pulse {
    0%, 100% { box-shadow: 0 0 24px rgba(79,158,255,0.2); }
    50%       { box-shadow: 0 0 40px rgba(79,158,255,0.45); }
  }

  /* ── Hero / Intro stage ─────────────────────────────────────────────────── */
  .cr-intro-stage {
    position: relative;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .cr-hero-bg {
    position: absolute;
    inset: -8%;          /* Extra room for zoom without edges showing */
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    animation: cr-slow-zoom 18s ease-in-out infinite alternate;
    will-change: transform;
    z-index: 0;
  }

  /* Top header gradient */
  .cr-hero-overlay-top {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 220px;
    background: linear-gradient(to bottom, rgba(10,12,22,0.92) 0%, transparent 100%);
    z-index: 1;
    pointer-events: none;
  }

  /* Bottom content gradient */
  .cr-hero-overlay-bottom {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 75%;
    background: linear-gradient(
      to top,
      rgba(8,10,20,0.98)  0%,
      rgba(8,10,20,0.90)  30%,
      rgba(8,10,20,0.60)  60%,
      transparent         100%
    );
    z-index: 1;
    pointer-events: none;
  }

  .cr-header-hero {
    position: relative;
    z-index: 10;
    background: transparent !important;
    border-bottom: 1px solid rgba(255,255,255,0.06) !important;
  }

  .cr-hero-content {
    position: relative;
    z-index: 5;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 0 56px 64px;
    max-width: 800px;
    animation: cr-fade-up 0.8s ease both;
    animation-delay: 0.15s;
  }

  .cr-hero-eyebrow {
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 18px;
    opacity: 0.9;
  }

  .cr-hero-title {
    font-family: var(--font-display);
    font-size: clamp(44px, 7vw, 80px);
    font-weight: 800;
    line-height: 1.05;
    letter-spacing: -2px;
    color: #fff;
    margin: 0 0 20px;
  }

  .cr-hero-title-accent {
    background: linear-gradient(120deg, #4f9eff 0%, #a78bfa 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .cr-hero-sub {
    font-family: var(--font-body);
    font-size: 16px;
    color: rgba(255,255,255,0.55);
    margin-bottom: 32px;
    line-height: 1.6;
  }

  .cr-hero-meta-row {
    display: flex;
    align-items: center;
    gap: 0;
    margin-bottom: 40px;
    flex-wrap: wrap;
    gap: 8px;
  }

  .cr-hero-meta-item {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    color: rgba(255,255,255,0.5);
    font-family: var(--font-body);
  }
  .cr-hero-meta-icon { font-size: 14px; }
  .cr-hero-meta-divider {
    width: 1px;
    height: 14px;
    background: rgba(255,255,255,0.18);
    margin: 0 12px;
  }

  .cr-hero-start-btn {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
    color: #fff;
    border: none;
    padding: 16px 36px;
    border-radius: 100px;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.3px;
    cursor: pointer;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.1) inset,
      0 12px 32px rgba(79,100,255,0.45),
      0 2px 8px rgba(0,0,0,0.4);
    transition: transform 0.18s, box-shadow 0.18s;
    animation: cr-glow-pulse 3s ease-in-out infinite;
  }
  .cr-hero-start-btn:hover {
    transform: translateY(-3px);
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.15) inset,
      0 18px 44px rgba(79,100,255,0.55),
      0 4px 12px rgba(0,0,0,0.5);
  }
  .cr-hero-start-btn:active { transform: translateY(0); }

  @media (max-width: 640px) {
    .cr-hero-content { padding: 0 24px 48px; }
    .cr-hero-title   { font-size: 40px; letter-spacing: -1px; }
  }

  /* ── Header (non-hero) ──────────────────────────────────────────────────── */
  .cr-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 28px;
    border-bottom: 1px solid var(--border);
    position: relative;
    z-index: 10;
    background: rgba(14,16,24,0.88);
    backdrop-filter: blur(16px);
    flex-shrink: 0;
  }

  .cr-logo {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .cr-logo-b2 {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 22px;
    color: var(--accent);
    letter-spacing: -0.5px;
  }
  .cr-logo-beruf {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 12px;
    color: var(--text-muted);
    letter-spacing: 2.5px;
    text-transform: uppercase;
  }

  .cr-header-meta {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .cr-round-badge {
    background: var(--surface2);
    border: 1px solid var(--border-bright);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    padding: 5px 14px;
    border-radius: 100px;
  }
  .cr-partner-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
    font-family: var(--font-body);
  }
  .cr-partner-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 7px var(--green);
  }

  .cr-exit-btn {
    background: var(--surface2);
    border: 1px solid var(--border-bright);
    color: var(--text-muted);
    cursor: pointer;
    width: 36px; height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    flex-shrink: 0;
  }
  .cr-exit-btn:hover {
    background: var(--surface3);
    color: var(--text);
    border-color: rgba(255,255,255,0.22);
  }

  /* ── Phase transitions ──────────────────────────────────────────────────── */
  .cr-main {
    position: relative;
    z-index: 1;
    flex: 1;
    display: flex;
    flex-direction: column;
    transition: opacity 0.24s ease, transform 0.24s ease;
  }
  .cr-phase-in  { opacity: 1; transform: translateY(0); }
  .cr-phase-out { opacity: 0; transform: translateY(12px); }

  /* ── Center stage wrapper ───────────────────────────────────────────────── */
  .cr-center-stage {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 40px 24px;
    min-height: 70vh;
  }

  /* ── Game layout ────────────────────────────────────────────────────────── */
  .cr-game-layout {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: 36px;
    padding: 40px 48px;
    align-items: start;
    max-width: 980px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }
  @media (max-width: 740px) {
    .cr-game-layout {
      grid-template-columns: 1fr;
      padding: 24px 20px;
      gap: 24px;
    }
  }

  /* ── Timer column ───────────────────────────────────────────────────────── */
  .cr-timer-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    position: sticky;
    top: 28px;
  }
  .cr-timer-wrap {
    position: relative;
    filter: drop-shadow(0 0 20px rgba(79,158,255,0.15));
  }
  .cr-timer-urgent {
    animation: timerPulse 0.7s ease-in-out infinite;
  }

  .cr-phase-pill {
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    padding: 5px 16px;
    border-radius: 100px;
  }
  .cr-phase-pill-prep {
    background: rgba(245,158,11,0.1);
    color: var(--amber);
    border: 1px solid rgba(245,158,11,0.25);
  }
  .cr-phase-pill-speak {
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--border-accent);
  }

  .cr-skip-btn {
    background: none;
    border: 1px solid var(--border-bright);
    color: var(--text-muted);
    font-family: var(--font-body);
    font-size: 12px;
    padding: 7px 16px;
    border-radius: 100px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .cr-skip-btn:hover {
    background: var(--surface2);
    color: var(--text);
    border-color: rgba(255,255,255,0.2);
  }

  .cr-role-badge {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 11px;
    font-family: var(--font-body);
    padding: 5px 12px;
    border-radius: 100px;
  }

  /* ── Card column ────────────────────────────────────────────────────────── */
  .cr-card-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .cr-topic-chip {
    display: inline-flex;
    align-items: center;
    background: var(--accent-dim);
    border: 1px solid var(--border-accent);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    padding: 5px 14px;
    border-radius: 100px;
    align-self: flex-start;
  }

  /* Metallic question card */
  .cr-question-card {
    background: linear-gradient(145deg, #1a1f32 0%, #141828 100%);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 28px 32px;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.04) inset,
      0 1px 2px rgba(255,255,255,0.06) inset,
      6px 6px 20px rgba(0,0,0,0.5),
      -2px -2px 8px rgba(255,255,255,0.02);
    position: relative;
    overflow: hidden;
  }
  .cr-question-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
  }
  .cr-question-number {
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 14px;
  }
  .cr-question-text {
    font-family: var(--font-body);
    font-size: 18px;
    font-weight: 400;
    line-height: 1.75;
    color: var(--text);
    margin: 0;
  }

  /* ── Redemittel — Glassmorphism ─────────────────────────────────────────── */
  .cr-redemittel {
    background: rgba(255,255,255,0.03);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: var(--radius-sm);
    overflow: hidden;
    transition: border-color 0.25s, background 0.25s;
    position: relative;
  }
  .cr-redemittel::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent);
    pointer-events: none;
  }
  .cr-redemittel-open {
    background: rgba(79,158,255,0.04);
    border-color: rgba(79,158,255,0.22);
  }

  .cr-redemittel-toggle {
    width: 100%;
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 14px 18px;
    display: flex;
    align-items: center;
    gap: 9px;
    cursor: pointer;
    text-align: left;
    transition: color 0.2s;
  }
  .cr-redemittel-toggle:hover { color: var(--text); }

  .cr-redemittel-chevron {
    font-size: 11px;
    color: var(--accent);
    width: 13px;
    flex-shrink: 0;
  }
  .cr-redemittel-label { flex: 1; }
  .cr-redemittel-count {
    background: var(--surface3);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 10px;
    font-family: var(--font-display);
    padding: 2px 9px;
    border-radius: 100px;
  }

  .cr-redemittel-body {
    border-top: 1px solid rgba(255,255,255,0.06);
    padding: 4px 0 12px;
  }

  .cr-redemittel-list {
    list-style: none;
    margin: 0;
    padding: 0 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 260px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--surface3) transparent;
  }

  .cr-redemittel-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-family: var(--font-body);
    font-size: 13px;
    line-height: 1.65;
    color: rgba(255,255,255,0.55);
    padding: 6px 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    transition: color 0.15s;
  }
  .cr-redemittel-item:last-child { border-bottom: none; }
  .cr-redemittel-item:hover { color: rgba(255,255,255,0.8); }

  .cr-redemittel-bullet {
    width: 4px; height: 4px;
    border-radius: 50%;
    background: var(--accent);
    margin-top: 8px;
    flex-shrink: 0;
    box-shadow: 0 0 4px var(--accent);
  }

  /* ── Self Assess ────────────────────────────────────────────────────────── */
  .cr-assess-card {
    background: linear-gradient(145deg, #1a1f32 0%, #141828 100%);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 48px 40px;
    max-width: 600px;
    width: 100%;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.04) inset,
      0 32px 64px rgba(0,0,0,0.6);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    text-align: center;
  }
  .cr-assess-icon { font-size: 36px; }
  .cr-assess-heading {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 700;
    margin: 0;
    color: var(--text);
  }
  .cr-assess-sub {
    font-family: var(--font-body);
    color: var(--text-muted);
    font-size: 14px;
    margin: 0;
    line-height: 1.6;
  }
  .cr-assess-textarea {
    width: 100%;
    background: var(--surface3);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-body);
    font-size: 15px;
    line-height: 1.65;
    padding: 16px 20px;
    resize: vertical;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    box-sizing: border-box;
  }
  .cr-assess-textarea:focus {
    border-color: var(--border-accent);
    box-shadow: 0 0 0 3px rgba(79,158,255,0.1);
  }
  .cr-assess-textarea::placeholder { color: var(--text-dim); }

  /* ── Primary Button ─────────────────────────────────────────────────────── */
  .cr-primary-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
    color: #fff;
    border: none;
    padding: 14px 34px;
    border-radius: 100px;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.2px;
    cursor: pointer;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.12) inset,
      0 8px 28px rgba(79,100,255,0.4);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .cr-primary-btn:hover {
    transform: translateY(-2px);
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.15) inset,
      0 14px 36px rgba(79,100,255,0.55);
  }
  .cr-primary-btn:active { transform: translateY(0); }

  /* ── Switch card ────────────────────────────────────────────────────────── */
  .cr-switch-card {
    background: linear-gradient(145deg, #1a1f32 0%, #141828 100%);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 52px 44px;
    text-align: center;
    max-width: 380px;
    width: 100%;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.04) inset,
      0 24px 56px rgba(0,0,0,0.55);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }
  .cr-switch-icon-wrap {
    width: 62px; height: 62px;
    border-radius: 50%;
    background: var(--accent-dim);
    border: 1px solid var(--border-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 6px;
  }
  .cr-switch-title {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 700;
    margin: 0;
    color: var(--text);
  }
  .cr-switch-sub {
    font-family: var(--font-body);
    color: var(--text-muted);
    font-size: 14px;
    margin: 0;
    line-height: 1.6;
  }
  .cr-switch-sub strong { color: var(--accent); font-weight: 500; }

  /* ── Finish card ────────────────────────────────────────────────────────── */
  .cr-finish-card {
    background: linear-gradient(145deg, #1a1f32 0%, #141828 100%);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 52px 48px;
    text-align: center;
    max-width: 420px;
    width: 100%;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.04) inset,
      0 32px 72px rgba(0,0,0,0.6);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .cr-finish-confetti { font-size: 52px; margin-bottom: 8px; }
  .cr-finish-title {
    font-family: var(--font-display);
    font-size: 40px;
    font-weight: 800;
    margin: 0;
    color: var(--text);
    letter-spacing: -1px;
  }
  .cr-finish-sub {
    font-family: var(--font-body);
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 12px;
  }
  .cr-finish-btn { margin-top: 20px; }

  /* Score ring */
  .cr-score-ring {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    margin: 8px 0 16px;
  }
  .cr-score-matched {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
  }
  .cr-score-matched-label {
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 700;
    color: var(--green);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .cr-score-tag {
    background: rgba(52,211,153,0.1);
    border: 1px solid rgba(52,211,153,0.2);
    color: var(--green);
    font-size: 11px;
    font-family: var(--font-body);
    padding: 3px 10px;
    border-radius: 100px;
  }

  /* ── Exit Modal ─────────────────────────────────────────────────────────── */
  .cr-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(6,8,16,0.88);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999;
    padding: 24px;
  }
  .cr-modal-card {
    background: linear-gradient(145deg, #1c2036 0%, #161926 100%);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 38px 34px;
    text-align: center;
    max-width: 380px;
    width: 100%;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.05) inset,
      0 40px 80px rgba(0,0,0,0.7);
    animation: modalIn 0.22s ease;
  }
  .cr-modal-icon-wrap {
    width: 58px; height: 58px;
    border-radius: 50%;
    background: rgba(245,158,11,0.08);
    border: 1px solid rgba(245,158,11,0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
  }
  .cr-modal-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 10px;
    color: var(--text);
  }
  .cr-modal-body {
    font-family: var(--font-body);
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.65;
    margin: 0;
  }
  .cr-modal-actions {
    display: flex;
    gap: 10px;
    margin-top: 26px;
  }
  .cr-modal-confirm {
    flex: 1;
    background: rgba(255,77,77,0.1);
    color: var(--red);
    border: 1px solid rgba(255,77,77,0.25);
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.3px;
    padding: 13px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background 0.2s;
  }
  .cr-modal-confirm:hover { background: rgba(255,77,77,0.2); }
  .cr-modal-cancel {
    flex: 1;
    background: var(--surface2);
    color: var(--text-muted);
    border: 1px solid var(--border-bright);
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.3px;
    padding: 13px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.2s;
  }
  .cr-modal-cancel:hover {
    background: var(--surface3);
    color: var(--text);
  }
`;
