/* ====================================================================== */
/*  aviator.jsx                                                           */
/*  Merged from: pages/Aviator.jsx + components/GameBoard.jsx +           */
/*  components/FlightStage.jsx + components/BetPanel.jsx + sounds.js.     */
/*  (Mechanical merge only — no game logic changed. All bet/cashout       */
/*  outcomes are still decided server-side in backend/src/game.js; this   */
/*  file only renders state pushed from the server and forwards user      */
/*  intents like the original components did.)                           */
/* ====================================================================== */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getSocket } from '../app-shell.jsx';
import { useAuth } from '../app-shell.jsx';

/* ======================================================================
 *  SECTION 1 — formerly sounds.js
 *  Synthesized sound effects using the Web Audio API.
 * ==================================================================== */

let audioContext = null;
let muted = false;

function getContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
  }
  // Some browsers start the context "suspended" until a user gesture -
  // resume defensively every time we're about to play something.
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  return audioContext;
}

function setMuted(value) {
  muted = value;
  try {
    localStorage.setItem('aviator_muted', value ? '1' : '0');
  } catch {
    // Ignore storage errors (e.g. private browsing) - mute state just
    // won't persist across reloads, which is a minor inconvenience, not
    // a functional break.
  }
}

function getMuted() {
  try {
    return localStorage.getItem('aviator_muted') === '1';
  } catch {
    return muted;
  }
}

// Plays a single tone: a sine wave that ramps up quickly and fades out,
// shaped by `freqStart`/`freqEnd` (pitch sweep) and `duration`.
function playTone({ freqStart, freqEnd = freqStart, duration = 0.15, volume = 0.2, type = 'sine' }) {
  if (getMuted()) return;

  const ctx = getContext();
  const now = ctx.currentTime;

  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(freqStart, now);
  if (freqEnd !== freqStart) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), now + duration);
  }

  // Quick attack, smooth decay - avoids clicks/pops at the start/end of
  // the tone.
  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(volume, now + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.start(now);
  oscillator.stop(now + duration + 0.05);
}

// A short, crisp click - used when a bet is placed.
function playBetSound() {
  playTone({ freqStart: 440, freqEnd: 660, duration: 0.08, volume: 0.15, type: 'triangle' });
}

// A bright, rising two-note chime - used on a successful cash-out. The
// higher the multiplier, the higher-pitched the chime, so bigger wins
// feel more rewarding.
function playCashOutSound(multiplier = 1) {
  if (getMuted()) return;
  const pitchBoost = Math.min(multiplier * 20, 300);
  playTone({ freqStart: 523 + pitchBoost, freqEnd: 784 + pitchBoost, duration: 0.18, volume: 0.22, type: 'sine' });
  setTimeout(() => {
    playTone({ freqStart: 784 + pitchBoost, freqEnd: 1046 + pitchBoost, duration: 0.22, volume: 0.18, type: 'sine' });
  }, 90);
}

// A low, descending thud with a touch of noise-like harshness - used
// when the plane crashes.
function playCrashSound() {
  if (getMuted()) return;
  playTone({ freqStart: 220, freqEnd: 55, duration: 0.35, volume: 0.25, type: 'sawtooth' });
}

// A soft tick - used for each history chip / round transition, kept very
// quiet so it's not annoying on every single round.
function playTickSound() {
  playTone({ freqStart: 880, duration: 0.04, volume: 0.05, type: 'sine' });
}

/* ======================================================================
 *  SECTION 2 — formerly components/FlightStage.jsx
 *  Renders the plane + curve. Time/multiplier come from the server via
 *  props, never from a local clock.
 * ==================================================================== */

const CURVE_GROWTH_EXP = 2;
const CURVE_GROWTH_COEF = 0.02;

// Inverse of the server's multiplier formula (m = 1 + 0.05*t + 0.02*t^2)
// solved for t, so we can recover "elapsed seconds equivalent" purely from
// the multiplier value the server sent - keeping this a pure function of
// server state, not an independent clock.
function elapsedSecondsFromMultiplier(m) {
  if (m <= 1) return 0;
  // 0.02*t^2 + 0.05*t + (1 - m) = 0 -> quadratic formula
  const a = 0.02;
  const b = 0.05;
  const c = 1 - m;
  const t = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return Math.max(0, t);
}

// Shows the live "next round in Xs" countdown during the betting phase,
// driven entirely by bettingSecondsLeft (which GameBoard derives from the
// server's own betting_duration_ms) - never a locally-invented timer.
function BettingCountdown({ secondsLeft }) {
  const clamped = Math.max(0, secondsLeft);
  const displaySeconds = Math.ceil(clamped);
  // Assume an 8s betting window server-side (BETTING_PHASE_MS in
  // backend/src/game.js) for the ring's fill percentage - if that value
  // changes, only the ring's visual pacing shifts, the countdown number
  // itself stays accurate either way since it's driven by the real
  // remaining time.
  const totalSeconds = 8;
  const fraction = Math.max(0, Math.min(1, clamped / totalSeconds));
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);

  return (
    <div className="betting-countdown">
      <svg viewBox="0 0 100 100" className="betting-countdown-ring">
        <circle cx="50" cy="50" r={radius} className="betting-countdown-track" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          className="betting-countdown-fill"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <div className="betting-countdown-text">
        <span className="betting-countdown-number">{displaySeconds}</span>
        <span className="betting-countdown-label">Next round in</span>
      </div>
    </div>
  );
}

function FlightStage({ phase, multiplier, crashPoint, bettingSecondsLeft }) {
  const canvasRef = useRef(null);
  const planeWrapRef = useRef(null);
  const glowRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const planeWrap = planeWrapRef.current;
    const glow = glowRef.current;
    if (!canvas || !planeWrap) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    if (phase !== 'flying' && phase !== 'ended') {
      planeWrap.style.opacity = '0';
      if (glow) glow.classList.remove('active');
      return;
    }

    const elapsedSec = elapsedSecondsFromMultiplier(multiplier);

    const padX = 26;
    const padBottom = 26;
    const padTop = 16;
    const plotW = w - padX * 2;
    const plotH = h - padBottom - padTop;

    const pxPerSecond = 46;
    const pxPerMultiplier = 34;

    const xForRaw = (t) => padX + t * pxPerSecond;
    const yForRaw = (m) => h - padBottom - (m - 1) * pxPerMultiplier;

    const steps = 90;
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * elapsedSec;
      const m = 1 + Math.pow(t, CURVE_GROWTH_EXP) * CURVE_GROWTH_COEF;
      points.push({ t, m });
    }
    const last = points[points.length - 1] || { t: 0, m: 1 };

    const anchorX = padX + plotW * 0.62;
    const anchorY = padTop + plotH * 0.62;
    const rawTipX = xForRaw(last.t);
    const rawTipY = yForRaw(last.m);
    const offsetX = Math.min(0, anchorX - rawTipX);
    const offsetY = Math.max(0, anchorY - rawTipY);

    const xFor = (t) => xForRaw(t) + offsetX;
    const yFor = (m) => yForRaw(m) + offsetY;

    ctx.beginPath();
    for (let k = 0; k < points.length; k++) {
      const x = xFor(points[k].t);
      const y = yFor(points[k].m);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = phase === 'ended' ? '#e8283f' : '#e8283f';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(232,40,63,0.65)';
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const px = xFor(last.t);
    const py = yFor(last.m);

    if (phase === 'flying') {
      planeWrap.style.opacity = '1';
      planeWrap.style.left = px + 'px';
      planeWrap.style.top = py + 'px';

      const baseAngle = Math.max(-32, Math.min(-2, -4 - last.m * 1.3));
      planeWrap.style.transform = `translate(-5%, -87%) rotate(${baseAngle}deg)`;

      if (glow) {
        glow.style.left = px + 'px';
        glow.style.top = py + 'px';
        glow.classList.add('active');
        const glowScale = Math.min(2.2, 1 + last.m * 0.06);
        glow.style.transform = `translate(-50%, -50%) scale(${glowScale})`;
      }
    } else if (phase === 'ended') {
      // Plane stays at its last position but fades/drops on crash.
      planeWrap.style.left = px + 'px';
      planeWrap.style.top = py + 'px';
      planeWrap.style.opacity = '0';
      if (glow) glow.classList.remove('active');
    }
  }, [phase, multiplier]);

  return (
    <div className="stage-wrap">
      <div className="stage">
        <div className="rays" />
        <canvas ref={canvasRef} className="curve-canvas" />
        <div className="vignette" />
        <div ref={glowRef} className="flight-glow" />

        <div ref={planeWrapRef} className="plane-wrap">
          <svg viewBox="5.41 98.71 555.88 317.58">
            <g transform="translate(10,398) scale(0.1,-0.1)" fill="#e8283f" stroke="none">
              <path d="M4713 2755 c-50 -13 -101 -28 -112 -35 -25 -13 -253 -95 -326 -117 -27 -8 -59 -20 -70 -27 -23 -14 -107 -44 -214 -76 -100 -31 -184 -25 -278 19 -149 70 -258 48 -476 -98 -54 -36 -112 -74 -129 -84 -18 -10 -55 -38 -82 -61 -28 -23 -63 -48 -78 -55 -15 -8 -52 -36 -83 -63 -62 -55 -78 -95 -73 -173 l3 -50 245 4 245 4 46 48 c25 27 51 49 57 49 6 0 40 18 74 40 35 22 68 40 74 40 5 0 20 9 31 20 12 10 68 45 125 76 56 32 110 63 118 69 26 21 419 215 436 215 12 0 130 48 212 86 40 19 78 34 85 34 7 0 17 4 23 9 17 15 137 51 174 51 47 0 102 -39 125 -87 10 -21 33 -72 53 -113 19 -41 41 -82 49 -91 7 -9 30 -54 51 -100 20 -46 54 -110 75 -141 21 -32 37 -65 35 -75 -5 -28 -45 -27 -79 1 -17 14 -36 26 -43 26 -13 0 -104 -55 -148 -89 -14 -12 -29 -21 -32 -21 -3 0 -34 -17 -68 -38 -35 -21 -84 -49 -110 -62 -27 -14 -48 -28 -48 -32 0 -4 -19 -17 -42 -28 -24 -11 -61 -32 -83 -46 -22 -13 -54 -31 -72 -39 -17 -8 -34 -19 -38 -25 -3 -5 -37 -28 -76 -51 -68 -41 -71 -42 -135 -35 -35 4 -86 14 -112 24 l-47 18 -5 54 c-4 47 -9 57 -31 67 -23 11 -183 24 -499 38 -69 4 -181 11 -250 16 -197 16 -605 42 -840 54 -58 3 -179 10 -270 16 -205 14 -415 7 -462 -15 -32 -16 -56 -33 -131 -99 -18 -15 -44 -35 -59 -44 -16 -10 -28 -20 -28 -24 0 -3 26 -29 58 -58 31 -28 85 -78 118 -111 34 -33 69 -60 79 -60 9 0 48 16 85 36 66 35 69 35 94 19 14 -10 26 -22 26 -29 0 -6 -30 -27 -67 -46 -36 -19 -77 -44 -91 -54 -25 -20 -48 -33 -157 -90 -33 -17 -83 -46 -112 -65 l-52 -34 -25 -109 c-30 -127 -31 -135 -12 -119 8 7 54 33 103 58 48 25 95 51 103 58 8 7 44 28 80 47 109 58 184 101 201 115 14 12 19 8 42 -25 l25 -39 -39 -29 c-21 -16 -39 -32 -39 -36 0 -5 -6 -8 -13 -8 -8 0 -21 -8 -31 -19 -13 -14 -14 -24 -7 -45 6 -14 13 -26 16 -26 12 0 104 50 110 60 4 6 70 42 148 81 78 39 161 81 183 95 35 20 46 23 70 14 17 -7 24 -14 18 -20 -9 -9 -148 -86 -229 -128 -16 -8 -39 -23 -50 -32 -11 -9 -54 -35 -95 -57 -134 -72 -145 -78 -150 -83 -10 -11 -65 -43 -129 -78 -36 -19 -84 -47 -106 -62 -65 -44 -185 -109 -219 -118 -53 -15 -136 3 -226 48 -47 23 -93 49 -102 57 -14 13 -72 48 -208 125 -19 11 -44 28 -55 38 -31 28 -106 72 -136 80 -55 16 -201 -37 -336 -122 -68 -43 -83 -62 -83 -102 0 -38 25 -34 132 25 105 57 113 60 113 40 0 -8 -20 -25 -44 -38 -24 -12 -50 -28 -59 -35 -8 -7 -54 -33 -101 -58 l-86 -46 -3 -77 c-2 -42 -1 -77 2 -77 3 0 52 22 110 49 l105 49 28 -21 c39 -30 274 -223 297 -245 18 -15 103 -87 133 -112 8 -6 25 -4 52 8 l41 17 -170 172 c-153 155 -170 176 -170 207 0 21 6 36 15 40 18 6 72 -18 147 -67 31 -20 61 -37 66 -37 6 0 41 -15 78 -32 61 -29 80 -33 159 -34 50 -1 98 -2 108 -3 36 -3 15 -32 -46 -61 -103 -51 -102 -51 -88 -115 7 -30 13 -55 14 -55 1 0 31 16 67 35 36 19 98 50 138 70 39 19 105 51 145 70 39 20 88 45 107 56 19 11 82 42 140 69 58 28 112 54 120 59 8 6 73 38 145 72 71 34 136 68 143 76 7 7 17 13 22 13 5 0 43 16 85 36 l76 36 70 -48 c38 -26 69 -51 69 -56 0 -14 26 -9 51 10 13 10 53 31 89 46 36 16 132 62 214 102 82 41 155 74 163 74 8 0 26 9 40 20 14 11 34 20 43 20 10 0 23 7 30 14 11 14 38 28 148 77 44 20 187 89 447 215 109 52 111 53 228 60 83 4 117 3 117 -5 0 -6 -7 -11 -16 -11 -8 0 -120 -51 -247 -114 -128 -62 -279 -135 -337 -162 -58 -26 -121 -58 -140 -71 -19 -12 -60 -31 -90 -41 -51 -18 -77 -29 -205 -88 -27 -12 -108 -46 -180 -75 -71 -28 -134 -55 -140 -59 -5 -5 -32 -17 -60 -28 -99 -39 -271 -111 -300 -126 -39 -19 -165 -72 -234 -97 -29 -11 -63 -26 -75 -34 -11 -7 -97 -39 -191 -71 -93 -31 -189 -65 -213 -76 -41 -18 -294 -110 -357 -129 -16 -5 -44 -9 -62 -9 -17 0 -34 -4 -37 -8 -3 -5 -21 -9 -41 -10 -101 -4 -265 -62 -265 -94 0 -15 72 -88 88 -88 7 0 25 6 40 14 27 14 30 13 81 -35 35 -32 57 -46 65 -41 6 5 45 21 86 35 142 49 165 58 210 81 25 13 56 27 70 31 14 4 122 45 240 91 118 47 247 96 285 111 39 14 97 38 130 53 33 16 119 49 190 75 72 26 148 56 169 67 22 11 82 36 135 55 53 20 121 45 151 56 30 11 64 26 76 33 11 8 45 22 75 33 73 25 232 88 296 117 29 13 107 44 172 68 66 25 138 54 160 65 40 21 71 33 193 76 36 13 96 38 132 55 37 17 104 46 149 64 73 30 439 204 477 227 8 5 78 41 155 80 144 73 304 166 352 207 16 13 64 46 108 75 44 29 110 76 145 105 127 103 120 94 120 155 0 110 -25 194 -105 352 -89 177 -116 225 -161 283 -18 24 -34 47 -36 51 -2 4 -20 17 -41 29 -50 29 -124 28 -244 -3z"/>
            </g>
          </svg>
        </div>

        {phase === 'betting' && bettingSecondsLeft != null && (
          <BettingCountdown secondsLeft={bettingSecondsLeft} />
        )}

        <div className="multiplier-display" style={{ color: phase === 'ended' ? '#ff4d5e' : '#f2f2f4' }}>
          {phase === 'ended' && <div className="flew-away-label">FLEW AWAY!</div>}
          {multiplier.toFixed(2)}x
        </div>
      </div>
    </div>
  );
}

/* ======================================================================
 *  SECTION 3 — formerly components/BetPanel.jsx
 *  Sends bet/cashout/auto-bet intents to the server and renders whatever
 *  state comes back. The server (backend/src/game.js) is the only place
 *  that decides bet outcomes, auto-cashout timing, or payouts.
 * ==================================================================== */

const QUICK_AMOUNTS = [16, 40, 80, 400];

function BetPanel({ slot, phase, multiplier, socket, onBalanceChange, showRemove, onRemove }) {
  const [mode, setMode] = useState('bet'); // 'bet' | 'auto'
  const [amount, setAmount] = useState(16);
  const [autoCashoutValue, setAutoCashoutValue] = useState(2.0);
  const [autoBetNextRound, setAutoBetNextRound] = useState(false);

  // status: 'idle' | 'placed' | 'cashout' (flying, can cash out) | 'won' | 'lost'
  const [status, setStatus] = useState('idle');
  const [betAmount, setBetAmount] = useState(null);
  const [cashoutMultiplier, setCashoutMultiplier] = useState(null);
  const [payout, setPayout] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const amountEditLocked = phase !== 'betting';

  // BUG FIX: the auto-bet-next-round effect below fires placeBet(true)
  // from inside a useEffect keyed only on [phase]. Because placeBet reads
  // `amount`/`autoCashoutValue`/`mode` from its enclosing closure, and
  // that closure is only recreated when the EFFECT re-runs (not on every
  // render), the effect was capturing whatever those values were at an
  // earlier point in time - not whatever the user most recently typed.
  // In practice this meant auto-bet-next-round could silently keep using
  // a stale auto-cashout target (e.g. the 2.0 default) even after the
  // user changed it, which is exactly the "always cashes out at 2" bug.
  //
  // Fix: keep the latest values in a ref that's updated on every render,
  // and read FROM THE REF inside the effect instead of from the closed-
  // over state variables directly. Refs are not subject to the stale-
  // closure problem the way captured state values are.
  const latestRef = useRef({ amount, autoCashoutValue, mode });
  useEffect(() => {
    latestRef.current = { amount, autoCashoutValue, mode };
  }, [amount, autoCashoutValue, mode]);

  // Reset per-round display state when a new betting phase begins, and
  // fire an auto-bet if the toggle is on - now reading fresh values via
  // the ref instead of stale closed-over state.
  useEffect(() => {
    if (phase === 'betting') {
      setStatus('idle');
      setCashoutMultiplier(null);
      setPayout(null);
      setError(null);
      if (autoBetNextRound) placeBetWithLatestValues();
    } else if (phase === 'flying' && status === 'placed') {
      setStatus('cashout');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Listen for server-driven auto-cashout results for this slot.
  useEffect(() => {
    if (!socket) return;
    const handler = (data) => {
      if (data.slot !== slot) return;
      setStatus('won');
      setCashoutMultiplier(data.multiplier);
      setPayout(data.payout);
      onBalanceChange();
    };
    socket.on('bet:auto_cashed_out', handler);
    return () => socket.off('bet:auto_cashed_out', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, slot]);

  // Auto-bet-next-round always goes through this, reading current values
  // from the ref (always fresh) rather than from function-closure state.
  const placeBetWithLatestValues = async () => {
    const { amount: freshAmount, autoCashoutValue: freshAutoCashout, mode: freshMode } = latestRef.current;
    await placeBetCore(freshAmount, freshMode, freshAutoCashout, true);
  };

  const placeBet = async () => {
    await placeBetCore(amount, mode, autoCashoutValue, false);
  };

  const placeBetCore = async (betAmountValue, betMode, autoCashoutTarget, isAuto) => {
    setError(null);
    if (!betAmountValue || betAmountValue <= 0) {
      if (!isAuto) setError('Enter a valid amount');
      return;
    }
    const payload = { amount: betAmountValue, slot };
    if (betMode === 'auto') {
      if (!autoCashoutTarget || autoCashoutTarget <= 1) {
        if (!isAuto) setError('Auto-cashout must be greater than 1.00x');
        return;
      }
      payload.auto_cashout_at = autoCashoutTarget;
    }
    setSubmitting(true);
    try {
      const res = await api.post('/game/bet', payload);
      if (!isAuto) playBetSound();
      setStatus('placed');
      setBetAmount(betAmountValue);
      onBalanceChange(res.data.balance);
    } catch (err) {
      if (!isAuto) setError(err.response?.data?.error || 'Could not place bet');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelBet = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post('/game/cancel-bet', { slot });
      setStatus('idle');
      setBetAmount(null);
      onBalanceChange(res.data.balance);
    } catch (err) {
      // If the server refuses (e.g. betting just closed), keep showing
      // the bet as placed rather than silently hiding a bet that's
      // actually still active - that mismatch is exactly the bug this
      // replaces.
      setError(err.response?.data?.error || 'Could not cancel bet');
    } finally {
      setSubmitting(false);
    }
  };

  const cashOut = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post('/game/cashout', { slot });
      playCashOutSound(res.data.multiplier);
      setStatus('won');
      setCashoutMultiplier(res.data.multiplier);
      setPayout(res.data.payout);
      onBalanceChange(res.data.balance);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not cash out');
      setStatus('lost');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleAutoBetNextRound = async (checked) => {
    setAutoBetNextRound(checked);
    try {
      await api.put(`/game/auto-bet/${slot}`, {
        enabled: checked,
        amount,
        auto_cashout_at: mode === 'auto' ? autoCashoutValue : null,
      });
    } catch {
      setAutoBetNextRound(!checked);
    }
  };

  const step = (delta) => {
    if (amountEditLocked) return;
    setAmount((prev) => Math.max(1, Math.round((prev + delta) * 100) / 100));
  };

  // Live "potential payout if you cashed out right now" preview - purely
  // visual, computed client-side from the bet amount and the current
  // multiplier the server is broadcasting. This never determines the
  // ACTUAL payout (that's decided server-side when cashout/auto-cashout
  // actually executes) - it's just a live estimate for the player to see.
  const showPotentialPayout = (status === 'placed' || status === 'cashout') && phase === 'flying' && multiplier;
  const potentialPayout = showPotentialPayout ? (betAmount * multiplier).toFixed(2) : null;

  return (
    <div className="bet-panel" data-mode={mode}>
      <div className="bet-panel-topline">
        <div className="mode-tabs">
          <div
            className={`mode-tab ${mode === 'bet' ? 'active' : ''}`}
            onClick={() => !amountEditLocked && setMode('bet')}
          >
            Bet
          </div>
          <div
            className={`mode-tab ${mode === 'auto' ? 'active' : ''}`}
            onClick={() => !amountEditLocked && setMode('auto')}
          >
            Auto
          </div>
        </div>
        {showRemove && (
          <button className="panel-remove-btn" onClick={onRemove} title="Remove panel">
            &minus;
          </button>
        )}
      </div>

      {mode === 'auto' && (
        <div className="auto-row" style={{ display: 'flex' }}>
          <span className="auto-label">Auto cash out at</span>
          <input
            type="number"
            step="0.1"
            min="1.01"
            value={autoCashoutValue}
            disabled={amountEditLocked}
            onChange={(e) => setAutoCashoutValue(parseFloat(e.target.value) || 0)}
          />
        </div>
      )}

      <div className="bet-panel-body">
        <div className="bet-amount-block">
          <div className="stepper-row">
            <button className="stepper-btn" disabled={amountEditLocked} onClick={() => step(-1)}>
              &minus;
            </button>
            <input
              className="stepper-input"
              type="number"
              step="1"
              min="1"
              value={amount}
              disabled={amountEditLocked}
              onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
            />
            <button className="stepper-btn" disabled={amountEditLocked} onClick={() => step(1)}>
              +
            </button>
          </div>
          <div className="quick-amount-grid">
            {QUICK_AMOUNTS.map((v) => (
              <button
                key={v}
                className={`quick-amount-btn ${Math.abs(amount - v) < 0.001 ? 'selected' : ''}`}
                disabled={amountEditLocked}
                onClick={() => setAmount(v)}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="bet-action-block">
          <ActionButton
            phase={phase}
            status={status}
            amount={amount}
            betAmount={betAmount}
            cashoutMultiplier={cashoutMultiplier}
            payout={payout}
            potentialPayout={potentialPayout}
            submitting={submitting}
            onPlace={placeBet}
            onCancel={cancelBet}
            onCashOut={cashOut}
          />
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-dim)', marginTop: 10 }}>
        <input type="checkbox" checked={autoBetNextRound} onChange={(e) => toggleAutoBetNextRound(e.target.checked)} />
        Auto-bet next round
      </label>

      {error && <div className="error-text" style={{ marginTop: 8, fontSize: 12 }}>{error}</div>}
    </div>
  );
}

function ActionButton({ phase, status, amount, betAmount, cashoutMultiplier, payout, potentialPayout, submitting, onPlace, onCancel, onCashOut }) {
  if (phase === 'betting') {
    if (status === 'placed') {
      return (
        <button className="bet-btn state-placed" onClick={onCancel} disabled={submitting}>
          <span className="bet-btn-top">Cancel</span>
          <span className="bet-btn-sub">{betAmount?.toFixed(2)} ETB</span>
        </button>
      );
    }
    return (
      <button className="bet-btn state-idle" onClick={onPlace} disabled={submitting}>
        <span className="bet-btn-top">Bet</span>
        <span className="bet-btn-sub">
          {amount?.toFixed(2)}
          <span className="cur-tag">ETB</span>
        </span>
      </button>
    );
  }

  if (phase === 'flying') {
    if (status === 'won') {
      return (
        <button className="bet-btn state-won" disabled>
          <span className="bet-btn-top">Cashed Out {cashoutMultiplier}x</span>
          <span className="bet-btn-sub">+{payout?.toFixed(2)} ETB</span>
        </button>
      );
    }
    if (status === 'cashout' || status === 'placed') {
      return (
        <button className="bet-btn state-cashout" onClick={onCashOut} disabled={submitting}>
          <span className="bet-btn-top">Cash Out</span>
          <span className="bet-btn-sub">
            {potentialPayout ? `${potentialPayout} ETB` : `${amount?.toFixed(2)} ETB`}
          </span>
        </button>
      );
    }
  }

  if (status === 'lost') {
    return (
      <button className="bet-btn state-lost" disabled>
        <span className="bet-btn-top">Lost</span>
        <span className="bet-btn-sub">{amount?.toFixed(2)} ETB</span>
      </button>
    );
  }

  return (
    <button className="bet-btn state-idle" disabled>
      <span className="bet-btn-top">Bet</span>
      <span className="bet-btn-sub">
        {amount?.toFixed(2)}
        <span className="cur-tag">ETB</span>
      </span>
    </button>
  );
}

/* ======================================================================
 *  SECTION 4 — formerly components/GameBoard.jsx
 *  Owns the Socket.IO connection; all outcomes (crash point, ticks,
 *  auto-cashout) are computed server-side and pushed here.
 * ==================================================================== */

function chipClass(crash) {
  if (crash < 1.5) return 'low';
  if (crash < 3) return 'mid';
  return 'high';
}

function MuteButton() {
  const [mutedState, setMutedState] = useState(getMuted());

  const toggle = () => {
    const next = !mutedState;
    setMuted(next);
    setMutedState(next);
  };

  return (
    <button className="icon-btn" onClick={toggle} aria-label={mutedState ? 'Unmute' : 'Mute'} title={mutedState ? 'Unmute' : 'Mute'}>
      {mutedState ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="#7a7a85" />
          <path d="M17 9l5 6M22 9l-5 6" stroke="#7a7a85" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="#f2f2f4" />
          <path d="M16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14" stroke="#f2f2f4" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function TopBar({ balance }) {
  return (
    <div className="aviator-topbar">
      <div className="aviator-brand">Aviator</div>
      <div className="aviator-topbar-right">
        <span className="aviator-balance">{Number(balance || 0).toFixed(2)} ETB</span>
        <MuteButton />
      </div>
    </div>
  );
}

function HistoryStrip({ history }) {
  return (
    <div className="history-strip">
      {history.map((r, i) => (
        <div key={r.round_id || i} className={`history-chip ${chipClass(r.crash_point)}`}>
          {r.crash_point.toFixed(2)}x
        </div>
      ))}
    </div>
  );
}

function ConnectingOverlay() {
  return (
    <div className="connecting-overlay">
      <div className="connecting-spinner" />
      <p>Connecting to live game...</p>
    </div>
  );
}

function GameBoard() {
  const { user, updateBalance } = useAuth();
  const socketRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState('betting');
  const [multiplier, setMultiplier] = useState(1.0);
  const [lastCrashPoint, setLastCrashPoint] = useState(2.0);
  const [serverSeedHash, setServerSeedHash] = useState(null);
  const [history, setHistory] = useState([]);
  const [bettingEndsAt, setBettingEndsAt] = useState(null);
  const [bettingSecondsLeft, setBettingSecondsLeft] = useState(null);

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('round:betting', (data) => {
      // A soft tick marks the start of a fresh betting window - quiet
      // enough not to be annoying every ~10 seconds, but gives a subtle
      // audio cue that a new round has opened.
      playTickSound();
      setPhase('betting');
      setServerSeedHash(data.server_seed_hash);
      setMultiplier(1.0);
      // The countdown is derived from the server's own duration, not a
      // locally-guessed value, so it always matches when the server will
      // actually flip to "flying" - it just gives that transition a
      // visible, ticking countdown instead of the screen appearing to
      // sit idle until it suddenly changes.
      if (data.betting_duration_ms) {
        setBettingEndsAt(Date.now() + data.betting_duration_ms);
      }
    });

    socket.on('round:flying', () => {
      setPhase('flying');
      setBettingEndsAt(null);
      setBettingSecondsLeft(null);
    });

    socket.on('round:tick', (data) => setMultiplier(data.multiplier));

    socket.on('round:crashed', (data) => {
      playCrashSound();
      setPhase('ended');
      setMultiplier(data.crash_point);
      setLastCrashPoint(data.crash_point);
      setHistory((prev) => [{ round_id: data.round_id, crash_point: data.crash_point }, ...prev].slice(0, 20));
    });

    api
      .get('/game/history')
      .then((res) => setHistory(res.data.rounds))
      .catch(() => {});

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('round:betting');
      socket.off('round:flying');
      socket.off('round:tick');
      socket.off('round:crashed');
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!bettingEndsAt) {
      setBettingSecondsLeft(null);
      return;
    }
    const tick = () => {
      const remainingMs = bettingEndsAt - Date.now();
      setBettingSecondsLeft(Math.max(0, remainingMs / 1000));
    };
    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [bettingEndsAt]);

  const handleBalanceChange = (newBalance) => {
    if (typeof newBalance === 'number') {
      updateBalance(newBalance);
    } else {
      api.get('/wallet/balance').then((res) => updateBalance(res.data.balance));
    }
  };

  return (
    <div className="card aviator-card">
      {!connected && <ConnectingOverlay />}

      <TopBar balance={user?.balance} />
      <HistoryStrip history={history} />

      <FlightStage
        phase={phase}
        multiplier={multiplier}
        crashPoint={phase === 'ended' ? multiplier : lastCrashPoint}
        bettingSecondsLeft={bettingSecondsLeft}
      />

      <div className="aviator-body">
        {serverSeedHash && (
          <p className="seed-hash-note">
            Provably fair seed hash: {serverSeedHash.slice(0, 24)}...
          </p>
        )}

        <div className="bet-panels-grid">
          <BetPanel slot={1} phase={phase} multiplier={multiplier} socket={socketRef.current} onBalanceChange={handleBalanceChange} />
          <BetPanel slot={2} phase={phase} multiplier={multiplier} socket={socketRef.current} onBalanceChange={handleBalanceChange} />
        </div>
      </div>
    </div>
  );
}

/* ======================================================================
 *  SECTION 5 — formerly pages/Aviator.jsx
 *  The live Aviator game screen. Reached from the Dashboard game tile.
 * ==================================================================== */

export default function Aviator() {
  const navigate = useNavigate();

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          borderBottom: '1px solid #2a2e3e',
        }}
      >
        <button
          className="btn btn-outline"
          onClick={() => navigate('/dashboard')}
          style={{ padding: '6px 12px' }}
        >
          ← Back
        </button>
        <span style={{ fontWeight: 700, color: '#4f8ef7' }}>Aviator</span>
      </div>

      <div className="container">
        <GameBoard />
      </div>
    </div>
  );
}
