/**
 * ChallengeRoom.jsx — B2 Beruf Practice App
 * Overhauled UI/UX: Metallic dark theme, circular timer, Redemittel section, smooth transitions.
 * All original logic preserved: Firebase multiplayer, timer sync, exit confirmation.
 */

import { useState, useEffect, useRef } from "react";

// ── Firebase: Configured via environment variables ─────────────
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

// ── Audio beep helper ─────
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

const PREP_DURATION = 30;
const SPEAK_DURATION = 180;

function pickRandom(questions, usedIds) {
  const pool = questions.filter(q => !usedIds.includes(q.id));
  const src = pool.length > 0 ? pool : questions;
  return src[Math.floor(Math.random() * src.length)];
}

function scoreAnswer(userText, redemittel) {
  if (!userText?.trim() || !redemittel?.length) {
    return { score: 0, matched: [], missed: redemittel || [], pct: 0 };
  }
  const lower = userText.toLowerCase();
  const matched = [];
  const missed = [];
  for (const r of redemittel) {
    const keyword = r.toLowerCase().split(/[\s,]+/).slice(0, 2).join(" ");
    (lower.includes(keyword) ? matched : missed).push(r);
  }
  const pct = matched.length / redemittel.length;
  const score = Math.round(2 + pct * 8);
  return { score, matched, missed, pct };
}

// ── Circular Timer Component ─────
function CircularTimer({ timeLeft, totalTime, phase }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const pct = timeLeft / totalTime;
  const offset = circumference * (1 - pct);
  const isUrgent = timeLeft <= 5;
  const isWarning = timeLeft <= 30;

  const trackColor = "rgba(255,255,255,0.06)";
  const progressColor = isUrgent
    ? "#ff4d4d"
    : isWarning
    ? "#f59e0b"
    : "#4f9eff";

  const mins = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const secs = String(timeLeft % 60).padStart(2, "0");

  return (
    <div className={`cr-timer-wrap${isUrgent ? " cr-timer-urgent" : ""}`}>
      <svg viewBox="0 0 128 128" width="128" height="128" style={{ overflow: "visible" }}>
        {/* Glow filter */}
        <defs>
          <filter id="timerGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
        {/* Background track */}
        <circle
          cx="64" cy="64" r={radius}
          fill="none"
          stroke={trackColor}
          strokeWidth="8"
        />
        {/* Progress arc */}
        <circle
          cx="64" cy="64" r={radius}
          fill="none"
          stroke={progressColor}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 64 64)"
          style={{
            transition: "stroke-dashoffset 0.5s linear, stroke 0.4s ease",
            filter: `drop-shadow(0 0 6px ${progressColor}88)`,
          }}
        />
        {/* Timer text */}
        <text
          x="64" y="60"
          textAnchor="middle"
          dominantBaseline="middle"
          fill={isUrgent ? "#ff4d4d" : "#ffffff"}
          fontSize="20"
          fontWeight="600"
          fontFamily="'Inter', sans-serif"
          style={{ transition: "fill 0.4s ease" }}
        >
          {mins}:{secs}
        </text>
        <text
          x="64" y="80"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="rgba(255,255,255,0.4)"
          fontSize="9"
          fontWeight="400"
          fontFamily="'Inter', sans-serif"
          letterSpacing="1.5"
        >
          {phase === "prep" ? "VORBEREITUNG" : "SPRECHEN"}
        </text>
      </svg>
    </div>
  );
}

// ── Redemittel Panel ─────
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
  ];

  return (
    <div className={`cr-redemittel${open ? " cr-redemittel-open" : ""}`}>
      <button className="cr-redemittel-toggle" onClick={() => setOpen(o => !o)}>
        <span className="cr-redemittel-icon">{open ? "▾" : "▸"}</span>
        Redemittel
        <span className="cr-redemittel-count">{defaultItems.length}</span>
      </button>
      {open && (
        <ul className="cr-redemittel-list">
          {defaultItems.map((item, i) => (
            <li key={i} className="cr-redemittel-item">
              <span className="cr-redemittel-dot" />
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Exit Confirmation Modal ─────
function ExitConfirmModal({ onConfirm, onCancel }) {
  return (
    <div className="cr-modal-overlay">
      <div className="cr-modal-card">
        <div className="cr-modal-icon-wrap">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
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
          <button className="cr-modal-cancel" onClick={onCancel}>Weitermachen</button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ─────
export default function ChallengeRoom({
  mode = "solo",
  roomId = null,
  currentUser,
  questions = [],
  onExit,
}) {
  const me = currentUser || { uid: "demo", displayName: "Du" };
  const isSolo = mode === "solo";
  const isMulti = mode === "multi";

  const [phase, setPhase] = useState("intro");
  const [timerPhase, setTimerPhase] = useState("prep");
  const [timeLeft, setTimeLeft] = useState(PREP_DURATION);
  const [currentQ, setCurrentQ] = useState(null);
  const [usedIds, setUsedIds] = useState([]);
  const [round, setRound] = useState(1);
  const [myRole, setMyRole] = useState("speaker");
  const [partnerName, setPartnerName] = useState("Partner");
  const [showRedemittel, setShowRedemittel] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [sessionHistory, setSessionHistory] = useState([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [userText, setUserText] = useState("");
  const [scoreResult, setScoreResult] = useState(null);
  const [room, setRoom] = useState(null);
  const [fbLoading, setFbLoading] = useState(isMulti);
  const [phaseAnim, setPhaseAnim] = useState("in");

  const timerRef = useRef(null);
  const startedAtRef = useRef(null);

  useEffect(() => () => clearInterval(timerRef.current), []);

  function transitionPhase(newPhase) {
    setPhaseAnim("out");
    setTimeout(() => {
      setPhase(newPhase);
      setPhaseAnim("in");
    }, 220);
  }

  function handleExitRequest() {
    if (phase === "intro" || phase === "finished") { onExit(); return; }
    setShowExitConfirm(true);
  }

  function startLocalTimer(duration, onComplete) {
    clearInterval(timerRef.current);
    startedAtRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      const left = Math.max(0, duration - elapsed);
      setTimeLeft(left);
      if (left === 0) {
        clearInterval(timerRef.current);
        onComplete();
      }
    }, 500);
  }

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
        if (data.players?.A?.uid === me.uid) setMyRole(data.players.A.role);
        else if (data.players?.B?.uid === me.uid) setMyRole(data.players.B.role);
        const partner = data.players?.A?.uid === me.uid ? data.players?.B : data.players?.A;
        if (partner?.displayName) setPartnerName(partner.displayName);
        setRound(data.round || 1);
        if (data.currentQuestionId && questions.length) {
          const q = questions.find(q => q.id === data.currentQuestionId);
          if (q) setCurrentQ(q);
        }
        if (data.status) setPhase(data.status);
        if (data.timer?.startedAt && data.timer?.state === "running") {
          const elapsed = Math.floor((Date.now() - data.timer.startedAt) / 1000);
          const left = Math.max(0, data.timer.durationSec - elapsed);
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
    if (isSolo) { transitionPhase("selfAssess"); return; }
    if (round >= 2) { transitionPhase("finished"); return; }
    transitionPhase("switching");
    fbSet(`rooms/${roomId}/status`, "switching");
  }

  const totalTime = timerPhase === "prep" ? PREP_DURATION : SPEAK_DURATION;

  return (
    <>
      <style>{CSS}</style>
      <link
        rel="preconnect"
        href="https://fonts.googleapis.com"
      />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin="anonymous"
      />
      <link
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      <div className="cr-root">
        <div className="cr-noise" />

        {showExitConfirm && (
          <ExitConfirmModal
            onConfirm={() => { setShowExitConfirm(false); onExit(); }}
            onCancel={() => setShowExitConfirm(false)}
          />
        )}

        {/* Header */}
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {/* Phase content */}
        <main className={`cr-main cr-phase-${phaseAnim}`}>

          {/* INTRO */}
          {phase === "intro" && (
            <div className="cr-center-stage">
              <div className="cr-intro-card">
                <div className="cr-intro-icon">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="#4f9eff" strokeWidth="1.5" />
                    <path d="M10 8l6 4-6 4V8z" fill="#4f9eff" />
                  </svg>
                </div>
                <h1 className="cr-intro-title">Bereit?</h1>
                <p className="cr-intro-sub">
                  {isSolo
                    ? "Solo-Übung · 30 s Vorbereitung · 3 min Sprechen"
                    : `Duell mit ${partnerName} · 2 Runden`}
                </p>
                <button className="cr-start-btn" onClick={() => beginPrep()}>
                  Jetzt starten
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 8 }}>
                    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* PREP / SPEAKING */}
          {(phase === "prep" || phase === "speaking") && currentQ && (
            <div className="cr-game-layout">
              {/* Left column: timer */}
              <div className="cr-timer-col">
                <CircularTimer
                  timeLeft={timeLeft}
                  totalTime={totalTime}
                  phase={timerPhase}
                />
                <div className={`cr-phase-label cr-phase-${timerPhase}`}>
                  {timerPhase === "prep" ? "Vorbereitung" : "Sprechen"}
                </div>
                {phase === "prep" && (
                  <button
                    className="cr-skip-btn"
                    onClick={() => beginSpeaking(currentQ)}
                  >
                    Jetzt sprechen →
                  </button>
                )}
              </div>

              {/* Right column: question card + redemittel */}
              <div className="cr-card-col">
                <div className="cr-topic-chip">{currentQ.topic || "Thema"}</div>
                <div className="cr-question-card">
                  <p className="cr-question-text">{currentQ.question}</p>
                </div>

                {/* Redemittel */}
                <RedemittelPanel items={currentQ.redemittel} />
              </div>
            </div>
          )}

          {/* SELF ASSESS */}
          {phase === "selfAssess" && currentQ && (
            <div className="cr-assess-layout">
              <h2 className="cr-assess-heading">Wie war deine Antwort?</h2>
              <textarea
                className="cr-assess-textarea"
                placeholder="Schreib hier deine Antwort (optional) …"
                value={userText}
                onChange={e => setUserText(e.target.value)}
                rows={5}
              />
              <button
                className="cr-start-btn"
                onClick={() => {
                  const result = scoreAnswer(userText, currentQ.redemittel || []);
                  setScoreResult(result);
                  setSessionHistory(h => [...h, { q: currentQ, result }]);
                  transitionPhase("finished");
                }}
              >
                Weiter
              </button>
            </div>
          )}

          {/* SWITCHING */}
          {phase === "switching" && (
            <div className="cr-center-stage">
              <div className="cr-switch-card">
                <div className="cr-switch-icon">⇄</div>
                <h2>Rollenwechsel</h2>
                <p className="cr-switch-sub">Jetzt bist du an der Reihe: <strong>{myRole === "speaker" ? "Zuhörer" : "Sprecher"}</strong></p>
                <button className="cr-start-btn" onClick={() => {
                  setRound(r => r + 1);
                  beginPrep();
                  fbSet(`rooms/${roomId}/round`, round + 1);
                }}>
                  Weiter
                </button>
              </div>
            </div>
          )}

          {/* FINISHED */}
          {phase === "finished" && (
            <div className="cr-center-stage">
              <div className="cr-finish-card">
                <div className="cr-finish-trophy">🏆</div>
                <h1 className="cr-finish-title">Fertig!</h1>
                {scoreResult && (
                  <div className="cr-score-display">
                    <div className="cr-score-num">{scoreResult.score}<span>/10</span></div>
                    <div className="cr-score-label">Dein Score</div>
                  </div>
                )}
                <button className="cr-start-btn cr-finish-btn" onClick={onExit}>
                  Beenden
                </button>
              </div>
            </div>
          )}

        </main>
      </div>
    </>
  );
}

// ── Styles ─────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

  .cr-root {
    --bg: #12141d;
    --surface: #1a1d2b;
    --surface2: #20243a;
    --surface3: #252a40;
    --border: rgba(255,255,255,0.07);
    --border-bright: rgba(255,255,255,0.13);
    --text: #e8eaf0;
    --text-muted: #8891a8;
    --text-dim: #555e78;
    --accent: #4f9eff;
    --accent-glow: rgba(79,158,255,0.25);
    --red: #ff4d4d;
    --amber: #f59e0b;
    --green: #34d399;
    --radius: 16px;
    --radius-sm: 10px;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    font-family: 'Inter', system-ui, sans-serif;
    position: relative;
    overflow-x: hidden;
  }

  /* Noise texture */
  .cr-noise {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    opacity: 0.025;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 200px;
  }

  /* Header */
  .cr-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 28px;
    border-bottom: 1px solid var(--border);
    position: relative;
    z-index: 10;
    background: rgba(18,20,29,0.85);
    backdrop-filter: blur(12px);
  }

  .cr-logo {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-weight: 700;
    letter-spacing: -0.5px;
  }
  .cr-logo-b2 {
    color: var(--accent);
    font-size: 22px;
  }
  .cr-logo-beruf {
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 1.5px;
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
    font-size: 12px;
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
  }
  .cr-partner-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 6px var(--green);
  }

  .cr-exit-btn {
    background: var(--surface2);
    border: 1px solid var(--border-bright);
    color: var(--text-muted);
    cursor: pointer;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }
  .cr-exit-btn:hover {
    background: var(--surface3);
    color: var(--text);
    border-color: rgba(255,255,255,0.2);
  }

  /* Phase animation */
  .cr-main {
    position: relative;
    z-index: 1;
    flex: 1;
    display: flex;
    flex-direction: column;
    transition: opacity 0.22s ease, transform 0.22s ease;
  }
  .cr-phase-in  { opacity: 1; transform: translateY(0); }
  .cr-phase-out { opacity: 0; transform: translateY(10px); }

  /* Center stage */
  .cr-center-stage {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 40px 24px;
    min-height: 60vh;
  }

  /* Intro card */
  .cr-intro-card {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 52px 48px;
    text-align: center;
    max-width: 420px;
    width: 100%;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.04) inset,
      0 32px 64px rgba(0,0,0,0.5);
  }
  .cr-intro-icon {
    margin-bottom: 24px;
    display: flex;
    justify-content: center;
  }
  .cr-intro-title {
    margin: 0 0 12px;
    font-size: 42px;
    font-weight: 700;
    letter-spacing: -1px;
    color: var(--text);
  }
  .cr-intro-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin-bottom: 36px;
    line-height: 1.6;
  }

  /* Start / primary button */
  .cr-start-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #3b82f6 0%, #4f9eff 100%);
    color: #fff;
    border: none;
    padding: 14px 32px;
    border-radius: 100px;
    font-size: 15px;
    font-weight: 600;
    font-family: 'Inter', sans-serif;
    cursor: pointer;
    letter-spacing: 0.2px;
    box-shadow: 0 8px 24px rgba(79,158,255,0.35);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .cr-start-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 12px 32px rgba(79,158,255,0.45);
  }
  .cr-start-btn:active {
    transform: translateY(0);
  }

  /* Game layout */
  .cr-game-layout {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 32px;
    padding: 40px 40px 40px 48px;
    align-items: start;
    max-width: 960px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }
  @media (max-width: 720px) {
    .cr-game-layout {
      grid-template-columns: 1fr;
      padding: 24px 20px;
      gap: 24px;
    }
  }

  /* Timer column */
  .cr-timer-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    position: sticky;
    top: 32px;
  }

  .cr-timer-wrap {
    position: relative;
  }
  @keyframes timerPulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.04); }
  }
  .cr-timer-urgent .cr-timer-wrap,
  .cr-timer-urgent {
    animation: timerPulse 0.8s ease-in-out infinite;
  }

  .cr-phase-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    padding: 4px 14px;
    border-radius: 100px;
  }
  .cr-phase-prep {
    background: rgba(245,158,11,0.12);
    color: var(--amber);
    border: 1px solid rgba(245,158,11,0.25);
  }
  .cr-phase-speak {
    background: rgba(79,158,255,0.12);
    color: var(--accent);
    border: 1px solid rgba(79,158,255,0.25);
  }

  .cr-skip-btn {
    background: none;
    border: 1px solid var(--border-bright);
    color: var(--text-muted);
    font-size: 12px;
    font-family: 'Inter', sans-serif;
    padding: 7px 14px;
    border-radius: 100px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .cr-skip-btn:hover {
    background: var(--surface2);
    color: var(--text);
  }

  /* Card column */
  .cr-card-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .cr-topic-chip {
    display: inline-flex;
    align-items: center;
    background: rgba(79,158,255,0.1);
    border: 1px solid rgba(79,158,255,0.2);
    color: var(--accent);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 5px 14px;
    border-radius: 100px;
    align-self: flex-start;
  }

  .cr-question-card {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 28px 32px;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.03) inset,
      0 16px 40px rgba(0,0,0,0.4);
  }
  .cr-question-text {
    font-size: 18px;
    font-weight: 500;
    line-height: 1.7;
    color: var(--text);
    margin: 0;
  }

  /* Redemittel */
  .cr-redemittel {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-sm);
    overflow: hidden;
    transition: border-color 0.2s;
  }
  .cr-redemittel-open {
    border-color: rgba(79,158,255,0.25);
  }

  .cr-redemittel-toggle {
    width: 100%;
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.5px;
    padding: 14px 18px;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    text-align: left;
    transition: color 0.2s;
  }
  .cr-redemittel-toggle:hover { color: var(--text); }
  .cr-redemittel-icon {
    font-size: 11px;
    color: var(--accent);
    width: 14px;
  }
  .cr-redemittel-count {
    margin-left: auto;
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 100px;
  }

  .cr-redemittel-list {
    list-style: none;
    margin: 0;
    padding: 0 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 260px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--surface3) transparent;
  }
  .cr-redemittel-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-muted);
  }
  .cr-redemittel-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    margin-top: 7px;
    flex-shrink: 0;
  }

  /* Self Assess */
  .cr-assess-layout {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    padding: 48px 24px;
    max-width: 640px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }
  .cr-assess-heading {
    font-size: 24px;
    font-weight: 600;
    margin: 0;
    color: var(--text);
  }
  .cr-assess-textarea {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    font-size: 15px;
    line-height: 1.6;
    padding: 16px 20px;
    resize: vertical;
    outline: none;
    transition: border-color 0.2s;
    box-sizing: border-box;
  }
  .cr-assess-textarea:focus {
    border-color: rgba(79,158,255,0.4);
  }
  .cr-assess-textarea::placeholder { color: var(--text-dim); }

  /* Switching */
  .cr-switch-card {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 48px 40px;
    text-align: center;
    max-width: 380px;
    width: 100%;
    box-shadow: 0 24px 48px rgba(0,0,0,0.4);
  }
  .cr-switch-icon {
    font-size: 36px;
    margin-bottom: 16px;
  }
  .cr-switch-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin-bottom: 28px;
    margin-top: 8px;
  }

  /* Finished */
  .cr-finish-card {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 52px 48px;
    text-align: center;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 32px 64px rgba(0,0,0,0.5);
  }
  .cr-finish-trophy { font-size: 52px; margin-bottom: 16px; }
  .cr-finish-title {
    font-size: 38px;
    font-weight: 700;
    margin: 0 0 24px;
    color: var(--text);
  }
  .cr-finish-btn { margin-top: 8px; }

  .cr-score-display {
    margin-bottom: 28px;
  }
  .cr-score-num {
    font-size: 56px;
    font-weight: 700;
    color: var(--accent);
    line-height: 1;
  }
  .cr-score-num span {
    font-size: 24px;
    color: var(--text-dim);
    font-weight: 400;
  }
  .cr-score-label {
    font-size: 12px;
    color: var(--text-muted);
    letter-spacing: 1px;
    text-transform: uppercase;
    margin-top: 6px;
  }

  /* Modal */
  .cr-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(8,9,16,0.85);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999;
    padding: 24px;
  }
  .cr-modal-card {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 36px 32px;
    text-align: center;
    max-width: 380px;
    width: 100%;
    box-shadow: 0 32px 80px rgba(0,0,0,0.6);
    animation: modalIn 0.2s ease;
  }
  @keyframes modalIn {
    from { opacity: 0; transform: scale(0.95) translateY(8px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
  .cr-modal-icon-wrap {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: rgba(245,158,11,0.1);
    border: 1px solid rgba(245,158,11,0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
  }
  .cr-modal-title {
    font-size: 20px;
    font-weight: 600;
    margin: 0 0 10px;
    color: var(--text);
  }
  .cr-modal-body {
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
  }
  .cr-modal-actions {
    display: flex;
    gap: 10px;
    margin-top: 24px;
  }
  .cr-modal-confirm {
    flex: 1;
    background: rgba(255,77,77,0.12);
    color: var(--red);
    border: 1px solid rgba(255,77,77,0.25);
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 600;
    padding: 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.2s;
  }
  .cr-modal-confirm:hover {
    background: rgba(255,77,77,0.2);
  }
  .cr-modal-cancel {
    flex: 1;
    background: var(--surface2);
    color: var(--text-muted);
    border: 1px solid var(--border-bright);
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 600;
    padding: 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.2s;
  }
  .cr-modal-cancel:hover {
    background: var(--surface3);
    color: var(--text);
  }
`;
