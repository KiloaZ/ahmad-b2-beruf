/**
 * ChallengeRoom.jsx — B2 Beruf · v7 Full-Sync
 *
 * ══════════════════════════════════════════════════════════════════════
 *  FIREBASE DATA SHAPE
 * ══════════════════════════════════════════════════════════════════════
 *
 *  rooms/{roomId}/
 *    roomState/                     ← control plane (low-write)
 *      status            string     'intro'|'prep'|'speaking'|'analyzing'|'results'|'switching'|'finished'
 *      currentSpeaker    uid        who is Room Master this turn
 *      timerPhase        string     'prep'|'speak'
 *      timerEndsAt       number|null epoch-ms when current phase ends
 *      currentQuestionId string
 *      round             number     1|2
 *      speakerOrder      [uid,uid]  set once at room creation — never changes
 *
 *    transcript/{uid}/              ← high-write, SEPARATE from roomState (I-2)
 *      text              string     accumulated final transcript
 *      interim           string     current partial chunk
 *      updatedAt         number     epoch-ms
 *
 *    results/                       ← written once per round, triggers UI on both (I-3)
 *      round1            object|null feedbackObj
 *      round2            object|null feedbackObj
 *
 *    analyzing/{uid}    boolean     scalar overlay flag — no merge race (I-8)
 *
 *    players/                       ← written by matchmaking only
 *      A/ {uid, displayName}
 *      B/ {uid, displayName}
 *
 * ══════════════════════════════════════════════════════════════════════
 *  INVARIANTS
 * ══════════════════════════════════════════════════════════════════════
 *  I-1  setRs called ONLY inside onValue(roomState) in multi mode
 *  I-2  Transcript → transcript/{uid}, never inside roomState
 *  I-3  Results → results/round{N}; both clients listen; screen appears on data arrival
 *  I-4  masterEndsAtRef prevents countdown restart on unrelated snapshots
 *  I-5  amSpeaker derived from confirmed Firebase state, never optimistic
 *  I-6  Mic active ONLY when status==='speaking' && amSpeaker && isRecording
 *  I-7  Page refresh: onValue fires immediately → full state restored automatically
 *  I-8  analyzingFlag = scalar boolean at analyzing/{uid}, each client owns only theirs
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Firebase wrappers
// ─────────────────────────────────────────────────────────────────────────────
let _db = null;
async function getDB() {
  if (_db) return _db;
  try { const m = await import("./firebase-config.js"); _db = m.db; return _db; }
  catch { console.warn("Firebase not configured — solo/offline only."); return null; }
}
async function fbSet(path, value) {
  const db = await getDB(); if (!db) return;
  const { ref, set } = await import("firebase/database");
  await set(ref(db, path), value);
}
async function fbUpdate(path, partial) {
  const db = await getDB(); if (!db) return;
  const { ref, update } = await import("firebase/database");
  await update(ref(db, path), partial);
}
async function fbListen(path, cb) {
  const db = await getDB(); if (!db) return () => {};
  const { ref, onValue, off } = await import("firebase/database");
  const r = ref(db, path);
  onValue(r, snap => cb(snap.exists() ? snap.val() : null));
  return () => off(r);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio
// ─────────────────────────────────────────────────────────────────────────────
function playBeep({ freq = 880, duration = 0.18, type = "sine", gain = 0.35 } = {}) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), env = ctx.createGain();
    osc.connect(env); env.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    env.gain.setValueAtTime(gain, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(); osc.stop(ctx.currentTime + duration);
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const PREP_SEC  = 30;
const SPEAK_SEC = 180;
const OA_KEY    = import.meta.env.VITE_OPENAI_API_KEY;

const AI_SYSTEM = `You are a strict German language examiner for B2 Beruf oral exams.

You receive TWO inputs:
1. TASK — the question/prompt the candidate was given
2. RESPONSE — what the candidate actually said

Your job is to evaluate BOTH dimensions equally:

━━━ DIMENSION 1: RELEVANCE (50% of score) ━━━
- Does the response DIRECTLY address the task?
- Does it stay on topic throughout?
- Does it answer what was actually asked?
- If the response is off-topic, tangential, or ignores the task → score MUST be 2, regardless of grammar.
- Flag off-topic responses explicitly in feedback.

━━━ DIMENSION 2: LANGUAGE (50% of score) ━━━
- Grammar correctness (B2 level structures)
- Vocabulary range and appropriateness
- Fluency and coherence

━━━ SCORING RULES ━━━
5 = On-topic AND fluent, minor or no errors
4 = On-topic AND good, some noticeable errors
3 = Partially on-topic OR understandable but many errors
2 = Off-topic OR very poor language (even if grammatically correct sentences appear)
NOTE: A grammatically perfect but off-topic answer MUST score 2.

Return ONLY a valid JSON object — no markdown, no prose, no explanation outside JSON.

Schema:
{
  "score": <int 2-5>,
  "isOffTopic": <boolean — true if response does not address the task>,
  "correctedText": "<full corrected version of what they said, keeping their meaning>",
  "feedback": "<2-3 sentences in German — mention relevance first, then language quality>",
  "errors": [
    {
      "original": "<wrong phrase>",
      "correction": "<correct phrase>",
      "explanation": "<brief explanation in German>"
    }
  ]
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function pickRandom(questions = [], usedIds = []) {
  const pool = questions.filter(q => !usedIds.includes(q.id));
  const src  = pool.length ? pool : questions;
  if (!src.length) return null;
  return src[Math.floor(Math.random() * src.length)];
}

function escHtml(s = "") {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function buildHighlightedHTML(text = "", errors = []) {
  if (!text || !errors.length) return escHtml(text);
  let out = escHtml(text);
  errors.forEach(({ original }) => {
    if (!original) return;
    const esc = escHtml(original).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    out = out.replace(new RegExp(`(${esc})`, "gi"), `<span class="err-hl">$1</span>`);
  });
  return out;
}

// Android / Samsung dedup (v5)
function lev(a, b, cap = 40) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const v = a[i-1]===b[j-1] ? row[j-1] : 1+Math.min(row[j-1],row[j],prev);
      row[j-1]=prev; prev=v;
    }
    row[b.length]=prev;
  }
  return row[b.length];
}
function sanitize(existing, chunk) {
  const t=chunk.trim(); if(!t) return "";
  if(!existing) return t;
  const nE=existing.toLowerCase().replace(/\s+/g," ").trim();
  const nC=t.toLowerCase().replace(/\s+/g," ").trim();
  if(nE.includes(nC)) return "";
  const words=nE.split(" ");
  for(let len=Math.min(12,words.length);len>=2;len--){
    const suf=words.slice(-len).join(" ");
    if(nC.startsWith(suf)){
      const stripped=t.slice(suf.length).trimStart();
      if(!stripped||nE.includes(stripped.toLowerCase())) return "";
      return stripped;
    }
  }
  const win=nE.slice(-Math.min(nC.length*2,nE.length));
  const d=lev(nC,win,Math.ceil(nC.length*0.5));
  if(1-d/Math.max(nC.length,win.length,1)>0.85) return "";
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAI(transcript, question) {
  if (!OA_KEY || !transcript?.trim()) return null;
  const userContent = question
    ? `TASK:\n${question}\n\nRESPONSE:\n${transcript.trim()}`
    : `RESPONSE:\n${transcript.trim()}`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{"Content-Type":"application/json", Authorization:`Bearer ${OA_KEY}`},
    body:JSON.stringify({
      model:"gpt-4o-mini", max_tokens:900, temperature:0.25,
      messages:[{role:"system",content:AI_SYSTEM},{role:"user",content:userContent}],
    }),
  });

// ─────────────────────────────────────────────────────────────────────────────
// Speech Recognition Hook
// ─────────────────────────────────────────────────────────────────────────────
function useSpeechRecognition({ onFinal, onInterim, active }) {
  const recogRef    = useRef(null);
  const activeRef   = useRef(active);
  const debounceRef = useRef(null);
  useEffect(() => { activeRef.current = active; }, [active]);

  const start = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    try { recogRef.current?.stop(); } catch { /* ignore */ }
    const r = new SR();
    r.continuous=true; r.interimResults=true; r.lang="de-DE"; r.maxAlternatives=1;
    r.onresult = e => {
      let interim="", finals="";
      for (let i=e.resultIndex; i<e.results.length; i++) {
        const t=e.results[i][0].transcript;
        if (e.results[i].isFinal) finals+=t+" "; else interim+=t;
      }
      if (interim) { clearTimeout(debounceRef.current); debounceRef.current=setTimeout(()=>onInterim?.(interim),80); }
      if (finals)  { clearTimeout(debounceRef.current); onFinal?.(finals.trimEnd()); }
    };
    r.onerror = e => { if(e.error!=="no-speech"&&e.error!=="aborted") console.warn("SR:",e.error); };
    r.onend   = () => { if(activeRef.current) try{r.start()}catch{/***/} };
    recogRef.current = r;
    try { r.start(); } catch { /* permission denied */ }
  }, [onFinal, onInterim]);

  const stop = useCallback(() => {
    activeRef.current=false;
    clearTimeout(debounceRef.current);
    try { recogRef.current?.stop(); } catch { /* ignore */ }
    recogRef.current=null;
  }, []);

  return { start, stop };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timer display hook
// ─────────────────────────────────────────────────────────────────────────────
function useTimerDisplay(timerEndsAt, totalSec) {
  const [tl, setTl] = useState(totalSec);
  useEffect(() => {
    if (!timerEndsAt) { setTl(totalSec); return; }
    const tick = () => setTl(Math.max(0,Math.round((timerEndsAt-Date.now())/1000)));
    tick(); const id=setInterval(tick,400); return ()=>clearInterval(id);
  }, [timerEndsAt, totalSec]);
  return tl;
}

// ─────────────────────────────────────────────────────────────────────────────
// CircularTimer
// ─────────────────────────────────────────────────────────────────────────────
function CircularTimer({ timeLeft, totalTime, phase }) {
  const R=52, C=2*Math.PI*R;
  const offset = C*(1-timeLeft/totalTime);
  const urgent = timeLeft<=10, warn=timeLeft<=30;
  const color  = urgent?"#ef4444":warn?"#f59e0b":"#22d3ee";
  const glow   = urgent?"rgba(239,68,68,.4)":warn?"rgba(245,158,11,.3)":"rgba(34,211,238,.22)";
  const mm=String(Math.floor(timeLeft/60)).padStart(2,"0");
  const ss=String(timeLeft%60).padStart(2,"0");
  return (
    <div className={`tmr-wrap${urgent?" tmr-urgent":""}`}>
      <svg viewBox="0 0 120 120" width="120" height="120" style={{overflow:"visible"}}>
        <defs>
          <radialGradient id="tBg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#17203a"/><stop offset="100%" stopColor="#0a0e1a"/>
          </radialGradient>
        </defs>
        <circle cx="60" cy="60" r="58" fill="url(#tBg)"/>
        <circle cx="60" cy="60" r="55" fill="none" stroke="rgba(255,255,255,.04)" strokeWidth="1"/>
        <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(255,255,255,.05)" strokeWidth="8"/>
        <circle cx="60" cy="60" r={R} fill="none" stroke={glow} strokeWidth="10"
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={offset}
          transform="rotate(-90 60 60)"
          style={{filter:"blur(4px)",transition:"stroke-dashoffset .4s linear,stroke .5s"}}/>
        <circle cx="60" cy="60" r={R} fill="none" stroke={color} strokeWidth="7"
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={offset}
          transform="rotate(-90 60 60)"
          style={{transition:"stroke-dashoffset .4s linear,stroke .5s"}}/>
        <text x="60" y="55" textAnchor="middle" dominantBaseline="middle"
          fill={urgent?"#ef4444":"#f1f5f9"} fontSize="20" fontWeight="700"
          fontFamily="'Outfit',sans-serif" style={{transition:"fill .4s"}}>
          {mm}:{ss}
        </text>
        <text x="60" y="73" textAnchor="middle" dominantBaseline="middle"
          fill="rgba(148,163,184,.45)" fontSize="7" fontFamily="'Space Grotesk',sans-serif"
          letterSpacing="1.8">
          {phase==="prep"?"PREP":"SPRECHEN"}
        </text>
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LiveTranscriptPanel — streams to BOTH users via Firebase
// ─────────────────────────────────────────────────────────────────────────────
function LiveTranscriptPanel({ speakerName, text="", interim="", isMine }) {
  const bottomRef = useRef(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({behavior:"smooth"}); }, [text,interim]);
  return (
    <div className={`tp-panel${isMine?" tp-mine":" tp-partner"}`}>
      <div className="tp-head">
        <span className="tp-dot"/>
        <span className="tp-speaker">{speakerName}</span>
        <span className="tp-badge">{isMine?"Ich":"Partner"}</span>
      </div>
      <div className="tp-body">
        {!text&&!interim
          ? <span className="tp-ph">Warte auf Spracheingabe…</span>
          : <><span className="tp-final">{text}</span>{interim&&<span className="tp-interim"> {interim}</span>}</>
        }
        <div ref={bottomRef}/>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ResultCard — shown to BOTH users simultaneously (I-3)
// Original text with errors in RED, corrected version in GREEN below
// ─────────────────────────────────────────────────────────────────────────────
function ResultCard({ result, speakerName, roundNum, isLoading }) {
  if (isLoading) return (
    <div className="rc-card rc-loading">
      <svg width="36" height="36" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(34,211,238,.15)" strokeWidth="3"/>
        <circle cx="18" cy="18" r="14" fill="none" stroke="#22d3ee" strokeWidth="3"
          strokeLinecap="round" strokeDasharray="36 52"
          style={{animation:"cr-spin 1s linear infinite",transformOrigin:"center"}}/>
      </svg>
      <p className="rc-loading-txt">KI analysiert Runde {roundNum}…</p>
    </div>
  );
  if (!result) return null;
  const { score=0, correctedText, feedback, errors=[], transcript:origText } = result;
  const html = buildHighlightedHTML(origText, errors);
  return (
    <div className="rc-card" style={{animationDelay:"0ms"}}>
      {/* Header */}
     <div className="rc-head">
  <span className="rc-round-tag">Runde {roundNum}</span>
  {result.isOffTopic && (
    <span className="rc-offtopic-badge">⚠ Off-topic</span>
  )}
  <span className="rc-who">{speakerName}</span>
        <div className="rc-score-bar">
          {[1,2,3,4,5].map(b=>(
            <div key={b} className={`rc-bar-seg${b<=score?" rc-bar-on":""}`}
              style={{"--bh":`${b*5+6}px`}}/>
          ))}
          <span className="rc-score-val">{score}<span className="rc-score-of">/5</span></span>
        </div>
      </div>

      {/* ── Original with errors in RED ── */}
      {origText && (
        <div className="rc-sec">
          <div className="rc-label"><span className="rc-dot rc-dot-red"/>Original · Fehler markiert</div>
          <div className="rc-orig" dangerouslySetInnerHTML={{__html:html}}/>
        </div>
      )}

      {/* ── Corrected version in GREEN ── */}
      {correctedText && (
        <div className="rc-sec">
          <div className="rc-label"><span className="rc-dot rc-dot-green"/>Korrigierte Version</div>
          <div className="rc-corr">{correctedText}</div>
        </div>
      )}

      {/* ── Error table ── */}
      {errors.length>0 && (
        <div className="rc-sec">
          <div className="rc-label"><span className="rc-dot rc-dot-amber"/>Fehler ({errors.length})</div>
          <div className="rc-errs">
            {errors.map((e,i)=>(
              <div key={i} className="rc-err-row">
                <span className="rc-err-orig">{e.original}</span>
                <span className="rc-err-arr">→</span>
                <span className="rc-err-fix">{e.correction}</span>
                {e.explanation&&<span className="rc-err-exp">{e.explanation}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Feedback ── */}
      {feedback && (
        <div className="rc-sec rc-sec-last">
          <div className="rc-label"><span className="rc-dot rc-dot-cyan"/>Feedback</div>
          <p className="rc-feedback">{feedback}</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AnalyzingOverlay — both users see this simultaneously
// ─────────────────────────────────────────────────────────────────────────────
function AnalyzingOverlay({ speakerName }) {
  return (
    <div className="ol-wrap">
      <div className="ol-card">
        <div className="ol-ring">
          <svg width="68" height="68" viewBox="0 0 68 68">
            <circle cx="34" cy="34" r="28" fill="none" stroke="rgba(34,211,238,.1)" strokeWidth="4"/>
            <circle cx="34" cy="34" r="28" fill="none" stroke="#22d3ee" strokeWidth="4"
              strokeLinecap="round" strokeDasharray="52 124"
              style={{animation:"cr-spin 1.1s linear infinite",transformOrigin:"center"}}/>
          </svg>
          <span className="ol-emoji">🤖</span>
        </div>
        <h3 className="ol-title">KI-Analyse läuft…</h3>
        <p className="ol-sub">{speakerName}s Antwort wird ausgewertet.<br/>Einen Moment bitte.</p>
        <div className="ol-dots">
          {[0,.2,.4].map((d,i)=><span key={i} className="ol-dot" style={{animationDelay:`${d}s`}}/>)}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ExitModal
// ─────────────────────────────────────────────────────────────────────────────
function ExitModal({ onConfirm, onCancel }) {
  return (
    <div className="ol-wrap">
      <div className="modal-card">
        <div className="modal-icon">⚠️</div>
        <h3 className="modal-title">Übung beenden?</h3>
        <p className="modal-body">Dein Fortschritt wird nicht gespeichert.</p>
        <div className="modal-btns">
          <button className="modal-btn modal-btn-d" onClick={onConfirm}>Ja, beenden</button>
          <button className="modal-btn modal-btn-g" onClick={onCancel}>Weitermachen</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RedemittelPanel
// ─────────────────────────────────────────────────────────────────────────────
const DEF_RDMT = [
  "Ich möchte zunächst darauf hinweisen, dass …",
  "Meiner Meinung nach ist es wichtig, …",
  "Ein wesentlicher Aspekt dabei ist …",
  "Auf der anderen Seite muss man bedenken, …",
  "Zusammenfassend lässt sich sagen, dass …",
  "Ich stimme zu / nicht zu, weil …",
  "Das hat den Vorteil / Nachteil, dass …",
  "Was ich damit sagen möchte, ist …",
];
function RedemittelPanel({ items=[] }) {
  const [open,setOpen]=useState(false);
  const list=items.length?items:DEF_RDMT;
  return (
    <div className={`rdm${open?" rdm-open":""}`}>
      <button className="rdm-toggle" onClick={()=>setOpen(o=>!o)}>
        <span>{open?"▾":"▸"}</span><span>Redemittel</span>
        <span className="rdm-cnt">{list.length}</span>
      </button>
      {open&&<ul className="rdm-list">
        {list.map((item,i)=>(
          <li key={i} className="rdm-item"><span className="rdm-dot"/>{item}</li>
        ))}
      </ul>}
    </div>
  );
}

// Icon helpers
function MicOnIcon()  { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" fill="currentColor"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>; }
function MicOffIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6M17 16.95A7 7 0 015 12v-2m14 0v2M12 19v4M8 23h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>; }

// ─────────────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────
export default function ChallengeRoom({
  mode        = "solo",
  roomId      = null,
  currentUser,
  questions   : propQ = [],
  onExit,
  heroBgImage = "/hero-bg.jpg",
}) {
  const me     = currentUser || { uid:"demo", displayName:"Du" };
  const isSolo = mode==="solo";
  const isMulti= mode==="multi";

  // ── Control plane — I-1: setRs called ONLY from onValue in multi ──────────
  const [rs, setRs] = useState({
    status:"intro", currentSpeaker:me.uid, timerPhase:"prep",
    timerEndsAt:null, currentQuestionId:null, round:1,
    speakerOrder:[me.uid],
  });

  // ── Data plane (separate listeners) ──────────────────────────────────────
  const [transcripts,  setTranscripts]  = useState({});   // {[uid]:{text,interim}}
  const [roundResults, setRoundResults] = useState({});   // {round1:obj, round2:obj}
  const [analyzingMap, setAnalyzingMap] = useState({});   // {[uid]:boolean}

  // ── Player info ───────────────────────────────────────────────────────────
  const [partnerUid,  setPartnerUid]  = useState(null);
  const [partnerName, setPartnerName] = useState("Partner");
  const [fbReady,     setFbReady]     = useState(!isMulti);

  // ── Local UI ──────────────────────────────────────────────────────────────
  const [isRecording,     setIsRecording]     = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [phaseAnim,       setPhaseAnim]       = useState("in");
  const [soloUsedIds,     setSoloUsedIds]     = useState([]);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const transcriptRef   = useRef("");
  const rsRef           = useRef(rs);
  const partnerUidRef   = useRef(null);
  const masterTimerRef  = useRef(null);
  const masterEndsAtRef = useRef(null); // I-4

  useEffect(()=>{ rsRef.current=rs; },[rs]);
  useEffect(()=>{ partnerUidRef.current=partnerUid; },[partnerUid]);
  useEffect(()=>()=>clearInterval(masterTimerRef.current),[]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const status    = rs.status;
  const amSpeaker = rs.currentSpeaker===me.uid;                      // I-5
  const totalSec  = rs.timerPhase==="prep"?PREP_SEC:SPEAK_SEC;
  const currentQ  = propQ.find(q=>q.id===rs.currentQuestionId)||null;
  const roundKey  = `round${rs.round}`;

  const anyAnalyzing      = Object.values(analyzingMap).some(Boolean);
  const speakerTx         = transcripts[rs.currentSpeaker]||{text:"",interim:""};
  const myTx              = transcripts[me.uid]||{text:"",interim:""};
  const partnerTx         = transcripts[partnerUid||""]||{text:"",interim:""};
  const currentRoundResult= roundResults[roundKey]||null;
  const round1Result      = roundResults["round1"]||null;
  const round2Result      = roundResults["round2"]||null;
  const speakerDisplayName= rs.currentSpeaker===me.uid ? me.displayName : partnerName;
  const isSpeakerAnalyzing= !!analyzingMap[rs.currentSpeaker];

  const timeLeft = useTimerDisplay(rs.timerEndsAt, totalSec);

  // ─────────────────────────────────────────────────────────────────────────
  // Firebase listeners — I-1, I-7
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if (!isMulti||!roomId) return;
    const cls=[];
    (async()=>{
      // Players
      cls.push(await fbListen(`rooms/${roomId}/players`, players=>{
        if (!players) return;
        const amA = players.A?.uid===me.uid;
        const p   = amA?players.B:players.A;
        if (p?.displayName) setPartnerName(p.displayName);
        if (p?.uid)         setPartnerUid(p.uid);
      }));

      // roomState — I-1: ONLY place setRs is called in multi
      cls.push(await fbListen(`rooms/${roomId}/roomState`, data=>{
        setFbReady(true);
        if (!data) return;
        setRs(prev=>({...prev,...data}));
        // I-4: restart countdown only when timerEndsAt truly changes
        if (data.currentSpeaker===me.uid && data.timerEndsAt && data.timerEndsAt!==masterEndsAtRef.current) {
          masterEndsAtRef.current=data.timerEndsAt;
          _startCountdown(data.timerEndsAt, data.timerPhase, data.currentQuestionId);
        } else if (data.currentSpeaker!==me.uid) {
          clearInterval(masterTimerRef.current);
          masterEndsAtRef.current=null;
        }
      }));

      // I-2: Transcript at separate path — single subtree listener
      cls.push(await fbListen(`rooms/${roomId}/transcript`, data=>{
        if (!data) return;
        setTranscripts(prev=>({...prev,...data}));
        // I-7: keep transcriptRef synced on refresh
        if (data[me.uid]?.text!==undefined) transcriptRef.current=data[me.uid].text||"";
      }));

      // I-3: Results — both clients listen; UI appears on data arrival
      cls.push(await fbListen(`rooms/${roomId}/results`, data=>{
        if (data) setRoundResults(data);
      }));

      // I-8: Analyzing flags
      cls.push(await fbListen(`rooms/${roomId}/analyzing`, data=>{
        setAnalyzingMap(data||{});
      }));
    })();
    return ()=>cls.forEach(fn=>fn?.());
  },[isMulti,roomId]);

  // ─────────────────────────────────────────────────────────────────────────
  // pushRS — I-1: never calls setRs in multi
  // ─────────────────────────────────────────────────────────────────────────
  const pushRS = useCallback(async partial=>{
    if (isMulti&&roomId) {
      await fbUpdate(`rooms/${roomId}/roomState`, partial);
      // setRs follows via onValue — do NOT call it here
    } else {
      setRs(prev=>({...prev,...partial}));
    }
  },[isMulti,roomId]);

  // ─────────────────────────────────────────────────────────────────────────
  // Transcript write — I-2: always separate path
  // ─────────────────────────────────────────────────────────────────────────
  const writeTx = useCallback(async(field,value)=>{
    if (isMulti&&roomId) {
      await fbSet(`rooms/${roomId}/transcript/${me.uid}/${field}`, value);
    } else {
      setTranscripts(prev=>({...prev,[me.uid]:{...(prev[me.uid]||{}),[field]:value}}));
      if (field==="text") transcriptRef.current=value;
    }
  },[isMulti,roomId,me.uid]);

  // ─────────────────────────────────────────────────────────────────────────
  // Master countdown — I-4 guard
  // ─────────────────────────────────────────────────────────────────────────
  function _startCountdown(endsAt, phase, questionId) {
    clearInterval(masterTimerRef.current);
    masterTimerRef.current=setInterval(()=>{
      const left=Math.max(0,Math.round((endsAt-Date.now())/1000));
      if (left<=0) {
        clearInterval(masterTimerRef.current);
        masterEndsAtRef.current=null;
        if (phase==="prep") {
          const q=propQ.find(q=>q.id===(questionId||rsRef.current.currentQuestionId));
          _doBeginSpeaking(q);
        } else {
          handleSpeakEnd();
        }
      }
    },400);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Speech handlers
  // ─────────────────────────────────────────────────────────────────────────
  const handleFinal = useCallback(raw=>{
    const clean=sanitize(transcriptRef.current,raw);
    if (!clean) return;
    const updated=(transcriptRef.current+(transcriptRef.current?" ":"")+clean).replace(/\s{2,}/g," ").trim();
    transcriptRef.current=updated;
    writeTx("text",updated);
    writeTx("interim","");
  },[writeTx]);

  const handleInterim = useCallback(text=>{ writeTx("interim",text); },[writeTx]);

  // I-6: mic active only when correct conditions
  const micActive = status==="speaking" && amSpeaker && isRecording;

  const {start:startRecog,stop:stopRecog} = useSpeechRecognition({
    onFinal:handleFinal, onInterim:handleInterim, active:micActive,
  });
  useEffect(()=>{
    if (micActive) startRecog(); else stopRecog();
    return ()=>stopRecog();
  },[micActive]);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase animation
  // ─────────────────────────────────────────────────────────────────────────
  function anim(cb) {
    setPhaseAnim("out");
    setTimeout(()=>{ cb?.(); setPhaseAnim("in"); },200);
  }
  function handleExitRequest() {
    if (anyAnalyzing) return;
    if (status==="intro"||status==="finished") { onExit?.(); return; }
    setShowExitConfirm(true);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Game flow
  // ─────────────────────────────────────────────────────────────────────────

  async function beginPrep(speakerUid, roundNum) {
    if (isMulti && rsRef.current.currentSpeaker!==me.uid) return;
    transcriptRef.current="";

    // Clear transcripts for fresh round
    if (isMulti&&roomId) {
      await fbSet(`rooms/${roomId}/transcript/${me.uid}`,{text:"",interim:"",updatedAt:Date.now()});
      const pUid=partnerUidRef.current;
      if (pUid) await fbSet(`rooms/${roomId}/transcript/${pUid}`,{text:"",interim:"",updatedAt:Date.now()});
    } else { setTranscripts({}); }

    const usedIds=isSolo?soloUsedIds:[];
    const q=pickRandom(propQ,usedIds);
    if (!q) { console.warn("No questions"); return; }
    if (isSolo) setSoloUsedIds(p=>[...p,q.id]);

    const endsAt=Date.now()+PREP_SEC*1000;
    await pushRS({
      status:"prep", currentSpeaker:speakerUid||me.uid,
      timerPhase:"prep", timerEndsAt:endsAt,
      currentQuestionId:q.id, round:roundNum||1,
    });
    if (isSolo) { masterEndsAtRef.current=endsAt; _startCountdown(endsAt,"prep",q.id); }
    anim();
  }

  async function _doBeginSpeaking() {
    if (isMulti && rsRef.current.currentSpeaker!==me.uid) return;
    clearInterval(masterTimerRef.current);
    setIsRecording(true);
    playBeep({freq:660,gain:.4});
    const endsAt=Date.now()+SPEAK_SEC*1000;
    await pushRS({status:"speaking",timerPhase:"speak",timerEndsAt:endsAt});
    if (isSolo) { masterEndsAtRef.current=endsAt; _startCountdown(endsAt,"speak",null); }
    anim();
  }

  async function handleSkipPrep() {
    if (!amSpeaker) return;
    clearInterval(masterTimerRef.current); masterEndsAtRef.current=null;
    await _doBeginSpeaking();
  }

  /** End Turn button + timer expiry */
  async function handleSpeakEnd() {
    if (isMulti && rsRef.current.currentSpeaker!==me.uid) return;
    clearInterval(masterTimerRef.current); masterEndsAtRef.current=null;
    setIsRecording(false); stopRecog();
    playBeep({freq:440,gain:.3});

    const finalText=transcriptRef.current;
    const curRound=rsRef.current.round;
    const curRKey=`round${curRound}`;

    // I-8: scalar boolean flag
    const flagPath=isMulti&&roomId?`rooms/${roomId}/analyzing/${me.uid}`:null;
    if (flagPath) await fbSet(flagPath,true);
    else setAnalyzingMap(p=>({...p,[me.uid]:true}));

    await pushRS({status:"analyzing",timerEndsAt:null});
    anim();

    try {
	const result=await fetchAI(finalText, currentQ?.question);   
   if (result) {
        const payload={...result,transcript:finalText,speakerUid:me.uid};
        // I-3: write to results/round{N} — both clients' listeners pick it up
        if (isMulti&&roomId) await fbSet(`rooms/${roomId}/results/${curRKey}`,payload);
        else setRoundResults(p=>({...p,[curRKey]:payload}));
        // Status → results; both clients show ResultCard simultaneously
        await pushRS({status:"results"});
        anim();
      }
    } catch(err) {
      console.error("AI error:",err);
      await pushRS({status:"results"});
      anim();
    } finally {
      if (flagPath) await fbSet(flagPath,false);
      else setAnalyzingMap(p=>({...p,[me.uid]:false}));
    }
  }

  /** Next Round — called by current speaker, switches to partner */
  async function handleNextRound() {
    if (!amSpeaker) return;
    const order=rsRef.current.speakerOrder||[me.uid,partnerUidRef.current||me.uid];
    const nextSpeaker=order[rsRef.current.round%order.length]||partnerUidRef.current||me.uid;
    await pushRS({status:"switching",round:rsRef.current.round+1,currentSpeaker:nextSpeaker,timerEndsAt:null});
    anim();
  }

  /** I-5: only confirmed new speaker can start their round */
  async function handleStartMyRound() {
    if (!amSpeaker) return;
    await beginPrep(me.uid, rsRef.current.round);
  }

  async function handleFinish() {
    await pushRS({status:"finished"});
    anim();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <link rel="preconnect" href="https://fonts.googleapis.com"/>
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"/>

      <div className="cr-root">
        <div className="cr-grid" aria-hidden/>
        <div className="cr-amb1" aria-hidden/>
        <div className="cr-amb2" aria-hidden/>

        {anyAnalyzing && <AnalyzingOverlay speakerName={speakerDisplayName}/>}
        {showExitConfirm && !anyAnalyzing && (
          <ExitModal
            onConfirm={()=>{setShowExitConfirm(false);onExit?.();}}
            onCancel={()=>setShowExitConfirm(false)}
          />
        )}

        {/* ── HEADER ── */}
        <header className="cr-hdr">
          <div className="cr-logo">
            <div className="cr-logo-mark">B2</div>
            <div><span className="cr-logo-t">Beruf</span><span className="cr-logo-s">Sprachtraining</span></div>
          </div>
          <div className="cr-hdr-c">
            {status!=="intro"&&(
              <div className="cr-prog">
                {[1,2].map(r=>(
                  <div key={r} className={`cr-pseg${rs.round>=r?" cr-pa":""}${roundResults[`round${r}`]?" cr-pd":""}`}>
                    {r}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="cr-hdr-r">
            {isMulti&&<div className="cr-partner-chip"><span className="cr-pdot"/>{partnerName}</div>}
            {isRecording&&amSpeaker&&<div className="cr-rec-chip"><span className="cr-rdot"/>REC</div>}
            <button className={`cr-x${anyAnalyzing?" cr-x-locked":""}`}
              onClick={handleExitRequest} disabled={anyAnalyzing} aria-label="Beenden">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </header>

        {/* ── MAIN ── */}
        <main className={`cr-main cr-a-${phaseAnim}`}>

          {/* ══ INTRO ══════════════════════════════════════════════════════ */}
          {status==="intro"&&(
            <div className="intro-wrap">
              <div className="intro-img-side">
                <img src={heroBgImage} alt="" className="intro-img"/>
                <div className="intro-img-ov"/>
              </div>
              <div className="intro-content">
                <div className="intro-ey"><span className="intro-ey-dot"/>Deutschprüfung · B2 · Mündlich</div>
                <h1 className="intro-h">Meistere das<br/><span className="intro-acc">Sprechen</span></h1>
                <p className="intro-d">
                  {isSolo?"Solo-Modus · 30 s Vorbereitung · 3 min Sprechen · KI-Feedback"
                    :`Duell mit ${partnerName} · 2 Runden · Live-Transkript · KI-Feedback`}
                </p>
                <div className="intro-meta">
                  {[["⏱","30 s Prep"],["🎙","3 min"],["🤖","KI-Score"],["📋","Redemittel"]].map(([ic,lb])=>(
                    <div key={lb} className="intro-meta-item"><span>{ic}</span><span>{lb}</span></div>
                  ))}
                </div>
                {(!isMulti||fbReady)
                  ? <button className="btn-p" onClick={()=>beginPrep(me.uid,1)}>
                      Jetzt starten
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  : <p className="intro-conn">Verbinde mit Raum…</p>
                }
              </div>
            </div>
          )}

          {/* ══ PREP ════════════════════════════════════════════════════════ */}
          {status==="prep"&&currentQ&&(
            <div className="game-lay">
              <div className="game-l">
                <CircularTimer timeLeft={timeLeft} totalTime={PREP_SEC} phase="prep"/>
                <div className="ph-badge ph-prep">Vorbereitung</div>
                {amSpeaker&&<button className="btn-skip" onClick={handleSkipPrep}>Jetzt sprechen →</button>}
                {isMulti&&<div className={`role-chip${amSpeaker?" role-spk":" role-lst"}`}>
                  {amSpeaker?"🎙 Sprecher":"👂 Zuhörer"}
                </div>}
              </div>
              <div className="game-r">
                <div className="q-card">
                  <div className="q-num">Aufgabe · Runde {rs.round}</div>
                  {currentQ.topic&&<div className="q-topic">{currentQ.topic}</div>}
                  <p className="q-text">{currentQ.question}</p>
                </div>
                {currentQ.redemittel?.length>0&&<RedemittelPanel items={currentQ.redemittel}/>}
              </div>
            </div>
          )}

          {/* ══ SPEAKING ════════════════════════════════════════════════════ */}
          {status==="speaking"&&currentQ&&(
            <div className="game-lay">
              <div className="game-l">
                <CircularTimer timeLeft={timeLeft} totalTime={SPEAK_SEC} phase="speak"/>
                <div className="ph-badge ph-spk">Sprechen</div>

                {/* Mic toggle — speaker only (I-6) */}
                {amSpeaker&&(
                  <button className={`btn-mic${isRecording?" btn-mic-on":""}`}
                    onClick={()=>setIsRecording(r=>!r)}>
                    {isRecording?<><MicOnIcon/>Aktiv</>:<><MicOffIcon/>Stumm</>}
                  </button>
                )}

                {/* I-6: listener sees locked mic with no pointer events */}
                {!amSpeaker&&isMulti&&(
                  <div className="waiting-banner">
                    <span className="wait-dot"/>
                    <span>{speakerDisplayName} spricht…</span>
                    <span className="wait-lock">🔒 Mikrofon gesperrt</span>
                  </div>
                )}

                {/* End Turn — speaker only */}
                {amSpeaker&&(
                  <button className="btn-danger" onClick={handleSpeakEnd}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="4" y="4" width="16" height="16" rx="2"/>
                    </svg>
                    Runde beenden
                  </button>
                )}
              </div>
              <div className="game-r">
                <div className="q-card q-card-sm">
                  {currentQ.topic&&<div className="q-topic">{currentQ.topic}</div>}
                  <p className="q-text">{currentQ.question}</p>
                </div>
                {currentQ.redemittel?.length>0&&<RedemittelPanel items={currentQ.redemittel}/>}

                {/* Live transcript — BOTH users see this stream in real time */}
                <LiveTranscriptPanel
                  speakerName={speakerDisplayName}
                  text={speakerTx.text}
                  interim={speakerTx.interim}
                  isMine={amSpeaker}
                />
              </div>
            </div>
          )}

          {/* ══ ANALYZING ══════════════════════════════════════════════════ */}
          {status==="analyzing"&&(
            <div className="center-stage">
              <div className="center-card">
                <svg width="52" height="52" viewBox="0 0 52 52" style={{marginBottom:12}}>
                  <circle cx="26" cy="26" r="22" fill="none" stroke="rgba(34,211,238,.1)" strokeWidth="4"/>
                  <circle cx="26" cy="26" r="22" fill="none" stroke="#22d3ee" strokeWidth="4"
                    strokeLinecap="round" strokeDasharray="42 96"
                    style={{animation:"cr-spin 1.1s linear infinite",transformOrigin:"center"}}/>
                </svg>
                <h2 className="cc-title">Analysiere…</h2>
                <p className="cc-sub">KI wertet Runde {rs.round} aus</p>
              </div>
            </div>
          )}

          {/* ══ RESULTS — displayed simultaneously on BOTH clients (I-3) ══ */}
          {status==="results"&&(
            <div className="res-lay">
              <div className="res-hdr">
                <h2 className="res-title">Ergebnis · Runde {rs.round}</h2>
                {isMulti&&(
                  <div className="res-sync">
                    <span className="res-sync-dot"/>
                    Beide Nutzer sehen dies gleichzeitig
                  </div>
                )}
              </div>

              {/* ResultCard with red-highlighted errors + green corrected text */}
              <ResultCard
                result={currentRoundResult}
                speakerName={speakerDisplayName}
                roundNum={rs.round}
                isLoading={!currentRoundResult&&isSpeakerAnalyzing}
              />

              <div className="res-actions">
                {/* Round 1 → Next Round */}
                {rs.round===1&&(
                  amSpeaker||isSolo
                    ? <button className="btn-p" onClick={handleNextRound}>Nächste Runde →</button>
                    : <p className="wait-txt"><span className="wait-dot"/>Warte auf {speakerDisplayName}…</p>
                )}
                {/* Round 2 → Finish */}
                {rs.round>=2&&(
                  amSpeaker||isSolo
                    ? <button className="btn-p" onClick={handleFinish}>Abschlussergebnis →</button>
                    : <p className="wait-txt"><span className="wait-dot"/>Warte auf {speakerDisplayName}…</p>
                )}
              </div>
            </div>
          )}

          {/* ══ SWITCHING ══════════════════════════════════════════════════ */}
          {status==="switching"&&(
            <div className="center-stage">
              <div className="sw-card">
                <div className="sw-icon">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                    <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"
                      stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <h2 className="sw-title">Rollenwechsel</h2>
                <p className="sw-sub">
                  Runde {rs.round} beginnt. Sprecher:&nbsp;
                  <strong className="sw-name">{amSpeaker?"Du":partnerName}</strong>
                </p>
                {/* I-5: only confirmed new speaker sees this button */}
                {amSpeaker
                  ? <button className="btn-p" onClick={handleStartMyRound}>Runde {rs.round} starten →</button>
                  : <p className="wait-txt"><span className="wait-dot"/>Warte auf {partnerName}…</p>
                }
              </div>
            </div>
          )}

          {/* ══ FINISHED ═══════════════════════════════════════════════════ */}
          {status==="finished"&&(
            <div className="fin-lay">
              <div className="fin-hero">
                <div className="fin-trophy">🏆</div>
                <h1 className="fin-title">Geschafft!</h1>
                <p className="fin-sub">Hervorragende Arbeit!</p>
              </div>

              {/* Score summary */}
              <div className="fin-scores">
                {[round1Result,round2Result].map((r,i)=>r&&(
                  <div key={i} className="ssc">
                    <div className="ssc-rnd">Runde {i+1}</div>
                    <div className="ssc-s">{r.score}<span>/5</span></div>
                    <div className="ssc-bars">
                      {[1,2,3,4,5].map(b=>(
                        <div key={b} className={`ssc-b${b<=r.score?" ssc-b-on":""}`}
                          style={{"--bh":`${b*5+4}px`}}/>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Full result cards */}
              <div className="fin-results">
                {round1Result&&(
                  <ResultCard result={round1Result} roundNum={1}
                    speakerName={rs.speakerOrder?.[0]===me.uid?me.displayName:partnerName}
                    isLoading={false}/>
                )}
                {round2Result&&(
                  <ResultCard result={round2Result} roundNum={2}
                    speakerName={rs.speakerOrder?.[1]===me.uid?me.displayName:partnerName}
                    isLoading={false}/>
                )}
              </div>

              <button className="btn-p" style={{marginTop:8}} onClick={()=>onExit?.()}>
                Beenden
              </button>
            </div>
          )}

        </main>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700;800&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

.cr-root{
  --bg:#080c14;--sf:#0e1524;--sf2:#121d30;--sf3:#172238;
  --b:rgba(255,255,255,.06);--b2:rgba(255,255,255,.11);--b3:rgba(34,211,238,.22);
  --tx:#e2e8f0;--mu:#64748b;--dm:#334155;
  --cy:#22d3ee;--cy2:rgba(34,211,238,.12);
  --re:#f87171;--re2:rgba(248,113,113,.13);
  --gr:#4ade80;--gr2:rgba(74,222,128,.12);
  --am:#fbbf24;--am2:rgba(251,191,36,.12);
  --fd:'Outfit',sans-serif;--fb:'Space Grotesk',sans-serif;
  --r:16px;--rs:10px;
  background:var(--bg);color:var(--tx);font-family:var(--fb);
  min-height:100vh;position:relative;overflow-x:hidden;
  display:flex;flex-direction:column;
}

/* Ambient */
.cr-grid{position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:linear-gradient(rgba(34,211,238,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(34,211,238,.022) 1px,transparent 1px);
  background-size:56px 56px;}
.cr-amb1{position:fixed;width:560px;height:560px;border-radius:50%;top:-180px;left:-120px;pointer-events:none;z-index:0;
  background:radial-gradient(circle,rgba(34,211,238,.05) 0%,transparent 65%);}
.cr-amb2{position:fixed;width:480px;height:480px;border-radius:50%;bottom:-120px;right:-80px;pointer-events:none;z-index:0;
  background:radial-gradient(circle,rgba(99,102,241,.05) 0%,transparent 65%);}

/* Keyframes */
@keyframes cr-spin  {to{transform:rotate(360deg)}}
@keyframes cr-fadeup{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes cr-glow  {0%,100%{opacity:.6}50%{opacity:1}}
@keyframes cr-bounce{0%,80%,100%{transform:scale(0);opacity:0}40%{transform:scale(1);opacity:1}}
@keyframes cr-blink {0%,100%{opacity:1}50%{opacity:.2}}
@keyframes cr-pulse {0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
@keyframes cr-slide {from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}

/* Header */
.cr-hdr{display:flex;align-items:center;gap:14px;padding:14px 26px;
  border-bottom:1px solid var(--b);background:rgba(8,12,20,.92);
  backdrop-filter:blur(20px);position:sticky;top:0;z-index:100;flex-shrink:0;}
.cr-logo{display:flex;align-items:center;gap:10px;}
.cr-logo-mark{width:36px;height:36px;border-radius:9px;
  background:linear-gradient(135deg,#22d3ee,#6366f1);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--fd);font-weight:800;font-size:13px;color:#fff;
  box-shadow:0 0 14px rgba(34,211,238,.3);}
.cr-logo-t{font-family:var(--fd);font-weight:700;font-size:15px;color:#fff;display:block;line-height:1.1}
.cr-logo-s{font-size:9.5px;color:var(--mu);letter-spacing:1px;text-transform:uppercase;display:block}
.cr-hdr-c{flex:1;display:flex;justify-content:center;}
.cr-hdr-r{display:flex;align-items:center;gap:9px;}
.cr-prog{display:flex;align-items:center;gap:5px;}
.cr-pseg{width:30px;height:30px;border-radius:50%;border:1.5px solid var(--b2);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-size:12px;font-weight:700;color:var(--mu);transition:all .3s;}
.cr-pa{border-color:var(--cy);color:var(--cy);background:var(--cy2);}
.cr-pd{border-color:var(--gr);background:var(--gr2);color:var(--gr);}
.cr-partner-chip{display:flex;align-items:center;gap:6px;background:var(--sf2);border:1px solid var(--b2);padding:4px 11px;border-radius:100px;font-size:12px;color:var(--mu);}
.cr-pdot{width:6px;height:6px;border-radius:50%;background:var(--gr);box-shadow:0 0 6px var(--gr);}
.cr-rec-chip{display:flex;align-items:center;gap:5px;background:var(--re2);border:1px solid rgba(248,113,113,.3);padding:4px 10px;border-radius:100px;font-family:var(--fd);font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--re);}
.cr-rdot{width:5px;height:5px;border-radius:50%;background:var(--re);animation:cr-blink 1s ease-in-out infinite;}
.cr-x{width:32px;height:32px;border-radius:50%;background:var(--sf2);border:1px solid var(--b2);color:var(--mu);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;}
.cr-x:hover:not(:disabled){background:var(--sf3);color:var(--tx);border-color:rgba(255,255,255,.2);}
.cr-x-locked{opacity:.3;cursor:not-allowed;pointer-events:none;}

/* Main */
.cr-main{flex:1;position:relative;z-index:1;}
.cr-a-in {animation:cr-slide .25s ease;}
.cr-a-out{opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;}

/* Overlays */
.ol-wrap{position:fixed;inset:0;z-index:900;background:rgba(4,7,14,.9);backdrop-filter:blur(22px);
  display:flex;align-items:center;justify-content:center;padding:24px;animation:cr-fadeup .28s ease;}
.ol-card{background:linear-gradient(145deg,#111827,#0a1020);border:1px solid var(--b3);border-radius:var(--r);
  padding:46px 38px;text-align:center;max-width:380px;width:100%;
  box-shadow:0 0 60px rgba(34,211,238,.07),0 40px 80px rgba(0,0,0,.65);
  display:flex;flex-direction:column;align-items:center;gap:14px;position:relative;overflow:hidden;}
.ol-card::before{content:'';position:absolute;top:0;left:5%;right:5%;height:1px;
  background:linear-gradient(90deg,transparent,rgba(34,211,238,.5),transparent);}
.ol-ring{position:relative;width:68px;height:68px;display:flex;align-items:center;justify-content:center;}
.ol-ring svg{position:absolute;inset:0;}
.ol-emoji{font-size:24px;position:relative;z-index:1;}
.ol-title{font-family:var(--fd);font-size:19px;font-weight:700;color:#fff;}
.ol-sub{font-size:13px;color:var(--mu);line-height:1.65;}
.ol-dots{display:flex;gap:6px;}
.ol-dot{width:7px;height:7px;border-radius:50%;background:var(--cy);animation:cr-bounce 1.2s ease-in-out infinite;}

.modal-card{background:linear-gradient(145deg,#111827,#0a1020);border:1px solid var(--b2);border-radius:var(--r);
  padding:38px 32px;text-align:center;max-width:350px;width:100%;animation:cr-fadeup .22s ease;}
.modal-icon{font-size:34px;margin-bottom:12px;}
.modal-title{font-family:var(--fd);font-size:19px;font-weight:700;color:#fff;margin-bottom:7px;}
.modal-body{font-size:13px;color:var(--mu);margin-bottom:22px;}
.modal-btns{display:flex;gap:10px;}
.modal-btn{flex:1;padding:11px;border-radius:var(--rs);font-family:var(--fd);font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;border:1px solid;}
.modal-btn-d{background:var(--re2);color:var(--re);border-color:rgba(248,113,113,.3);}
.modal-btn-d:hover{background:rgba(248,113,113,.22);}
.modal-btn-g{background:var(--sf2);color:var(--mu);border-color:var(--b2);}
.modal-btn-g:hover{background:var(--sf3);color:var(--tx);}

/* Intro */
.intro-wrap{display:grid;grid-template-columns:1fr 1fr;min-height:calc(100vh - 64px);}
@media(max-width:768px){.intro-wrap{grid-template-columns:1fr;}}
.intro-img-side{position:relative;overflow:hidden;}
.intro-img{width:100%;height:100%;object-fit:cover;display:block;}
.intro-img-ov{position:absolute;inset:0;background:linear-gradient(90deg,var(--bg) 0%,transparent 100%);}
@media(max-width:768px){.intro-img-side{height:180px;}.intro-img-ov{background:linear-gradient(to top,var(--bg) 0%,transparent 60%);}}
.intro-content{display:flex;flex-direction:column;justify-content:center;padding:56px 52px;animation:cr-fadeup .7s ease both;}
@media(max-width:768px){.intro-content{padding:32px 22px;}}
.intro-ey{display:flex;align-items:center;gap:8px;font-family:var(--fd);font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:var(--cy);margin-bottom:18px;}
.intro-ey-dot{width:5px;height:5px;border-radius:50%;background:var(--cy);box-shadow:0 0 7px var(--cy);animation:cr-glow 2s ease-in-out infinite;}
.intro-h{font-family:var(--fd);font-size:clamp(38px,5vw,62px);font-weight:800;line-height:1.05;letter-spacing:-1.5px;color:#fff;margin-bottom:16px;}
.intro-acc{background:linear-gradient(120deg,#22d3ee,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.intro-d{font-size:14px;color:var(--mu);margin-bottom:28px;line-height:1.65;}
.intro-meta{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:36px;}
.intro-meta-item{display:flex;align-items:center;gap:6px;font-size:11px;color:rgba(255,255,255,.4);background:var(--sf2);border:1px solid var(--b);padding:5px 11px;border-radius:100px;}
.intro-conn{color:var(--cy);font-size:13px;animation:cr-blink 1.5s ease-in-out infinite;}

/* Buttons */
.btn-p{display:inline-flex;align-items:center;gap:10px;
  background:linear-gradient(135deg,#0891b2,#6366f1);color:#fff;border:none;
  padding:13px 30px;border-radius:100px;font-family:var(--fd);font-size:14px;font-weight:700;cursor:pointer;
  box-shadow:0 0 0 1px rgba(255,255,255,.1) inset,0 8px 24px rgba(34,211,238,.22);
  transition:transform .15s,box-shadow .15s;}
.btn-p:hover{transform:translateY(-2px);box-shadow:0 0 0 1px rgba(255,255,255,.14) inset,0 12px 32px rgba(34,211,238,.32);}
.btn-p:active{transform:none;}
.btn-skip{background:none;border:1px solid var(--b2);color:var(--mu);font-family:var(--fb);font-size:11px;padding:7px 15px;border-radius:100px;cursor:pointer;transition:all .2s;}
.btn-skip:hover{background:var(--sf2);color:var(--tx);}
.btn-mic{display:inline-flex;align-items:center;gap:6px;background:var(--sf2);border:1px solid var(--b2);color:var(--mu);font-family:var(--fb);font-size:11px;padding:8px 16px;border-radius:100px;cursor:pointer;transition:all .2s;}
.btn-mic:hover{background:var(--sf3);color:var(--tx);}
.btn-mic-on{background:var(--re2);border-color:rgba(248,113,113,.3);color:var(--re);}
.btn-mic-on:hover{background:rgba(248,113,113,.22);}
.btn-danger{display:inline-flex;align-items:center;gap:6px;background:var(--re2);border:1px solid rgba(248,113,113,.3);color:var(--re);font-family:var(--fd);font-size:12px;font-weight:600;padding:9px 18px;border-radius:100px;cursor:pointer;transition:all .2s;}
.btn-danger:hover{background:rgba(248,113,113,.22);}

/* Game layout */
.game-lay{display:grid;grid-template-columns:180px 1fr;gap:28px;padding:32px 36px;max-width:1020px;margin:0 auto;width:100%;align-items:start;}
@media(max-width:740px){.game-lay{grid-template-columns:1fr;padding:18px 14px;gap:18px;}}
.game-l{display:flex;flex-direction:column;align-items:center;gap:12px;position:sticky;top:82px;}
.game-r{display:flex;flex-direction:column;gap:12px;}

/* Timer */
.tmr-wrap{filter:drop-shadow(0 0 16px rgba(34,211,238,.1));}
.tmr-urgent{animation:cr-pulse .72s ease-in-out infinite;}
.ph-badge{font-family:var(--fd);font-size:9.5px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:4px 13px;border-radius:100px;}
.ph-prep{background:var(--am2);color:var(--am);border:1px solid rgba(251,191,36,.22);}
.ph-spk{background:var(--cy2);color:var(--cy);border:1px solid var(--b3);}
.role-chip{display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;padding:4px 11px;border-radius:100px;border:1px solid;}
.role-spk{background:var(--cy2);color:var(--cy);border-color:var(--b3);}
.role-lst{background:var(--sf2);color:var(--mu);border-color:var(--b);}
.waiting-banner{display:flex;flex-direction:column;align-items:center;gap:5px;background:var(--sf2);border:1px solid var(--b);padding:10px 14px;border-radius:var(--rs);font-size:11px;color:var(--mu);text-align:center;}
.wait-dot{width:6px;height:6px;border-radius:50%;background:var(--am);box-shadow:0 0 6px var(--am);animation:cr-blink 1.2s ease-in-out infinite;display:block;}
.wait-lock{font-size:10px;color:var(--dm);}
.wait-txt{display:flex;align-items:center;gap:7px;color:var(--mu);font-size:13px;}

/* Question */
.q-card{background:var(--sf);border:1px solid var(--b2);border-radius:var(--r);padding:24px 28px;position:relative;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.03) inset,0 10px 28px rgba(0,0,0,.4);}
.q-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(34,211,238,.28),transparent);}
.q-card-sm{padding:16px 20px;}
.q-num{font-family:var(--fd);font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:var(--dm);margin-bottom:9px;}
.q-topic{font-family:var(--fd);font-size:9.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--cy);margin-bottom:9px;}
.q-text{font-family:var(--fb);font-size:16px;line-height:1.78;color:var(--tx);}

/* Redemittel */
.rdm{background:rgba(255,255,255,.02);border:1px solid var(--b);border-radius:var(--rs);overflow:hidden;transition:border-color .25s;}
.rdm-open{border-color:rgba(34,211,238,.18);}
.rdm-toggle{width:100%;background:none;border:none;color:var(--mu);font-family:var(--fd);font-size:10.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:12px 15px;display:flex;align-items:center;gap:7px;cursor:pointer;transition:color .2s;}
.rdm-toggle:hover{color:var(--tx);}
.rdm-cnt{margin-left:auto;background:var(--sf3);border:1px solid var(--b);color:var(--dm);font-size:9.5px;padding:2px 7px;border-radius:100px;}
.rdm-list{list-style:none;padding:5px 15px 12px;display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;border-top:1px solid var(--b);}
.rdm-item{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:rgba(255,255,255,.48);line-height:1.62;padding:3px 0;transition:color .15s;}
.rdm-item:hover{color:rgba(255,255,255,.72);}
.rdm-dot{width:3.5px;height:3.5px;border-radius:50%;background:var(--cy);margin-top:8px;flex-shrink:0;}

/* Live Transcript */
.tp-panel{border-radius:var(--rs);overflow:hidden;border:1px solid;}
.tp-mine{background:rgba(34,211,238,.04);border-color:rgba(34,211,238,.18);}
.tp-partner{background:rgba(99,102,241,.04);border-color:rgba(99,102,241,.18);}
.tp-head{display:flex;align-items:center;gap:7px;padding:9px 13px;border-bottom:1px solid rgba(255,255,255,.05);}
.tp-dot{width:5px;height:5px;border-radius:50%;background:var(--cy);animation:cr-blink 1.2s ease-in-out infinite;}
.tp-speaker{font-family:var(--fd);font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--mu);flex:1;}
.tp-badge{font-size:9.5px;color:var(--dm);background:var(--sf2);border:1px solid var(--b);padding:2px 7px;border-radius:100px;}
.tp-body{padding:12px 14px;min-height:64px;max-height:150px;overflow-y:auto;font-family:var(--fb);font-size:13.5px;line-height:1.78;scrollbar-width:thin;scrollbar-color:var(--sf3) transparent;}
.tp-ph{color:var(--dm);font-style:italic;}
.tp-final{color:var(--tx);}
.tp-interim{color:rgba(255,255,255,.32);font-style:italic;}

/* Center stage */
.center-stage{display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 110px);padding:40px 24px;}
.center-card{background:var(--sf);border:1px solid var(--b2);border-radius:var(--r);padding:56px 44px;text-align:center;max-width:400px;width:100%;box-shadow:0 28px 56px rgba(0,0,0,.5);display:flex;flex-direction:column;align-items:center;gap:4px;}
.cc-title{font-family:var(--fd);font-size:22px;font-weight:700;color:#fff;}
.cc-sub{font-size:13px;color:var(--mu);}

/* Results */
.res-lay{max-width:740px;margin:0 auto;padding:32px 28px;display:flex;flex-direction:column;gap:22px;}
@media(max-width:768px){.res-lay{padding:18px 14px;}}
.res-hdr{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;}
.res-title{font-family:var(--fd);font-size:24px;font-weight:800;color:#fff;}
.res-sync{display:flex;align-items:center;gap:6px;background:var(--gr2);border:1px solid rgba(74,222,128,.22);color:var(--gr);font-size:10.5px;font-weight:600;padding:4px 11px;border-radius:100px;}
.res-sync-dot{width:5px;height:5px;border-radius:50%;background:var(--gr);box-shadow:0 0 5px var(--gr);animation:cr-glow 2s ease-in-out infinite;}
.res-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}

/* Result card */
.rc-card{background:rgba(255,255,255,.025);backdrop-filter:blur(18px);border:1px solid rgba(34,211,238,.16);border-radius:var(--r);padding:26px 28px;box-shadow:0 0 0 1px rgba(255,255,255,.03) inset,0 14px 42px rgba(0,0,0,.45);position:relative;overflow:hidden;animation:cr-slide .32s ease both;}
.rc-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(34,211,238,.38),transparent);}
.rc-loading{display:flex;flex-direction:column;align-items:center;gap:12px;padding:36px;border-color:var(--b2);}
.rc-loading-txt{font-family:var(--fd);font-size:13px;color:var(--mu);}
.rc-head{display:flex;align-items:center;gap:12px;margin-bottom:22px;flex-wrap:wrap;}
.rc-round-tag{background:var(--cy2);border:1px solid var(--b3);color:var(--cy);font-family:var(--fd);font-size:9.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:3px 11px;border-radius:100px;}
.rc-who{font-family:var(--fd);font-size:13px;font-weight:600;color:rgba(255,255,255,.65);flex:1;}
.rc-score-bar{display:flex;align-items:flex-end;gap:3.5px;}
.rc-bar-seg{width:5.5px;border-radius:2.5px 2.5px 0 0;background:var(--sf3);height:var(--bh);transition:background .4s;}
.rc-bar-on{background:linear-gradient(to top,#22d3ee,#6366f1);}
.rc-score-val{font-family:var(--fd);font-size:20px;font-weight:800;color:var(--cy);margin-left:7px;}
.rc-score-of{font-size:11px;color:var(--mu);font-weight:400;}
.rc-sec{margin-bottom:18px;}
.rc-sec-last{margin-bottom:0;}
.rc-label{display:flex;align-items:center;gap:6px;font-family:var(--fd);font-size:8.5px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--dm);margin-bottom:9px;}
.rc-dot{width:4.5px;height:4.5px;border-radius:50%;flex-shrink:0;}
.rc-dot-red  {background:var(--re);box-shadow:0 0 4px var(--re);}
.rc-dot-green{background:var(--gr);box-shadow:0 0 4px var(--gr);}
.rc-dot-amber{background:var(--am);box-shadow:0 0 4px var(--am);}
.rc-dot-cyan {background:var(--cy);box-shadow:0 0 4px var(--cy);}

/* ── Original text with errors in RED ── */
.rc-orig{font-family:var(--fb);font-size:13.5px;line-height:1.82;color:rgba(255,255,255,.62);}
.err-hl{color:var(--re);background:var(--re2);border-radius:3px;padding:1px 4px;font-style:italic;text-decoration:underline wavy rgba(248,113,113,.5);text-decoration-thickness:1.5px;}

/* ── Corrected text in GREEN directly below ── */
.rc-corr{font-family:var(--fb);font-size:13.5px;line-height:1.82;color:var(--gr);}

.rc-errs{display:flex;flex-direction:column;gap:7px;}
.rc-err-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12.5px;}
.rc-err-orig{background:var(--re2);border:1px solid rgba(248,113,113,.18);color:var(--re);padding:2px 7px;border-radius:5px;font-style:italic;}
.rc-err-fix{background:var(--gr2);border:1px solid rgba(74,222,128,.18);color:var(--gr);padding:2px 7px;border-radius:5px;}
.rc-err-arr{color:var(--dm);}
.rc-err-exp{font-size:11px;color:var(--mu);font-style:italic;}
.rc-feedback{font-family:var(--fb);font-size:13.5px;line-height:1.78;color:rgba(255,255,255,.58);}

/* Switch */
.sw-card{background:var(--sf);border:1px solid var(--b2);border-radius:var(--r);padding:48px 40px;text-align:center;max-width:390px;width:100%;display:flex;flex-direction:column;align-items:center;gap:14px;box-shadow:0 28px 56px rgba(0,0,0,.5);}
.sw-icon{width:58px;height:58px;border-radius:50%;background:var(--cy2);border:1px solid var(--b3);display:flex;align-items:center;justify-content:center;}
.sw-title{font-family:var(--fd);font-size:24px;font-weight:800;color:#fff;}
.sw-sub{font-size:13px;color:var(--mu);line-height:1.6;}
.sw-name{color:var(--cy);font-weight:600;}

/* Finished */
.fin-lay{max-width:780px;margin:0 auto;padding:44px 28px;display:flex;flex-direction:column;align-items:center;gap:28px;}
.fin-hero{text-align:center;}
.fin-trophy{font-size:56px;margin-bottom:10px;}
.fin-title{font-family:var(--fd);font-size:46px;font-weight:800;letter-spacing:-1.5px;color:#fff;}
.fin-sub{font-size:14px;color:var(--mu);margin-top:5px;}
.fin-scores{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;}
.ssc{background:var(--sf2);border:1px solid var(--b2);border-radius:var(--r);padding:22px 28px;text-align:center;min-width:128px;}
.ssc-rnd{font-family:var(--fd);font-size:9.5px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--mu);margin-bottom:7px;}
.ssc-s{font-family:var(--fd);font-size:34px;font-weight:800;color:var(--cy);line-height:1;}
.ssc-s span{font-size:14px;color:var(--dm);font-weight:400;}
.ssc-bars{display:flex;align-items:flex-end;gap:3px;margin-top:9px;justify-content:center;}
.ssc-b{width:7px;border-radius:2.5px 2.5px 0 0;background:var(--sf3);height:var(--bh);}
.ssc-b-on{background:linear-gradient(to top,#22d3ee,#6366f1);}
.fin-results{width:100%;display:flex;flex-direction:column;gap:18px;}
`;
