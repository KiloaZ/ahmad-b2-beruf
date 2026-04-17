/**
 * ChallengeRoom.jsx — B2 Beruf Practice App
 * * الميزات المضافة:
 * 1. تأكيد الخروج (Exit Confirmation Modal).
 * 2. دعم متغيرات البيئة (Environment Variables) لـ Firebase.
 * 3. تحسين منطق التنقل بين المراحل.
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
  
  // 1. إضافة حالة نافذة تأكيد الخروج
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const [userText, setUserText] = useState("");
  const [scoreResult, setScoreResult] = useState(null);
  const [room, setRoom] = useState(null);
  const [fbLoading, setFbLoading] = useState(isMulti);

  const timerRef = useRef(null);
  const startedAtRef = useRef(null);

  useEffect(() => () => clearInterval(timerRef.current), []);

  // 2. دالة التعامل مع طلب الخروج
  function handleExitRequest() {
    if (phase === "intro" || phase === "finished") {
      onExit();
      return;
    }
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
    setPhase("prep");
    setTimerPhase("prep");
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

  function beginSpeaking(q) {
    clearInterval(timerRef.current);
    setPhase("speaking");
    setTimerPhase("speak");
    setTimeLeft(SPEAK_DURATION);
    playBeep({ freq: 660, gain: 0.4 });
    startLocalTimer(SPEAK_DURATION, handleSpeakEnd);
    if (isMulti) {
      fbSet(`rooms/${roomId}/status`, "speaking");
      fbSet(`rooms/${roomId}/timer`, { startedAt: Date.now(), durationSec: SPEAK_DURATION, phase: "speak", state: "running" });
    }
  }

  function handleSpeakEnd() {
    clearInterval(timerRef.current);
    playBeep({ freq: 440, gain: 0.3 });
    if (isSolo) { setPhase("selfAssess"); return; }
    if (round >= 2) { setPhase("finished"); return; }
    setPhase("switching");
    fbSet(`rooms/${roomId}/status`, "switching");
  }

  const mins = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const secs = String(timeLeft % 60).padStart(2, "0");
  const timerPct = (timeLeft / (timerPhase === "prep" ? PREP_DURATION : SPEAK_DURATION)) * 100;

  return (
    <>
      <style>{CSS}</style>
      <div className="cr-root">
        <div className="cr-grain" />

        {/* 3. إضافة نافذة التأكيد قبل الـ header */}
        {showExitConfirm && (
          <ExitConfirmModal 
            onConfirm={() => { setShowExitConfirm(false); onExit(); }}
            onCancel={() => setShowExitConfirm(false)} 
          />
        )}

        <header className="cr-header">
          <div className="cr-logo">B2 Beruf</div>
          <div className="cr-header-center">
            <span className="cr-round-badge">Runde {round}/2</span>
          </div>
          {/* 4. تغيير onClick لزر الخروج */}
          <button className="cr-exit-btn" onClick={handleExitRequest}>✕</button>
        </header>

        {phase === "intro" && (
          <div className="cr-center-stage">
            <div className="cr-intro-card">
              <h1>Bereit?</h1>
              <button className="cr-start-btn" onClick={() => beginPrep()}>Starten</button>
            </div>
          </div>
        )}

        {(phase === "prep" || phase === "speaking") && currentQ && (
          <div className="cr-game-layout">
            <div className="cr-timer-col">
              <div className="cr-timer-digits">{mins}:{secs}</div>
              <div className="cr-topic-tag">{currentQ.topic}</div>
            </div>
            <div className="cr-card-col">
              <div className="cr-question-card">
                <p>{currentQ.question}</p>
              </div>
            </div>
          </div>
        )}

        {/* ... بقية مراحل الرندر (selfAssess, switching, finished) تتبع نفس النمط ... */}
        {phase === "finished" && (
           <div className="cr-center-stage">
              <div className="cr-finish-card">
                <h1>🏆 Fertig!</h1>
                <button className="cr-start-btn" onClick={onExit}>Beenden</button>
              </div>
           </div>
        )}
      </div>
    </>
  );
}

// 5. مكوّن نافذة تأكيد الخروج
function ExitConfirmModal({ onConfirm, onCancel }) {
  return (
    <div className="cr-modal-overlay">
      <div className="cr-modal-card">
        <div className="cr-modal-icon">⚠️</div>
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

const CSS = `
.cr-root { --red: #e05252; --text: #fff; --muted: #a0a0a0; background: #0f111a; color: var(--text); min-height: 100vh; font-family: sans-serif; }
.cr-header { display: flex; justify-content: space-between; padding: 20px; border-bottom: 1px solid #222; }
.cr-exit-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 20px; }
.cr-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 999; }
.cr-modal-card { background: #1c1f2b; padding: 30px; border-radius: 20px; text-align: center; max-width: 400px; }
.cr-modal-actions { display: flex; gap: 10px; margin-top: 20px; }
.cr-modal-confirm { flex: 1; background: var(--red); color: white; border: none; padding: 12px; border-radius: 10px; cursor: pointer; }
.cr-modal-cancel { flex: 1; background: #333; color: white; border: none; padding: 12px; border-radius: 10px; cursor: pointer; }
/* أضف بقية الـ CSS الخاص بك هنا */
`;