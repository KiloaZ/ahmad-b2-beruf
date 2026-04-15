/**
 * ChallengeRoom.jsx — B2 Beruf Practice App
 *
 * Props:
 *   mode         — "solo" | "multi"
 *   roomId       — string | null  (null in solo mode)
 *   currentUser  — { uid, displayName }
 *   questions    — array from questions.json
 *   onExit       — callback on exit/finish
 *
 * Phases:
 *   intro → prep (30s) → speaking (180s) → [selfAssess solo] → switching → finished
 *
 * Timer logic:
 *   Solo:  local setInterval, fully offline
 *   Multi: server timestamp in Firebase for sync between two clients
 *
 * Keyword scoring (Solo only):
 *   Counts how many of q.redemittel keywords appear in user's self-assessment.
 *   Returns score 1–10.
 */

import { useState, useEffect, useRef } from "react";

// ── Firebase: lazy-loaded from firebase-config.js ─────────────
// استخدام ملف الإعدادات المنفصل لتسهيل الصيانة
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

// ── Audio beep (Web Audio API — no external files needed) ─────
function playBeep({ freq = 880, duration = 0.18, type = "sine", gain = 0.35 } = {}) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.connect(env);
    env.connect(ctx.destination);
    osc.type      = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(gain, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
    // نغمة مزدوجة: تُشعر بالبداية بوضوح
    const osc2 = ctx.createOscillator();
    const env2  = ctx.createGain();
    osc2.connect(env2);
    env2.connect(ctx.destination);
    osc2.type = type;
    osc2.frequency.value = freq * 1.5;
    env2.gain.setValueAtTime(gain * 0.6, ctx.currentTime + duration * 0.6);
    env2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration * 1.4);
    osc2.start(ctx.currentTime + duration * 0.6);
    osc2.stop(ctx.currentTime  + duration * 1.4);
  } catch {
    // المتصفح لا يدعم Web Audio — تجاهل بصمت
  }
}

// ── Constants ─────────────────────────────────────────────────
const PREP_DURATION  = 30;   // seconds — Vorbereitungszeit
const SPEAK_DURATION = 180;  // seconds — Sprechzeit

// ── Helpers ───────────────────────────────────────────────────
function pickRandom(questions, usedIds) {
  const pool = questions.filter(q => !usedIds.includes(q.id));
  const src  = pool.length > 0 ? pool : questions;
  return src[Math.floor(Math.random() * src.length)];
}

/**
 * Local keyword scoring for Solo Mode.
 * Checks if the first 2 words of each redemittel phrase appear in userText.
 * Returns { score (1-10), matched[], missed[], pct }
 */
function scoreAnswer(userText, redemittel) {
  if (!userText?.trim() || !redemittel?.length) {
    return { score: 0, matched: [], missed: redemittel || [], pct: 0 };
  }
  const lower   = userText.toLowerCase();
  const matched = [];
  const missed  = [];

  for (const r of redemittel) {
    const keyword = r.toLowerCase().split(/[\s,]+/).slice(0, 2).join(" ");
    (lower.includes(keyword) ? matched : missed).push(r);
  }

  const pct   = matched.length / redemittel.length;
  const score = Math.round(2 + pct * 8); // 2 (none) … 10 (all)
  return { score, matched, missed, pct };
}

// ── Component ─────────────────────────────────────────────────
export default function ChallengeRoom({
  mode = "solo",
  roomId = null,
  currentUser,
  questions = [],
  onExit,
}) {
  const me      = currentUser || { uid: "demo", displayName: "Du" };
  const isSolo  = mode === "solo";
  const isMulti = mode === "multi";

  // ── Core state ──────────────────────────────────────────────
  const [phase, setPhase]             = useState("intro");
  // intro | prep | speaking | selfAssess | switching | finished

  const [timerPhase, setTimerPhase]   = useState("prep");
  // "prep" (30 s) | "speak" (180 s)

  const [timeLeft, setTimeLeft]       = useState(PREP_DURATION);
  const [currentQ, setCurrentQ]       = useState(null);
  const [usedIds, setUsedIds]         = useState([]);
  const [round, setRound]             = useState(1);
  const [myRole, setMyRole]           = useState("speaker");
  const [partnerName, setPartnerName] = useState("Partner");

  const [showRedemittel, setShowRedemittel] = useState(false);
  const [showAnswer, setShowAnswer]         = useState(false);

  // ── Session history ──────────────────────────────────────────
  const [sessionHistory, setSessionHistory] = useState([]);
  // [{ q, role, userText, scoreResult }]
  const [reviewIdx, setReviewIdx]           = useState(0);

  // ── Solo self-assessment ─────────────────────────────────────
  const [userText, setUserText]       = useState("");
  const [scoreResult, setScoreResult] = useState(null);

  // ── Firebase room state ──────────────────────────────────────
  const [room, setRoom]           = useState(null);
  const [fbLoading, setFbLoading] = useState(isMulti); // true أثناء تحميل Firebase

  // ── Timer refs ───────────────────────────────────────────────
  const timerRef     = useRef(null);
  const startedAtRef = useRef(null);

  // cleanup on unmount
  useEffect(() => () => clearInterval(timerRef.current), []);

  // ═══════════════════════════════════════════════════════════
  // TIMER ENGINE
  // ═══════════════════════════════════════════════════════════
  function startLocalTimer(duration, onComplete) {
    clearInterval(timerRef.current);
    startedAtRef.current = Date.now();

    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      const left    = Math.max(0, duration - elapsed);
      setTimeLeft(left);
      if (left === 0) {
        clearInterval(timerRef.current);
        onComplete();
      }
    }, 500);
  }

  // ═══════════════════════════════════════════════════════════
  // FIREBASE LISTENER (Multiplayer)
  // ═══════════════════════════════════════════════════════════
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
        setFbLoading(false); // Firebase متصل وجاهز
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

        const statusMap = { prep:"prep", speaking:"speaking", switching:"switching", finished:"finished" };
        if (data.status && statusMap[data.status]) setPhase(statusMap[data.status]);

        if (data.timer?.startedAt && data.timer?.state === "running") {
          const elapsed  = Math.floor((Date.now() - data.timer.startedAt) / 1000);
          const left     = Math.max(0, data.timer.durationSec - elapsed);
          setTimerPhase(data.timer.phase || "prep");
          setTimeLeft(left);
        }
      });

      cleanup = () => off(roomRef);
    })();

    return () => cleanup();
  }, [isMulti, roomId]);

  // ═══════════════════════════════════════════════════════════
  // FIREBASE WRITE HELPER
  // ═══════════════════════════════════════════════════════════
  async function fbSet(path, value) {
    if (!isMulti) return;
    const db = await getFirebaseDB();
    if (!db) return;
    const { ref, set } = await import("firebase/database");
    await set(ref(db, path), value);
  }

  // ═══════════════════════════════════════════════════════════
  // GAME FLOW
  // ═══════════════════════════════════════════════════════════

  /** Begin prep phase */
  function beginPrep(questionOverride) {
    const q = questionOverride || pickRandom(questions, usedIds);
    setCurrentQ(q);
    setUsedIds(prev => [...prev, q.id]);
    setShowAnswer(false);
    setShowRedemittel(false);
    setUserText("");
    setScoreResult(null);
    setTimerPhase("prep");
    setPhase("prep");
    setTimeLeft(PREP_DURATION);

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

  /** Transition from prep → speaking */
  function beginSpeaking(q) {
    const question = q || currentQ;
    clearInterval(timerRef.current);
    setTimerPhase("speak");
    setPhase("speaking");
    setTimeLeft(SPEAK_DURATION);

    // 🔔 صوت تنبيه: انتهت فترة التحضير — ابدأ الكلام!
    playBeep({ freq: 660, duration: 0.22, gain: 0.4 });
    setTimeout(() => playBeep({ freq: 880, duration: 0.3, gain: 0.5 }), 280);

    startLocalTimer(SPEAK_DURATION, handleSpeakEnd);

    if (isMulti) {
      fbSet(`rooms/${roomId}/status`, "speaking");
      fbSet(`rooms/${roomId}/timer`, {
        startedAt: Date.now(), durationSec: SPEAK_DURATION, phase: "speak", state: "running",
      });
    }
  }

  /** Speaking timer ends */
  function handleSpeakEnd() {
    clearInterval(timerRef.current);
    // 🔔 صوت تنبيه: انتهى وقت الكلام
    playBeep({ freq: 440, duration: 0.15, gain: 0.35 });
    setTimeout(() => playBeep({ freq: 330, duration: 0.25, gain: 0.3 }), 200);
    if (isSolo) {
      setPhase("selfAssess");
      return;
    }
    if (round >= 2) { finishSession(); return; }
    setPhase("switching");
    fbSet(`rooms/${roomId}/status`, "switching");
  }

  /** Submit self-assessment (Solo) */
  function submitSelfAssess() {
    const result = scoreAnswer(userText, currentQ?.redemittel);
    setScoreResult(result);
    setSessionHistory(prev => [...prev, { q: currentQ, role: myRole, userText, scoreResult: result }]);
    if (round >= 2) { finishSession(); return; }
    setPhase("switching");
  }

  /** Skip self-assessment */
  function skipSelfAssess() {
    setSessionHistory(prev => [...prev, { q: currentQ, role: myRole, userText: "", scoreResult: null }]);
    if (round >= 2) { finishSession(); return; }
    setPhase("switching");
  }

  /** Start Round 2 */
  function startRound2() {
    const newRole = myRole === "speaker" ? "listener" : "speaker";
    setMyRole(newRole);
    setRound(2);
    setShowAnswer(false);
    setShowRedemittel(false);
    setUserText("");
    setScoreResult(null);

    if (isMulti) {
      fbSet(`rooms/${roomId}/round`, 2);
      if (room?.players?.A?.uid === me.uid) {
        fbSet(`rooms/${roomId}/players/A/role`, newRole);
        fbSet(`rooms/${roomId}/players/B/role`, newRole === "speaker" ? "listener" : "speaker");
      }
    }
    beginPrep();
  }

  function finishSession() {
    setPhase("finished");
    if (isMulti) fbSet(`rooms/${roomId}/status`, "finished");
  }

  function resetSession() {
    clearInterval(timerRef.current);
    setPhase("intro");
    setRound(1);
    setUsedIds([]);
    setMyRole("speaker");
    setCurrentQ(null);
    setShowAnswer(false);
    setShowRedemittel(false);
    setUserText("");
    setScoreResult(null);
    setSessionHistory([]);
    setReviewIdx(0);
    setTimeLeft(PREP_DURATION);
    setTimerPhase("prep");
  }

  // ═══════════════════════════════════════════════════════════
  // DERIVED VALUES
  // ═══════════════════════════════════════════════════════════
  const isPrep     = timerPhase === "prep";
  const maxTime    = isPrep ? PREP_DURATION : SPEAK_DURATION;
  const timerPct   = (timeLeft / maxTime) * 100;
  const timerColor = timeLeft > 60 ? "#3ecf6e" : timeLeft > 20 ? "#f5a623" : "#e05252";
  const mins       = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const secs       = String(timeLeft % 60).padStart(2, "0");
  const isSpeaker  = myRole === "speaker";
  const progPct    = Math.min(100, Math.round((usedIds.length / 2) * 100));

  const reviewEntry = sessionHistory[reviewIdx];

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════
  // ── Firebase Loading Screen (Multiplayer only) ──────────────
  if (fbLoading) {
    return (
      <>
        <style>{CSS}</style>
        <div className="cr-root">
          <div className="cr-grain" />
          <div className="cr-center-stage">
            <div className="cr-fb-loading-card">
              <div className="cr-fb-spinner" />
              <h2 className="cr-fb-loading-title">Verbinde mit Raum…</h2>
              <p className="cr-fb-loading-sub">
                Raum-ID: <strong>{roomId}</strong>
              </p>
              <p className="cr-fb-loading-hint">
                Stelle sicher, dass du mit dem Internet verbunden bist.
              </p>
              <button className="cr-exit-btn" style={{marginTop:8}} onClick={onExit}>
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="cr-root">
        <div className="cr-grain" />

        {/* ── HEADER ── */}
        <header className="cr-header">
          <div className="cr-logo">
            <span className="cr-logo-de">DE</span>
            <span className="cr-logo-b2">B2</span>
          </div>
          <div className="cr-header-center">
            <span className="cr-round-badge">Runde {round} / 2</span>
            {isSolo ? (
              <span className="cr-mode-pill solo">🎯 Einzeltraining</span>
            ) : (
              <>
                <span className="cr-role-pill" data-role={myRole}>
                  {isSpeaker ? "🎤 Du sprichst" : "👂 Du hörst zu"}
                </span>
                <span className="cr-partner">mit {partnerName}</span>
              </>
            )}
          </div>
          <div className="cr-progress-wrap">
            <div className="cr-progress-bar">
              <div className="cr-progress-fill" style={{ width: `${progPct}%` }} />
            </div>
            <span className="cr-progress-label">{usedIds.length}/2</span>
          </div>
          <button className="cr-exit-btn" onClick={onExit}>✕</button>
        </header>

        {/* ══ INTRO ══ */}
        {phase === "intro" && (
          <div className="cr-center-stage">
            <div className="cr-intro-card">
              <div className="cr-intro-icon">⚡</div>
              <h1 className="cr-intro-title">Bereit für die Übung?</h1>
              <p className="cr-intro-sub">
                {isSolo
                  ? "Jede Runde: 30 Sek. Vorbereitung, dann 3 Min. Sprechzeit."
                  : "Jede Runde: 30 Sek. Vorbereitung, dann 3 Min. Sprechzeit. Danach Rollentausch."}
              </p>

              <div className="cr-timer-phases-info">
                <div className="cr-tpi-item prep">
                  <span className="cr-tpi-num">30s</span>
                  <span className="cr-tpi-label">Vorbereitung</span>
                </div>
                <span className="cr-tpi-arrow">→</span>
                <div className="cr-tpi-item speak">
                  <span className="cr-tpi-num">3 Min</span>
                  <span className="cr-tpi-label">Sprechen</span>
                </div>
                {!isSolo && (
                  <>
                    <span className="cr-tpi-arrow">→</span>
                    <div className="cr-tpi-item switch">
                      <span className="cr-tpi-num">×2</span>
                      <span className="cr-tpi-label">Rollentausch</span>
                    </div>
                  </>
                )}
              </div>

              {!isSolo && (
                <div className="cr-intro-roles">
                  <div className="cr-intro-role speaker">
                    <span>🎤</span>
                    <span>{isSpeaker ? me.displayName : partnerName}</span>
                    <span className="cr-intro-role-label">spricht zuerst</span>
                  </div>
                  <div className="cr-intro-arrow">→</div>
                  <div className="cr-intro-role listener">
                    <span>👂</span>
                    <span>{isSpeaker ? partnerName : me.displayName}</span>
                    <span className="cr-intro-role-label">hört zu & antwortet</span>
                  </div>
                </div>
              )}

              <button className="cr-start-btn" onClick={() => beginPrep()}>
                Übung starten
              </button>
            </div>
          </div>
        )}

        {/* ══ PREP + SPEAKING ══ */}
        {(phase === "prep" || phase === "speaking") && currentQ && (
          <div className="cr-game-layout">

            {/* LEFT: timer */}
            <div className="cr-timer-col">
              <div className={`cr-phase-label ${isPrep ? "prep" : "speak"}`}>
                {isPrep ? "⏳ Vorbereitung" : "🎙 Sprechzeit"}
              </div>

              <div className="cr-timer-ring">
                <svg viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="44" fill="none"
                    stroke="rgba(255,255,255,0.07)" strokeWidth="6" />
                  <circle
                    cx="50" cy="50" r="44" fill="none"
                    stroke={isPrep ? "#f5a623" : timerColor}
                    strokeWidth="6" strokeLinecap="round"
                    strokeDasharray={`${2 * Math.PI * 44}`}
                    strokeDashoffset={`${2 * Math.PI * 44 * (1 - timerPct / 100)}`}
                    transform="rotate(-90 50 50)"
                    style={{ transition: "stroke-dashoffset 0.5s linear, stroke 0.5s" }}
                  />
                </svg>
                <div className="cr-timer-text">
                  <span className="cr-timer-digits"
                    style={{ color: isPrep ? "#f5a623" : timerColor }}>
                    {mins}:{secs}
                  </span>
                  <span className="cr-timer-label">verbleibend</span>
                </div>
              </div>

              <div className="cr-topic-tag">
                <span className="cr-topic-dot" />
                {currentQ.topic}
              </div>

              <div className="cr-round-info">
                <div className="cr-round-pip active" />
                <div className={`cr-round-pip ${round >= 2 ? "active" : ""}`} />
              </div>

              {isSolo && isPrep && (
                <button className="cr-skip-btn" onClick={() => beginSpeaking(currentQ)}>
                  Überspringen →
                </button>
              )}
              {isSolo && !isPrep && (
                <button className="cr-skip-btn" onClick={handleSpeakEnd}>
                  ⏭ Runde beenden
                </button>
              )}
            </div>

            {/* RIGHT: question */}
            <div className="cr-card-col">
              {isPrep && (
                <div className="cr-prep-banner">
                  <span>📖</span>
                  <span>Lies die Frage sorgfältig und bereite deine Antwort vor.</span>
                </div>
              )}

              <div className="cr-question-card">
                <div className="cr-qcard-header">
                  <span className="cr-qcard-num">Frage · Runde {round}</span>
                  {!isSolo && (
                    <span className="cr-qcard-role" data-role={myRole}>
                      {isSpeaker ? "Deine Frage" : "Kollege/in fragt dich"}
                    </span>
                  )}
                </div>
                <p className="cr-question-text">{currentQ.question}</p>
              </div>

              <div className={`cr-redemittel-box ${showRedemittel ? "open" : ""}`}>
                <button className="cr-redemittel-toggle"
                  onClick={() => setShowRedemittel(v => !v)}>
                  <span className="cr-rdm-icon">💬</span>
                  <span>Redemittel anzeigen</span>
                  <span className="cr-rdm-chevron">{showRedemittel ? "▲" : "▼"}</span>
                </button>
                {showRedemittel && (
                  <ul className="cr-redemittel-list">
                    {currentQ.redemittel.map((r, i) => (
                      <li key={i} className="cr-rdm-item">
                        <span className="cr-rdm-bullet" />{r}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {!isPrep && (
                <div className="cr-answer-box">
                  <button className={`cr-answer-toggle ${showAnswer ? "open" : ""}`}
                    onClick={() => setShowAnswer(v => !v)}>
                    <span className="cr-ans-icon">✨</span>
                    <span>Musterantwort {showAnswer ? "verbergen" : "zeigen"}</span>
                    <span className="cr-ans-chevron">{showAnswer ? "▲" : "▼"}</span>
                  </button>
                  {showAnswer && (
                    <p className="cr-answer-text">{currentQ.suggestedAnswer}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══ SELF-ASSESSMENT (Solo) ══ */}
        {phase === "selfAssess" && currentQ && (
          <div className="cr-center-stage">
            <div className="cr-assess-card">
              <div className="cr-assess-icon">📝</div>
              <h2 className="cr-assess-title">Wie war deine Antwort?</h2>
              <p className="cr-assess-sub">
                Schreibe kurz, was du gesagt hast. Das System prüft, ob du die wichtigsten Ausdrücke verwendet hast.
              </p>

              <div className="cr-assess-q">
                <span className="cr-assess-q-label">Frage war:</span>
                <p className="cr-assess-q-text">„{currentQ.question}"</p>
              </div>

              <div className="cr-assess-rdm">
                <span className="cr-assess-rdm-label">Gesuchte Redemittel:</span>
                <div className="cr-assess-rdm-pills">
                  {currentQ.redemittel.map((r, i) => (
                    <span key={i} className="cr-assess-rdm-pill">{r}</span>
                  ))}
                </div>
              </div>

              <textarea
                className="cr-assess-textarea"
                placeholder="Schreibe hier, was du gesagt hast (Stichworte reichen)…"
                value={userText}
                onChange={e => setUserText(e.target.value)}
                rows={4}
              />

              <div className="cr-assess-actions">
                <button className="cr-start-btn" onClick={submitSelfAssess}>
                  Auswerten →
                </button>
                <button className="cr-skip-assess-btn" onClick={skipSelfAssess}>
                  Überspringen
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ SWITCHING ══ */}
        {phase === "switching" && (
          <div className="cr-center-stage">
            <div className="cr-switch-card">
              <div className="cr-switch-anim">🔄</div>
              <h2 className="cr-switch-title">Rollentausch!</h2>
              <p className="cr-switch-sub">
                Runde 1 ist vorbei.
                {!isSolo && (
                  <> Jetzt ist{" "}
                    <strong>{isSpeaker ? partnerName : me.displayName}</strong>{" "}
                    dran zu sprechen.
                  </>
                )}
              </p>
              {!isSolo && (
                <div className="cr-switch-roles">
                  <div className="cr-switch-role new-speaker">
                    <span>🎤</span>
                    <span>{isSpeaker ? partnerName : me.displayName}</span>
                  </div>
                  <div className="cr-switch-arrow">⇄</div>
                  <div className="cr-switch-role new-listener">
                    <span>👂</span>
                    <span>{isSpeaker ? me.displayName : partnerName}</span>
                  </div>
                </div>
              )}
              <button className="cr-start-btn" onClick={startRound2}>
                Runde 2 starten
              </button>
            </div>
          </div>
        )}

        {/* ══ FINISHED ══ */}
        {phase === "finished" && (
          <div className="cr-center-stage cr-finish-scroll">

            <div className="cr-finish-header">
              <div className="cr-finish-icon">🏆</div>
              <h1 className="cr-finish-title">Übung abgeschlossen!</h1>
              <p className="cr-finish-sub">
                {isSolo
                  ? "Vergleiche deine Antworten mit den Musterlösungen."
                  : "Vergleiche deine Antworten und hinterlasse Feedback für deinen Partner."}
              </p>
              <div className="cr-finish-stats">
                <div className="cr-fstat">
                  <span className="cr-fstat-num">2</span>
                  <span className="cr-fstat-label">Runden</span>
                </div>
                <div className="cr-fstat">
                  <span className="cr-fstat-num">{usedIds.length}</span>
                  <span className="cr-fstat-label">Fragen</span>
                </div>
                {isSolo && sessionHistory.some(e => e.scoreResult) ? (
                  <div className="cr-fstat">
                    <span className="cr-fstat-num">
                      {Math.round(
                        sessionHistory
                          .filter(e => e.scoreResult)
                          .reduce((s, e) => s + e.scoreResult.score, 0) /
                        sessionHistory.filter(e => e.scoreResult).length
                      )}
                      <span style={{ fontSize: "14px" }}>/10</span>
                    </span>
                    <span className="cr-fstat-label">Ø Score</span>
                  </div>
                ) : (
                  <div className="cr-fstat">
                    <span className="cr-fstat-num">6</span>
                    <span className="cr-fstat-label">Minuten</span>
                  </div>
                )}
              </div>
            </div>

            {sessionHistory.length > 0 && (
              <div className="cr-review-wrap">
                <div className="cr-review-nav">
                  {sessionHistory.map((e, i) => (
                    <button key={i}
                      className={`cr-nav-pill${i === reviewIdx ? " active" : ""}`}
                      onClick={() => setReviewIdx(i)}>
                      {i + 1}
                    </button>
                  ))}
                </div>

                {reviewEntry && (
                  <div className="cr-review-card">
                    <div className="cr-review-topic-row">
                      <span className="cr-topic-badge">{reviewEntry.q.topic}</span>
                      <span className="cr-review-role-tag">
                        {reviewEntry.role === "speaker" ? "🎙 Du hast gesprochen" : "👂 Du hast zugehört"}
                      </span>
                    </div>

                    <div className="cr-review-question">
                      <div className="cr-review-q-label">Frage</div>
                      <p className="cr-review-q-text">„{reviewEntry.q.question}"</p>
                    </div>

                    {/* Solo score */}
                    {isSolo && reviewEntry.scoreResult && (
                      <div className="cr-score-card">
                        <div className="cr-score-header">
                          <span className="cr-score-label">Keyword-Score</span>
                          <span className="cr-score-value">
                            {reviewEntry.scoreResult.score}
                            <span className="cr-score-max">/10</span>
                          </span>
                        </div>
                        <div className="cr-score-bar-wrap">
                          <div className="cr-score-bar-fill"
                            style={{ width: `${reviewEntry.scoreResult.score * 10}%` }} />
                        </div>
                        {reviewEntry.scoreResult.matched.length > 0 && (
                          <div className="cr-score-matched">
                            <span className="cr-score-tag green">✓ Verwendet:</span>
                            {reviewEntry.scoreResult.matched.map((r, i) => (
                              <span key={i} className="cr-score-kw green">{r}</span>
                            ))}
                          </div>
                        )}
                        {reviewEntry.scoreResult.missed.length > 0 && (
                          <div className="cr-score-matched">
                            <span className="cr-score-tag red">✗ Vergessen:</span>
                            {reviewEntry.scoreResult.missed.map((r, i) => (
                              <span key={i} className="cr-score-kw red">{r}</span>
                            ))}
                          </div>
                        )}
                        {reviewEntry.userText && (
                          <div className="cr-score-user-text">
                            <span className="cr-score-user-label">Deine Antwort:</span>
                            <p className="cr-score-user-body">{reviewEntry.userText}</p>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="cr-model-answer-block">
                      <div className="cr-model-answer-label">
                        <span>💡</span><span>Musterlösung</span>
                      </div>
                      <p className="cr-model-answer-text">{reviewEntry.q.suggestedAnswer}</p>
                    </div>

                    {reviewEntry.q.redemittel?.length > 0 && (
                      <div className="cr-review-redemittel">
                        <div className="cr-review-redemittel-label">Redemittel</div>
                        <ul className="cr-review-redemittel-list">
                          {reviewEntry.q.redemittel.map((r, i) => (
                            <li key={i} className="cr-review-redemittel-item">
                              <span className="cr-r-bullet">›</span>{r}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {isMulti && <FeedbackBox partnerName={partnerName} />}

                    <div className="cr-review-pagination">
                      <button className="cr-page-btn"
                        onClick={() => setReviewIdx(i => Math.max(0, i - 1))}
                        disabled={reviewIdx === 0}>← Zurück</button>
                      <span className="cr-page-counter">{reviewIdx + 1} / {sessionHistory.length}</span>
                      <button className="cr-page-btn"
                        onClick={() => setReviewIdx(i => Math.min(sessionHistory.length - 1, i + 1))}
                        disabled={reviewIdx === sessionHistory.length - 1}>Weiter →</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="cr-finish-actions cr-finish-actions-bottom">
              <button className="cr-start-btn" onClick={resetSession}>Nochmal üben</button>
              <button className="cr-exit-btn2" onClick={onExit}>Zum Menü</button>
            </div>
          </div>
        )}

      </div>
    </>
  );
}

// ── Feedback box (Multiplayer only) ──────────────────────────
function FeedbackBox({ partnerName }) {
  const [text, setText]   = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <div className="cr-feedback-block">
      <label className="cr-feedback-label">✏️ Feedback für {partnerName}</label>
      <textarea
        className="cr-feedback-textarea"
        placeholder={`Schreibe Feedback für ${partnerName} …`}
        value={text}
        onChange={e => { setText(e.target.value); setSaved(false); }}
        rows={3}
      />
      <button
        className={`cr-feedback-save-btn${saved ? " saved" : ""}`}
        onClick={() => setSaved(true)}
        disabled={!text.trim() || saved}>
        {saved ? "✓ Gespeichert" : "Feedback speichern"}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════════════════════
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root{
  --bg:#0c0d12;--surface:#13151d;--surface2:#1c1f2b;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.12);
  --accent:#5b7fff;--accent2:#7b9fff;--green:#3ecf6e;--amber:#f5a623;--red:#e05252;
  --text:#eaecf2;--muted:#7c8096;--muted2:#4a4f62;
  --radius:16px;--fh:'Syne',sans-serif;--fb:'DM Sans',sans-serif;
}

.cr-root{min-height:100vh;background:var(--bg);color:var(--text);font-family:var(--fb);position:relative;display:flex;flex-direction:column}
.cr-grain{pointer-events:none;position:fixed;inset:0;z-index:0;opacity:.025;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");background-size:150px}

.cr-header{position:relative;z-index:10;display:flex;align-items:center;gap:12px;padding:12px 24px;border-bottom:1px solid var(--border);background:rgba(12,13,18,0.92);backdrop-filter:blur(12px);flex-wrap:wrap}
.cr-logo{display:flex;align-items:baseline;gap:3px;font-family:var(--fh);font-weight:800}
.cr-logo-de{font-size:20px;color:var(--accent)}
.cr-logo-b2{font-size:13px;color:var(--muted);letter-spacing:.06em}
.cr-header-center{display:flex;align-items:center;gap:10px;flex:1;justify-content:center;flex-wrap:wrap}
.cr-round-badge{font-family:var(--fh);font-size:12px;font-weight:600;background:var(--surface2);border:1px solid var(--border2);border-radius:99px;padding:4px 12px;color:var(--muted)}
.cr-mode-pill{font-family:var(--fh);font-size:12px;font-weight:600;border-radius:99px;padding:4px 14px;border:1px solid}
.cr-mode-pill.solo{background:rgba(91,127,255,.12);border-color:rgba(91,127,255,.35);color:var(--accent2)}
.cr-role-pill{font-family:var(--fh);font-size:12px;font-weight:600;border-radius:99px;padding:4px 14px;border:1px solid}
.cr-role-pill[data-role="speaker"]{background:rgba(91,127,255,.12);border-color:rgba(91,127,255,.4);color:var(--accent2)}
.cr-role-pill[data-role="listener"]{background:rgba(245,166,35,.1);border-color:rgba(245,166,35,.3);color:var(--amber)}
.cr-partner{font-size:12px;color:var(--muted)}
.cr-progress-wrap{display:flex;align-items:center;gap:8px;min-width:72px}
.cr-progress-bar{flex:1;height:4px;background:var(--surface2);border-radius:2px;overflow:hidden}
.cr-progress-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .5s ease}
.cr-progress-label{font-size:11px;color:var(--muted);white-space:nowrap}
.cr-exit-btn{background:transparent;border:1px solid var(--border2);color:var(--muted);padding:6px 10px;border-radius:8px;font-size:14px;cursor:pointer;transition:border-color .2s,color .2s}
.cr-exit-btn:hover{border-color:var(--red);color:var(--red)}

.cr-center-stage{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 20px;position:relative;z-index:1}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}

.cr-intro-card{background:var(--surface);border:1px solid var(--border2);border-radius:24px;padding:40px 36px;max-width:520px;width:100%;display:flex;flex-direction:column;align-items:center;gap:20px;animation:fadeUp .4s ease}
.cr-intro-icon{font-size:42px;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
.cr-intro-title{font-family:var(--fh);font-size:24px;font-weight:800;text-align:center}
.cr-intro-sub{font-size:15px;color:var(--muted);text-align:center;line-height:1.6}
.cr-timer-phases-info{display:flex;align-items:center;gap:12px;background:var(--surface2);border-radius:12px;padding:14px 20px;width:100%}
.cr-tpi-item{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1}
.cr-tpi-num{font-family:var(--fh);font-size:16px;font-weight:700}
.cr-tpi-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.cr-tpi-item.prep .cr-tpi-num{color:var(--amber)}
.cr-tpi-item.speak .cr-tpi-num{color:var(--accent2)}
.cr-tpi-item.switch .cr-tpi-num{color:var(--green)}
.cr-tpi-arrow{color:var(--muted2);font-size:16px}
.cr-intro-roles{display:flex;align-items:center;gap:16px;width:100%;background:var(--surface2);border-radius:14px;padding:16px}
.cr-intro-role{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:13px;font-weight:500;text-align:center}
.cr-intro-role span:first-child{font-size:22px}
.cr-intro-role-label{font-size:11px;color:var(--muted)}
.cr-intro-role.speaker{color:var(--accent2)}
.cr-intro-role.listener{color:var(--amber)}
.cr-intro-arrow{font-size:20px;color:var(--muted2)}
.cr-start-btn{background:var(--accent);color:#fff;border:none;border-radius:12px;padding:14px 36px;font-family:var(--fh);font-size:15px;font-weight:700;cursor:pointer;transition:opacity .2s,transform .1s;letter-spacing:.02em}
.cr-start-btn:hover{opacity:.88}
.cr-start-btn:active{transform:scale(.97)}

.cr-game-layout{flex:1;display:grid;grid-template-columns:220px 1fr;gap:24px;padding:28px 32px;position:relative;z-index:1;max-width:1000px;margin:0 auto;width:100%}
.cr-timer-col{display:flex;flex-direction:column;align-items:center;gap:18px}
.cr-phase-label{font-family:var(--fh);font-size:12px;font-weight:700;border-radius:99px;padding:5px 14px;border:1px solid;letter-spacing:.04em}
.cr-phase-label.prep{color:var(--amber);background:rgba(245,166,35,.1);border-color:rgba(245,166,35,.3)}
.cr-phase-label.speak{color:var(--accent2);background:rgba(91,127,255,.1);border-color:rgba(91,127,255,.3)}
.cr-timer-ring{position:relative;width:160px;height:160px}
.cr-timer-ring svg{width:100%;height:100%}
.cr-timer-text{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.cr-timer-digits{font-family:var(--fh);font-size:32px;font-weight:800;line-height:1;transition:color .5s}
.cr-timer-label{font-size:10px;color:var(--muted);letter-spacing:.05em}
.cr-topic-tag{display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--border2);border-radius:99px;padding:6px 14px;font-size:12px;font-weight:500;color:var(--muted);text-align:center}
.cr-topic-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent);flex-shrink:0}
.cr-round-info{display:flex;gap:8px}
.cr-round-pip{width:28px;height:5px;border-radius:3px;background:var(--surface2);transition:background .4s}
.cr-round-pip.active{background:var(--accent)}
.cr-skip-btn{background:transparent;border:1px dashed var(--muted2);color:var(--muted);padding:7px 14px;border-radius:8px;font-size:11px;cursor:pointer;font-family:var(--fh);transition:border-color .2s,color .2s;text-align:center}
.cr-skip-btn:hover{border-color:var(--muted);color:var(--text)}

.cr-card-col{display:flex;flex-direction:column;gap:14px}
.cr-prep-banner{background:rgba(245,166,35,.07);border:1px solid rgba(245,166,35,.2);border-radius:10px;padding:11px 14px;display:flex;align-items:center;gap:8px;font-size:13px;color:rgba(245,166,35,.9);line-height:1.5}
.cr-question-card{background:var(--surface);border:1px solid var(--border2);border-radius:var(--radius);padding:26px 26px 22px;animation:fadeUp .3s ease}
.cr-qcard-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.cr-qcard-num{font-family:var(--fh);font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.1em;text-transform:uppercase}
.cr-qcard-role{font-size:12px;font-weight:500;border-radius:99px;padding:3px 12px;border:1px solid}
.cr-qcard-role[data-role="speaker"]{background:rgba(91,127,255,.1);border-color:rgba(91,127,255,.35);color:var(--accent2)}
.cr-qcard-role[data-role="listener"]{background:rgba(245,166,35,.1);border-color:rgba(245,166,35,.3);color:var(--amber)}
.cr-question-text{font-size:19px;font-weight:500;line-height:1.55;color:var(--text);font-style:italic}
.cr-redemittel-box{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:border-color .2s}
.cr-redemittel-box.open{border-color:rgba(91,127,255,.4)}
.cr-redemittel-toggle{width:100%;display:flex;align-items:center;gap:10px;background:transparent;border:none;padding:13px 18px;color:var(--accent2);font-family:var(--fh);font-size:13px;font-weight:600;cursor:pointer;text-align:left}
.cr-rdm-icon{font-size:15px}
.cr-rdm-chevron{margin-left:auto;font-size:10px}
.cr-redemittel-list{list-style:none;padding:4px 18px 14px;display:flex;flex-direction:column;gap:9px;animation:fadeUp .2s ease}
.cr-rdm-item{display:flex;align-items:baseline;gap:10px;font-size:14px;color:var(--text);line-height:1.5}
.cr-rdm-bullet{width:6px;height:6px;border-radius:50%;background:var(--accent);flex-shrink:0;margin-top:6px}
.cr-answer-box{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:border-color .2s}
.cr-answer-toggle{width:100%;display:flex;align-items:center;gap:10px;background:transparent;border:none;padding:13px 18px;color:var(--muted);font-family:var(--fh);font-size:13px;font-weight:600;cursor:pointer;text-align:left;transition:color .2s}
.cr-answer-toggle.open{color:var(--green)}
.cr-ans-icon{font-size:15px}
.cr-ans-chevron{margin-left:auto;font-size:10px}
.cr-answer-text{font-size:14px;color:var(--muted);line-height:1.7;border-top:1px solid var(--border);margin:0 18px;padding:13px 0 16px;animation:fadeUp .2s ease}

.cr-assess-card{background:var(--surface);border:1px solid var(--border2);border-radius:24px;padding:36px 32px;max-width:560px;width:100%;display:flex;flex-direction:column;gap:18px;animation:fadeUp .4s ease}
.cr-assess-icon{font-size:38px;text-align:center}
.cr-assess-title{font-family:var(--fh);font-size:22px;font-weight:800;text-align:center}
.cr-assess-sub{font-size:14px;color:var(--muted);text-align:center;line-height:1.6}
.cr-assess-q{display:flex;flex-direction:column;gap:6px}
.cr-assess-q-label{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.cr-assess-q-text{font-size:14px;font-style:italic;color:var(--text);background:var(--surface2);border-radius:10px;padding:11px 13px;border-left:3px solid var(--accent);line-height:1.6}
.cr-assess-rdm{display:flex;flex-direction:column;gap:8px}
.cr-assess-rdm-label{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--accent);font-weight:600}
.cr-assess-rdm-pills{display:flex;flex-wrap:wrap;gap:7px}
.cr-assess-rdm-pill{font-size:12px;background:rgba(91,127,255,.1);border:1px solid rgba(91,127,255,.25);color:var(--accent2);border-radius:99px;padding:4px 11px}
.cr-assess-textarea{width:100%;resize:vertical;min-height:90px;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:12px 14px;color:var(--text);font-family:var(--fb);font-size:14px;line-height:1.6;outline:none;transition:border-color .2s}
.cr-assess-textarea:focus{border-color:var(--accent)}
.cr-assess-textarea::placeholder{color:var(--muted2)}
.cr-assess-actions{display:flex;gap:10px;align-items:center}
.cr-assess-actions .cr-start-btn{flex:2;padding:13px}
.cr-skip-assess-btn{flex:1;background:transparent;border:1px solid var(--border2);color:var(--muted);border-radius:12px;padding:13px;font-family:var(--fh);font-size:13px;cursor:pointer;transition:color .2s,border-color .2s}
.cr-skip-assess-btn:hover{color:var(--text);border-color:var(--muted)}

.cr-switch-card{background:var(--surface);border:1px solid var(--border2);border-radius:24px;padding:40px 36px;max-width:480px;width:100%;display:flex;flex-direction:column;align-items:center;gap:20px;animation:fadeUp .4s ease}
.cr-switch-anim{font-size:48px;animation:spin .8s ease-in-out}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.cr-switch-title{font-family:var(--fh);font-size:26px;font-weight:800}
.cr-switch-sub{font-size:15px;color:var(--muted);text-align:center;line-height:1.6}
.cr-switch-roles{display:flex;align-items:center;gap:20px;background:var(--surface2);border-radius:14px;padding:16px 24px;width:100%}
.cr-switch-role{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;font-size:13px;font-weight:600}
.cr-switch-role span:first-child{font-size:28px}
.cr-switch-role.new-speaker{color:var(--accent2)}
.cr-switch-role.new-listener{color:var(--amber)}
.cr-switch-arrow{font-size:22px;color:var(--muted2)}

.cr-finish-scroll{flex-direction:column;align-items:center;padding:32px 20px 48px;overflow-y:auto;width:100%}
.cr-finish-header{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:520px;width:100%;margin-bottom:12px}
.cr-finish-icon{font-size:48px;animation:bounce .6s ease}
@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
.cr-finish-title{font-family:var(--fh);font-size:26px;font-weight:800;text-align:center}
.cr-finish-sub{font-size:14px;color:var(--muted);text-align:center;line-height:1.6}
.cr-finish-stats{display:flex;gap:0;width:100%;background:var(--surface2);border-radius:14px;overflow:hidden}
.cr-fstat{flex:1;display:flex;flex-direction:column;align-items:center;padding:18px 0;gap:4px;border-right:1px solid var(--border)}
.cr-fstat:last-child{border-right:none}
.cr-fstat-num{font-family:var(--fh);font-size:28px;font-weight:800;color:var(--accent2)}
.cr-fstat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.cr-finish-actions{display:flex;gap:12px;width:100%}
.cr-finish-actions .cr-start-btn{flex:2}
.cr-finish-actions-bottom{margin-top:8px;max-width:560px;width:100%}
.cr-exit-btn2{flex:1;background:var(--surface2);border:1px solid var(--border2);color:var(--muted);border-radius:12px;padding:14px 20px;font-family:var(--fh);font-size:14px;font-weight:600;cursor:pointer;transition:color .2s,border-color .2s}
.cr-exit-btn2:hover{color:var(--text);border-color:var(--accent)}

.cr-review-wrap{max-width:560px;width:100%;display:flex;flex-direction:column;gap:14px}
.cr-review-nav{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.cr-nav-pill{width:34px;height:34px;border-radius:50%;background:var(--surface2);border:1px solid var(--border2);color:var(--muted);font-family:var(--fh);font-size:12px;font-weight:700;cursor:pointer;transition:background .2s,color .2s,border-color .2s}
.cr-nav-pill:hover,.cr-nav-pill.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.cr-review-card{background:var(--surface);border:1px solid var(--border2);border-radius:20px;padding:26px;display:flex;flex-direction:column;gap:18px;animation:fadeUp .3s ease}
.cr-review-topic-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cr-topic-badge{font-size:11px;background:rgba(91,127,255,.1);border:1px solid rgba(91,127,255,.2);color:var(--accent2);border-radius:99px;padding:3px 10px}
.cr-review-role-tag{font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:99px;padding:3px 10px;margin-left:auto}
.cr-review-question{display:flex;flex-direction:column;gap:6px}
.cr-review-q-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.cr-review-q-text{font-size:14px;line-height:1.6;color:var(--text);background:var(--surface2);border-radius:10px;padding:11px 13px;border-left:3px solid var(--accent)}

.cr-score-card{background:var(--surface2);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;border:1px solid var(--border2)}
.cr-score-header{display:flex;align-items:center;justify-content:space-between}
.cr-score-label{font-family:var(--fh);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.cr-score-value{font-family:var(--fh);font-size:26px;font-weight:800;color:var(--accent2)}
.cr-score-max{font-size:13px;color:var(--muted)}
.cr-score-bar-wrap{height:6px;background:var(--bg);border-radius:3px;overflow:hidden}
.cr-score-bar-fill{height:100%;background:var(--accent);border-radius:3px;transition:width .6s ease}
.cr-score-matched{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cr-score-tag{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.cr-score-tag.green{color:var(--green)}
.cr-score-tag.red{color:var(--red)}
.cr-score-kw{font-size:12px;border-radius:99px;padding:3px 9px;border:1px solid}
.cr-score-kw.green{background:rgba(62,207,110,.1);border-color:rgba(62,207,110,.25);color:var(--green)}
.cr-score-kw.red{background:rgba(224,82,82,.1);border-color:rgba(224,82,82,.25);color:var(--red)}
.cr-score-user-text{display:flex;flex-direction:column;gap:4px}
.cr-score-user-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.cr-score-user-body{font-size:13px;color:var(--muted);line-height:1.6;font-style:italic;border-left:2px solid var(--muted2);padding-left:10px}

.cr-model-answer-block{background:rgba(62,207,110,.07);border:1px solid rgba(62,207,110,.2);border-radius:14px;padding:15px 17px;display:flex;flex-direction:column;gap:8px}
.cr-model-answer-label{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.06em}
.cr-model-answer-text{font-size:13px;line-height:1.7;color:var(--text)}
.cr-review-redemittel{background:var(--surface2);border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:8px}
.cr-review-redemittel-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);font-weight:700}
.cr-review-redemittel-list{list-style:none;display:flex;flex-direction:column;gap:5px}
.cr-review-redemittel-item{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--muted);line-height:1.5}
.cr-r-bullet{color:var(--accent2);font-size:14px;flex-shrink:0}

.cr-feedback-block{display:flex;flex-direction:column;gap:8px}
.cr-feedback-label{font-size:13px;font-weight:600;color:var(--text)}
.cr-feedback-textarea{width:100%;resize:vertical;min-height:76px;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:11px 13px;color:var(--text);font-family:var(--fb);font-size:13px;line-height:1.6;outline:none;transition:border-color .2s}
.cr-feedback-textarea:focus{border-color:var(--accent)}
.cr-feedback-textarea::placeholder{color:var(--muted2)}
.cr-feedback-save-btn{align-self:flex-end;background:var(--accent);color:#fff;border:none;border-radius:10px;padding:9px 20px;font-family:var(--fh);font-size:12px;font-weight:700;cursor:pointer;transition:background .2s,opacity .2s}
.cr-feedback-save-btn:disabled{opacity:.35;cursor:default}
.cr-feedback-save-btn.saved{background:var(--green);cursor:default}

/* ── Firebase Loading Card ── */
.cr-fb-loading-card{background:var(--surface);border:1px solid var(--border2);border-radius:24px;padding:48px 36px;max-width:380px;width:100%;display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;animation:fadeUp .4s ease}
.cr-fb-spinner{width:44px;height:44px;border:3px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.cr-fb-loading-title{font-family:var(--fh);font-size:20px;font-weight:800;color:var(--text)}
.cr-fb-loading-sub{font-size:14px;color:var(--muted)}
.cr-fb-loading-sub strong{color:var(--accent2);font-family:var(--fh);letter-spacing:.08em}
.cr-fb-loading-hint{font-size:12px;color:var(--muted2);line-height:1.5}

.cr-review-pagination{display:flex;align-items:center;justify-content:space-between;gap:10px}
.cr-page-btn{background:var(--surface2);border:1px solid var(--border2);color:var(--muted);border-radius:10px;padding:8px 16px;font-family:var(--fh);font-size:12px;font-weight:600;cursor:pointer;transition:color .2s,border-color .2s}
.cr-page-btn:hover:not(:disabled){color:var(--text);border-color:var(--accent)}
.cr-page-btn:disabled{opacity:.3;cursor:default}
.cr-page-counter{font-size:12px;color:var(--muted);font-family:var(--fh);font-weight:600}

@media(max-width:640px){
  .cr-game-layout{grid-template-columns:1fr;padding:12px 14px;gap:14px}
  .cr-timer-col{flex-direction:row;flex-wrap:wrap;justify-content:center;gap:10px}
  .cr-timer-ring{width:110px;height:110px}
  .cr-timer-digits{font-size:22px}
  .cr-question-text{font-size:16px}
  .cr-intro-card,.cr-switch-card,.cr-assess-card{padding:22px 16px}
  .cr-review-card{padding:16px 12px}
  .cr-finish-actions{flex-direction:column}
  .cr-header{padding:10px 12px;gap:8px}
  /* Progress bar: مرئي دائماً على الهاتف — مهم للطلاب */
  .cr-progress-wrap{display:flex;min-width:60px}
  .cr-progress-label{font-size:10px}
  /* Self-assessment: محسّن للهاتف */
  .cr-assess-card{max-width:100%;border-radius:18px}
  .cr-assess-textarea{min-height:80px;font-size:15px}
  .cr-assess-rdm-pills{gap:5px}
  .cr-assess-rdm-pill{font-size:11px;padding:3px 9px}
  .cr-assess-actions{flex-direction:column-reverse}
  .cr-assess-actions .cr-start-btn{width:100%}
  .cr-skip-assess-btn{width:100%}
  /* Redemittel pills: أصغر حجماً على الهاتف */
  .cr-rdm-item{font-size:13px}
  /* Review cards */
  .cr-finish-stats{gap:0}
  .cr-fstat{padding:14px 0}
  .cr-fstat-num{font-size:22px}
}

@media(max-width:380px){
  .cr-header-center{display:none} /* إخفاء الوسط على الشاشات الصغيرة جداً */
  .cr-timer-ring{width:95px;height:95px}
  .cr-timer-digits{font-size:19px}
}
`;
