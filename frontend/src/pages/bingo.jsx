/* ====================================================================== */
/*  bingo.jsx                                                              */
/*  75-ball Bingo game screen. All round state (join countdown, called      */
/*  numbers, win detection, payouts) is decided server-side in               */
/*  backend/src/bingo.js and pushed here via Socket.IO - this file only      */
/*  renders that state and forwards the player's card picks.                 */
/* ====================================================================== */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSocket, getBingoState, getBingoCartelas, joinBingoCartela } from '../app-shell.jsx';
import { useAuth } from '../app-shell.jsx';

const BINGO_LETTERS = ['B', 'I', 'N', 'G', 'O'];

function letterForNumber(n) {
  return BINGO_LETTERS[Math.floor((n - 1) / 15)];
}

export default function Bingo() {
  const { user, updateBalance } = useAuth();
  const navigate = useNavigate();
  const socketRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('waiting');
  const [roundId, setRoundId] = useState(null);
  const [stakeAmount, setStakeAmount] = useState(10);
  const [joinDeadline, setJoinDeadline] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [calledNumbers, setCalledNumbers] = useState([]);
  const [myCartelas, setMyCartelas] = useState([]);
  const [cartelaPool, setCartelaPool] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [joining, setJoining] = useState(null);
  const [joinError, setJoinError] = useState(null);
  const [roundResult, setRoundResult] = useState(null);
  const [playersInRound, setPlayersInRound] = useState({ players: 0, cartelas: 0 });

  useEffect(() => {
    getBingoCartelas()
      .then((res) => setCartelaPool(res.data.cartelas))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('bingo:waiting', (data) => {
      setStatus('waiting');
      setRoundId(data.round_id);
      setStakeAmount(Number(data.stake_amount ?? 10));
      setCalledNumbers([]);
      setMyCartelas([]);
      setRoundResult(null);
      setJoinDeadline(Date.now() + (data.join_seconds || 45) * 1000);
      setPlayersInRound({ players: 0, cartelas: 0 });
    });

    socket.on('bingo:restarted', () => {});

    socket.on('bingo:playing', (data) => {
      setStatus('playing');
      setJoinDeadline(null);
      setPlayersInRound((prev) => ({ ...prev, cartelas: data.cartelas_in_play }));
    });

    socket.on('bingo:player_joined', () => {
      setPlayersInRound((prev) => ({ ...prev, cartelas: prev.cartelas + 1 }));
    });

    socket.on('bingo:number_called', (data) => {
      setCalledNumbers(data.called_numbers);
    });

    socket.on('bingo:round_ended', (data) => {
      setStatus('finished');
      setRoundResult(data);
    });

    getBingoState()
      .then((res) => {
        const d = res.data;
        if (!d.round_id) return;
        setRoundId(d.round_id);
        setStatus(d.status);
        // Number(...) guards against .toFixed() ever being called on
        // undefined further down (see stakeAmount.toFixed(2) and
        // result.payout_each.toFixed(2) below) - the same class of bug
        // that previously blanked the wallet page. d.stake_amount should
        // always be a number here, but a brief round-transition race on
        // the server (currentRound being reassigned mid-request) could in
        // principle hand back an unexpected shape, and this makes that
        // harmless instead of a crash.
        setStakeAmount(Number(d.stake_amount ?? 10));
        setCalledNumbers(d.called_numbers || []);
        setMyCartelas(d.my_cartelas || []);
        setJoinDeadline(d.join_deadline);
        setPlayersInRound({ players: d.players || 0, cartelas: d.cartelas_in_play || 0 });
      })
      .catch(() => {});

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('bingo:waiting');
      socket.off('bingo:restarted');
      socket.off('bingo:playing');
      socket.off('bingo:player_joined');
      socket.off('bingo:number_called');
      socket.off('bingo:round_ended');
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!joinDeadline) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.round((joinDeadline - Date.now()) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [joinDeadline]);

  const handlePickCard = async (cardNumber) => {
    if (myCartelas.length >= 2) return;
    if (myCartelas.some((c) => c.card_number === cardNumber)) return;

    setJoinError(null);
    setJoining(cardNumber);
    try {
      const res = await joinBingoCartela(cardNumber);
      setMyCartelas((prev) => [...prev, { card_number: cardNumber, numbers: res.data.numbers }]);
      updateBalance(res.data.balance);
      setPickerOpen(false);
    } catch (err) {
      setJoinError(err.response?.data?.error || 'Could not join with that card');
    } finally {
      setJoining(null);
    }
  };

  const calledSet = new Set(calledNumbers);
  const lastCalled = calledNumbers[calledNumbers.length - 1] || null;

  return (
    <div className="container" style={{ paddingBottom: 24 }}>
      <div className="card bingo-card" style={{ position: 'relative' }}>
        {!connected && <ConnectingOverlay />}

        <div className="bingo-header-row">
          <button className="btn btn-outline" onClick={() => navigate('/dashboard')} style={{ padding: '6px 14px' }}>
            ← Leave
          </button>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#4ade80' }}>Bingo</div>
          <div style={{ fontSize: 13, color: '#9aa0b4' }}>
            {Number(user?.balance || 0).toFixed(2)} ETB
          </div>
        </div>

        <div className="bingo-status-card">
          {status === 'waiting' && (
            <>
              <div style={{ fontSize: 14, color: '#9aa0b4' }}>Next round starts in</div>
              <div style={{ fontSize: 40, fontWeight: 800, color: '#f7b955' }}>{secondsLeft ?? '--'}s</div>
              <div style={{ fontSize: 13, color: '#9aa0b4', marginTop: 4 }}>
                Stake: {stakeAmount.toFixed(2)} ETB per cartela · Boards: {myCartelas.length}/2
              </div>
            </>
          )}
          {status === 'playing' && (
            <>
              <div style={{ fontSize: 14, color: '#9aa0b4' }}>Current call</div>
              <div style={{ fontSize: 44, fontWeight: 800, color: lastCalled ? '#4ade80' : '#9aa0b4' }}>
                {lastCalled ? `${letterForNumber(lastCalled)}-${lastCalled}` : '—'}
              </div>
              <div style={{ fontSize: 13, color: '#9aa0b4', marginTop: 4 }}>
                {playersInRound.cartelas} cartelas in play · {calledNumbers.length} called
              </div>
            </>
          )}
          {status === 'finished' && roundResult && <RoundResultBanner result={roundResult} currentUserId={user?.id} />}
        </div>

        {status === 'waiting' && myCartelas.length < 2 && (
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }} onClick={() => setPickerOpen(true)}>
            {myCartelas.length === 0 ? 'Pick a Cartela' : 'Pick Another Cartela'}
          </button>
        )}

        {joinError && <div className="error-text" style={{ marginTop: 10 }}>{joinError}</div>}

        <NumberBoard calledSet={calledSet} lastCalled={lastCalled} />

        {myCartelas.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <h4 style={{ margin: '0 0 10px' }}>Your Cartelas</h4>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {myCartelas.map((c) => (
                <CartelaCard key={c.card_number} cardNumber={c.card_number} numbers={c.numbers} calledSet={calledSet} />
              ))}
            </div>
          </div>
        )}
      </div>

      {pickerOpen && (
        <CartelaPickerModal
          pool={cartelaPool}
          myCartelas={myCartelas}
          joining={joining}
          onPick={handlePickCard}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function ConnectingOverlay() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(11,13,23,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 5,
        borderRadius: 18,
        fontSize: 14,
        color: '#9aa0b4',
      }}
    >
      Connecting...
    </div>
  );
}

function NumberBoard({ calledSet, lastCalled }) {
  return (
    <div className="bingo-number-board" style={{ marginTop: 18 }}>
      <div className="bingo-board-header">
        {BINGO_LETTERS.map((letter) => (
          <div key={letter} className={`bingo-letter-badge bingo-letter-${letter}`}>
            {letter}
          </div>
        ))}
      </div>
      <div className="bingo-board-grid">
        {Array.from({ length: 15 }, (_, row) => (
          <div key={row} className="bingo-board-row">
            {BINGO_LETTERS.map((_, col) => {
              const n = col * 15 + row + 1;
              const isCalled = calledSet.has(n);
              const isLast = n === lastCalled;
              return (
                <div key={n} className={`bingo-board-cell ${isCalled ? 'called' : ''} ${isLast ? 'last-called' : ''}`}>
                  {n}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function CartelaCard({ cardNumber, numbers, calledSet }) {
  return (
    <div className="bingo-cartela">
      <div className="bingo-cartela-title">Card #{cardNumber}</div>
      <div className="bingo-cartela-header">
        {BINGO_LETTERS.map((letter) => (
          <div key={letter} className="bingo-cartela-letter">
            {letter}
          </div>
        ))}
      </div>
      <div className="bingo-cartela-grid">
        {numbers.map((n, i) => {
          const isFree = n === null;
          const isMarked = isFree || calledSet.has(n);
          return (
            <div key={i} className={`bingo-cartela-cell ${isMarked ? 'marked' : ''} ${isFree ? 'free' : ''}`}>
              {isFree ? 'FREE' : n}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CartelaPickerModal({ pool, myCartelas, joining, onPick, onClose }) {
  const myCardNumbers = new Set(myCartelas.map((c) => c.card_number));

  return (
    <div className="bingo-picker-overlay" onClick={onClose}>
      <div className="bingo-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bingo-picker-header">
          <span>Tap a card to join</span>
          <button className="btn btn-outline" style={{ padding: '4px 12px' }} onClick={onClose}>
            Close
          </button>
        </div>
        <div className="bingo-picker-grid">
          {pool.map((c) => {
            const isMine = myCardNumbers.has(c.card_number);
            const isBusy = joining === c.card_number;
            return (
              <button
                key={c.card_number}
                className={`bingo-picker-cell ${isMine ? 'mine' : ''}`}
                disabled={isMine || isBusy || myCartelas.length >= 2}
                onClick={() => onPick(c.card_number)}
              >
                {isBusy ? '...' : c.card_number}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RoundResultBanner({ result, currentUserId }) {
  const winners = result.winners || [];
  const payoutEach = Number(result.payout_each ?? 0);
  const iWon = winners.some((w) => w.user_id === currentUserId);

  if (winners.length === 0) {
    return (
      <>
        <div style={{ fontSize: 16, color: '#9aa0b4' }}>Round ended - no winner this time</div>
        <div style={{ fontSize: 13, color: '#9aa0b4', marginTop: 4 }}>Next round starting shortly...</div>
      </>
    );
  }

  return (
    <>
      <div style={{ fontSize: 15, color: iWon ? '#4ade80' : '#f2f2f4', fontWeight: 700 }}>
        {iWon ? '🎉 You won!' : 'Round winner' + (winners.length > 1 ? 's' : '')}
      </div>
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {winners.map((w) => (
          <div key={`${w.user_id}-${w.card_number}`} style={{ fontSize: 14, color: '#f2f2f4' }}>
            {w.username} - Card #{w.card_number}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: '#f7b955', marginTop: 8 }}>
        {payoutEach.toFixed(2)} ETB {winners.length > 1 ? 'each' : ''}
      </div>
      <div style={{ fontSize: 12, color: '#9aa0b4', marginTop: 4 }}>Next round starting shortly...</div>
    </>
  );
}
