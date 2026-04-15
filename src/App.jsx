/**
 * App.jsx — B2 Beruf Practice App
 *
 * Screens:
 *   landing    → شاشة الترحيب: اختيار بين Solo أو Multiplayer
 *   solo       → ChallengeRoom بدون Firebase (Solo Mode)
 *   lobby      → إدخال Room ID للـ Multiplayer
 *   multi      → ChallengeRoom مع Firebase (Multiplayer Mode)
 */

import { useState } from "react";
import ChallengeRoom from "./ChallengeRoom";
import questions from "./questions.json";

// ── CSS for Landing & Lobby screens ──────────────────────────
const LANDING_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #0c0d12;
  color: #eaecf2;
  font-family: 'DM Sans', sans-serif;
  min-height: 100vh;
}

.app-root {
  min-height: 100vh;
  background: #0c0d12;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  position: relative;
  overflow: hidden;
}

/* subtle background glow blobs */
.app-root::before, .app-root::after {
  content: '';
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.07;
  pointer-events: none;
}
.app-root::before {
  width: 500px; height: 500px;
  background: #5b7fff;
  top: -150px; left: -100px;
}
.app-root::after {
  width: 400px; height: 400px;
  background: #3ecf6e;
  bottom: -120px; right: -80px;
}

/* ── Landing ── */
.landing-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 40px;
  max-width: 560px;
  width: 100%;
  position: relative;
  z-index: 1;
  animation: fadeUp .5s ease;
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}

.landing-badge {
  background: rgba(91,127,255,.15);
  border: 1px solid rgba(91,127,255,.3);
  border-radius: 99px;
  padding: 6px 16px;
  font-family: 'Syne', sans-serif;
  font-size: 12px;
  font-weight: 600;
  color: #7b9fff;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.landing-title {
  font-family: 'Syne', sans-serif;
  font-size: clamp(32px, 6vw, 52px);
  font-weight: 800;
  text-align: center;
  line-height: 1.15;
  color: #eaecf2;
}

.landing-title span {
  color: #5b7fff;
}

.landing-sub {
  font-size: 16px;
  color: #7c8096;
  text-align: center;
  line-height: 1.65;
  max-width: 420px;
}

.mode-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  width: 100%;
}

.mode-card {
  background: #13151d;
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 20px;
  padding: 28px 24px;
  cursor: pointer;
  transition: border-color .2s, transform .15s, background .2s;
  display: flex;
  flex-direction: column;
  gap: 14px;
  text-align: left;
  position: relative;
  overflow: hidden;
}

.mode-card::before {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity .2s;
  border-radius: 20px;
}

.mode-card.solo::before   { background: radial-gradient(circle at top left, rgba(91,127,255,.08), transparent 60%); }
.mode-card.multi::before  { background: radial-gradient(circle at top left, rgba(62,207,110,.07), transparent 60%); }

.mode-card:hover { transform: translateY(-2px); }
.mode-card:hover::before { opacity: 1; }
.mode-card.solo:hover  { border-color: rgba(91,127,255,.5); }
.mode-card.multi:hover { border-color: rgba(62,207,110,.4); }
.mode-card:active { transform: translateY(0) scale(.98); }

.mode-icon {
  font-size: 32px;
  line-height: 1;
}

.mode-tag {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  border-radius: 99px;
  padding: 3px 10px;
  align-self: flex-start;
}

.mode-card.solo .mode-tag {
  background: rgba(91,127,255,.12);
  color: #7b9fff;
  border: 1px solid rgba(91,127,255,.25);
}
.mode-card.multi .mode-tag {
  background: rgba(62,207,110,.1);
  color: #3ecf6e;
  border: 1px solid rgba(62,207,110,.25);
}

.mode-title {
  font-family: 'Syne', sans-serif;
  font-size: 18px;
  font-weight: 700;
  color: #eaecf2;
}

.mode-desc {
  font-size: 13px;
  color: #7c8096;
  line-height: 1.6;
}

.mode-features {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.mode-feature {
  font-size: 12px;
  color: #5a5f78;
  display: flex;
  align-items: center;
  gap: 7px;
}

.mode-feature::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}

.mode-card.solo .mode-feature::before  { background: #5b7fff; }
.mode-card.multi .mode-feature::before { background: #3ecf6e; }

.landing-footer {
  font-size: 12px;
  color: #4a4f62;
  text-align: center;
}

/* ── Lobby (Multiplayer Room Entry) ── */
.lobby-wrap {
  background: #13151d;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 24px;
  padding: 40px 36px;
  max-width: 440px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 24px;
  position: relative;
  z-index: 1;
  animation: fadeUp .4s ease;
}

.lobby-back {
  background: transparent;
  border: none;
  color: #7c8096;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  transition: color .2s;
  font-family: 'DM Sans', sans-serif;
}
.lobby-back:hover { color: #eaecf2; }

.lobby-title {
  font-family: 'Syne', sans-serif;
  font-size: 22px;
  font-weight: 800;
  color: #eaecf2;
}

.lobby-sub {
  font-size: 14px;
  color: #7c8096;
  line-height: 1.6;
  margin-top: -12px;
}

.lobby-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lobby-label {
  font-size: 12px;
  font-weight: 600;
  color: #7c8096;
  text-transform: uppercase;
  letter-spacing: .07em;
}

.lobby-input {
  background: #0c0d12;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  padding: 12px 14px;
  color: #eaecf2;
  font-family: 'Syne', sans-serif;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: .1em;
  outline: none;
  transition: border-color .2s;
  width: 100%;
  text-transform: uppercase;
}
.lobby-input:focus { border-color: #5b7fff; }
.lobby-input::placeholder { color: #4a4f62; text-transform: none; font-weight: 400; letter-spacing: 0; }

.lobby-hint {
  font-size: 12px;
  color: #4a4f62;
  margin-top: -4px;
}

.lobby-name-input {
  background: #0c0d12;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  padding: 12px 14px;
  color: #eaecf2;
  font-family: 'DM Sans', sans-serif;
  font-size: 14px;
  outline: none;
  transition: border-color .2s;
  width: 100%;
}
.lobby-name-input:focus { border-color: #5b7fff; }
.lobby-name-input::placeholder { color: #4a4f62; }

.lobby-btn {
  background: #5b7fff;
  color: #fff;
  border: none;
  border-radius: 12px;
  padding: 14px;
  font-family: 'Syne', sans-serif;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  transition: opacity .2s, transform .1s;
  letter-spacing: .02em;
}
.lobby-btn:hover { opacity: .88; }
.lobby-btn:active { transform: scale(.97); }
.lobby-btn:disabled { opacity: .35; cursor: default; }

.lobby-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #4a4f62;
  font-size: 12px;
}
.lobby-divider::before, .lobby-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: rgba(255,255,255,0.07);
}

.lobby-create-btn {
  background: transparent;
  border: 1px solid rgba(255,255,255,0.1);
  color: #7c8096;
  border-radius: 12px;
  padding: 12px;
  font-family: 'DM Sans', sans-serif;
  font-size: 14px;
  cursor: pointer;
  transition: border-color .2s, color .2s;
}
.lobby-create-btn:hover { border-color: rgba(62,207,110,.4); color: #3ecf6e; }

@media (max-width: 480px) {
  .mode-cards { grid-template-columns: 1fr; }
  .lobby-wrap { padding: 28px 20px; }
}
`;

// ── generate a short random room ID ──────────────────────────
function generateRoomId() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// ── Landing Page ──────────────────────────────────────────────
function LandingPage({ onSolo, onMulti }) {
  return (
    <>
      <style>{LANDING_CSS}</style>
      <div className="app-root">
        <div className="landing-wrap">
          <span className="landing-badge">Deutschprüfung B2 Beruf · Teil 2</span>

          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: "14px" }}>
            <h1 className="landing-title">
              Übe dein <span>Deutsch</span><br />für den Beruf
            </h1>
            <p className="landing-sub">
              Interaktives Training für die mündliche B2-Prüfung — alleine oder mit einem Lernpartner.
            </p>
          </div>

          <div className="mode-cards">
            {/* Solo Mode */}
            <button className="mode-card solo" onClick={onSolo}>
              <span className="mode-icon">🎯</span>
              <span className="mode-tag">Offline · Solo</span>
              <span className="mode-title">Einzeltraining</span>
              <span className="mode-desc">Übe alleine in deinem eigenen Tempo.</span>
              <ul className="mode-features">
                <li className="mode-feature">30 Sek. Vorbereitung</li>
                <li className="mode-feature">3 Min. Sprechzeit</li>
                <li className="mode-feature">Keyword-Bewertung</li>
                <li className="mode-feature">Kein Internet nötig</li>
              </ul>
            </button>

            {/* Multiplayer Mode */}
            <button className="mode-card multi" onClick={onMulti}>
              <span className="mode-icon">🤝</span>
              <span className="mode-tag">Online · 2 Personen</span>
              <span className="mode-title">Partnertraining</span>
              <span className="mode-desc">Übe mit einem Lernpartner in Echtzeit.</span>
              <ul className="mode-features">
                <li className="mode-feature">Geteilter Timer</li>
                <li className="mode-feature">Rollentausch</li>
                <li className="mode-feature">Gegenseitiges Feedback</li>
                <li className="mode-feature">Sync über Firebase</li>
              </ul>
            </button>
          </div>

          <p className="landing-footer">
            42 Übungsfragen · Prüfungsniveau B2 Beruf · Teil 2 Mündlich
          </p>
        </div>
      </div>
    </>
  );
}

// ── Multiplayer Lobby ─────────────────────────────────────────
function MultiplayerLobby({ onEnter, onBack }) {
  const [roomId, setRoomId] = useState("");
  const [name, setName]     = useState("");

  function handleJoin() {
    if (!roomId.trim() || !name.trim()) return;
    onEnter({ roomId: roomId.trim().toUpperCase(), displayName: name.trim() });
  }

  function handleCreate() {
    const newId = generateRoomId();
    setRoomId(newId);
  }

  return (
    <>
      <style>{LANDING_CSS}</style>
      <div className="app-root">
        <div className="lobby-wrap">
          <button className="lobby-back" onClick={onBack}>
            ← Zurück
          </button>

          <div>
            <h2 className="lobby-title">Partnertraining</h2>
            <p className="lobby-sub">Erstelle einen Raum oder tritt einem bestehenden bei.</p>
          </div>

          <div className="lobby-field">
            <label className="lobby-label">Dein Name</label>
            <input
              className="lobby-name-input"
              placeholder="z. B. Ahmad"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={30}
            />
          </div>

          <div className="lobby-field">
            <label className="lobby-label">Raum-ID</label>
            <input
              className="lobby-input"
              placeholder="z. B. AB12C"
              value={roomId}
              onChange={e => setRoomId(e.target.value.toUpperCase())}
              maxLength={8}
            />
            <span className="lobby-hint">Teile diese ID mit deinem Lernpartner.</span>
          </div>

          <button
            className="lobby-btn"
            onClick={handleJoin}
            disabled={!roomId.trim() || !name.trim()}
          >
            Raum beitreten →
          </button>

          <div className="lobby-divider">oder</div>

          <button className="lobby-create-btn" onClick={handleCreate}>
            ✦ Neuen Raum erstellen
          </button>
        </div>
      </div>
    </>
  );
}

// ── Root App ──────────────────────────────────────────────────
export default function App() {
  // screen: "landing" | "lobby" | "solo" | "multi"
  const [screen, setScreen] = useState("landing");

  // Multiplayer session data (set from Lobby)
  const [multiSession, setMultiSession] = useState(null);
  // { roomId: string, displayName: string }

  // Solo user (static demo user)
  const soloUser = { uid: "solo-user", displayName: "Du" };

  function handleEnterMulti({ roomId, displayName }) {
    setMultiSession({
      roomId,
      user: { uid: `user-${Date.now()}`, displayName },
    });
    setScreen("multi");
  }

  function handleExit() {
    // Return to landing, clear session data
    setScreen("landing");
    setMultiSession(null);
  }

  return (
    <>
      {screen === "landing" && (
        <LandingPage
          onSolo={() => setScreen("solo")}
          onMulti={() => setScreen("lobby")}
        />
      )}

      {screen === "lobby" && (
        <MultiplayerLobby
          onEnter={handleEnterMulti}
          onBack={() => setScreen("landing")}
        />
      )}

      {screen === "solo" && (
        <ChallengeRoom
          mode="solo"
          roomId={null}
          currentUser={soloUser}
          questions={questions}
          onExit={handleExit}
        />
      )}

      {screen === "multi" && multiSession && (
        <ChallengeRoom
          mode="multi"
          roomId={multiSession.roomId}
          currentUser={multiSession.user}
          questions={questions}
          onExit={handleExit}
        />
      )}
    </>
  );
}
