import { useEffect, useRef, useState, useCallback } from 'react';
import { Routes, Route, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useTelegram, api, getSocket } from './lib';
import { BingoCard, CalledNumbersStrip } from './components';

/**
 * ===========================================================================
 * APP SHELL — router + bottom nav
 * ===========================================================================
 */
export default function App() {
  return (
    <div className="app-shell">
      <main className="app-shell__content">
        <Routes>
          <Route path="/" element={<LobbyPage />} />
          <Route path="/room/:roomId" element={<RoomPage />} />
          <Route path="/wallet" element={<WalletPage />} />
        </Routes>
      </main>
      <nav className="bottom-nav">
        <NavLink to="/" className="bottom-nav__item" end>
          Tables
        </NavLink>
        <NavLink to="/wallet" className="bottom-nav__item">
          Wallet
        </NavLink>
      </nav>
    </div>
  );
}

/**
 * ===========================================================================
 * LOBBY PAGE — list of open rooms, create a room, shows wallet balance
 * ===========================================================================
 */
function LobbyPage() {
  const { initData, user, haptic } = useTelegram();
  const navigate = useNavigate();

  const [rooms, setRooms] = useState([]);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!initData) return;
    let cancelled = false;

    async function load() {
      try {
        const [roomsRes, balanceRes] = await Promise.all([
          api.rooms.list(initData),
          api.wallet.balance(initData),
        ]);
        if (cancelled) return;
        setRooms(roomsRes.rooms);
        setBalance(balanceRes.balance);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [initData]);

  async function handleCreateRoom(stake) {
    setCreating(true);
    haptic.light();
    try {
      const { room } = await api.rooms.create({ stake }, initData);
      navigate(`/room/${room.id}`);
    } catch (err) {
      setError(err.message);
      haptic.error();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page lobby">
      <header className="lobby__header">
        <div>
          <h1 className="lobby__title">Bingo</h1>
          {user && <p className="lobby__greeting">Hi, {user.first_name}</p>}
        </div>
        <div className="lobby__balance">
          <span className="lobby__balance-label">Balance</span>
          <span className="lobby__balance-amount">
            {balance === null ? '—' : `${balance.toFixed(2)} ETB`}
          </span>
        </div>
      </header>

      {error && <p className="lobby__error">{error}</p>}

      <section className="lobby__create">
        <h2 className="lobby__section-title">Start a table</h2>
        <div className="lobby__stake-options">
          {[10, 25, 50, 100].map((stake) => (
            <button
              key={stake}
              className="stake-button"
              disabled={creating}
              onClick={() => handleCreateRoom(stake)}
            >
              {stake} ETB
            </button>
          ))}
        </div>
      </section>

      <section className="lobby__rooms">
        <h2 className="lobby__section-title">Open tables</h2>
        {loading && <p className="lobby__muted">Loading tables…</p>}
        {!loading && rooms.length === 0 && (
          <p className="lobby__muted">No open tables right now — start one above.</p>
        )}
        <ul className="room-list">
          {rooms.map((room) => (
            <li key={room.id} className="room-list__item">
              <button className="room-list__button" onClick={() => navigate(`/room/${room.id}`)}>
                <div>
                  <span className="room-list__code">#{room.code}</span>
                  <span className="room-list__players">{room.playerCount} joined</span>
                </div>
                <span className="room-list__stake">{Number(room.stake).toFixed(0)} ETB</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * ===========================================================================
 * ROOM PAGE — live game: joins the socket room, displays card + draws,
 * handles win claims
 * ===========================================================================
 */
function RoomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { initData, haptic } = useTelegram();

  const [room, setRoom] = useState(null);
  const [card, setCard] = useState(null);
  const [marked, setMarked] = useState([]);
  const [drawnNumbers, setDrawnNumbers] = useState([]);
  const [status, setStatus] = useState('loading');
  const [resultMessage, setResultMessage] = useState(null);
  const [error, setError] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => {
    if (!initData) return;
    let cancelled = false;

    async function load() {
      try {
        const { room, drawnNumbers } = await api.rooms.get(roomId, initData);
        if (cancelled) return;
        setRoom(room);
        setDrawnNumbers(drawnNumbers);
        setStatus(room.status);

        try {
          const myCard = await api.rooms.myCard(roomId, initData);
          if (!cancelled) {
            setCard(myCard.card);
            setMarked(myCard.marked || []);
          }
        } catch {
          // Not joined yet — the join button handles that.
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [roomId, initData]);

  useEffect(() => {
    if (!initData) return;
    const socket = getSocket(initData);
    socketRef.current = socket;

    function onDraw({ drawnNumbers }) {
      setDrawnNumbers(drawnNumbers);
      haptic.light();
    }
    function onStarted() {
      setStatus('active');
    }
    function onWon({ winnerId, payout }) {
      setStatus('won');
      setResultMessage(winnerId ? `Bingo! Payout: ${Number(payout).toFixed(2)} ETB` : 'Round ended.');
      haptic.success();
    }
    function onCancelled({ reason }) {
      setStatus('cancelled');
      setResultMessage(reason || 'Room cancelled — stakes refunded.');
    }

    socket.on('room:draw', onDraw);
    socket.on('room:started', onStarted);
    socket.on('room:won', onWon);
    socket.on('room:cancelled', onCancelled);

    return () => {
      socket.off('room:draw', onDraw);
      socket.off('room:started', onStarted);
      socket.off('room:won', onWon);
      socket.off('room:cancelled', onCancelled);
    };
  }, [initData, haptic]);

  const handleJoin = useCallback(() => {
    socketRef.current?.emit('room:join', { roomId }, (res) => {
      if (res.ok) {
        setCard(res.card);
        haptic.light();
      } else {
        setError(res.error);
        haptic.error();
      }
    });
  }, [roomId, haptic]);

  const handleStart = useCallback(() => {
    socketRef.current?.emit('room:start', { roomId }, (res) => {
      if (!res.ok) setError(res.error);
    });
  }, [roomId]);

  const handleCellTap = useCallback(
    (value) => {
      if (!value) return;
      setMarked((prev) => (prev.includes(value) ? prev : [...prev, value]));
      haptic.light();
    },
    [haptic]
  );

  const handleClaim = useCallback(() => {
    socketRef.current?.emit('room:claim', { roomId, pattern: 'line' }, (res) => {
      if (!res.ok) {
        setError(res.error);
        haptic.error();
      }
    });
  }, [roomId, haptic]);

  if (error && !room) {
    return (
      <div className="page room-page">
        <p className="lobby__error">{error}</p>
        <button className="ghost-button" onClick={() => navigate('/')}>
          Back to lobby
        </button>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="page room-page">
        <p className="lobby__muted">Loading table…</p>
      </div>
    );
  }

  return (
    <div className="page room-page">
      <header className="room-page__header">
        <button className="ghost-button" onClick={() => navigate('/')}>
          ← Lobby
        </button>
        <span className="room-page__code">#{room.code}</span>
        <span className="room-page__stake">{Number(room.stake).toFixed(0)} ETB</span>
      </header>

      {error && <p className="lobby__error">{error}</p>}
      {resultMessage && <p className="room-page__result">{resultMessage}</p>}

      {status === 'active' && <CalledNumbersStrip drawnNumbers={drawnNumbers} />}

      {card ? (
        <>
          <BingoCard card={card} drawnNumbers={drawnNumbers} marked={marked} onCellTap={handleCellTap} />
          {status === 'active' && (
            <button className="primary-button primary-button--claim" onClick={handleClaim}>
              BINGO!
            </button>
          )}
        </>
      ) : (
        <div className="room-page__join">
          <p className="lobby__muted">You haven't joined this table yet.</p>
          <button className="primary-button" onClick={handleJoin}>
            Join for {Number(room.stake).toFixed(0)} ETB
          </button>
        </div>
      )}

      {status === 'waiting' && card && (
        <button className="ghost-button" onClick={handleStart}>
          Start game
        </button>
      )}
    </div>
  );
}

/**
 * ===========================================================================
 * WALLET PAGE — deposit/withdraw requests and transaction history
 * ===========================================================================
 */
function WalletPage() {
  const { initData, haptic } = useTelegram();
  const navigate = useNavigate();

  const [balance, setBalance] = useState(null);
  const [history, setHistory] = useState([]);
  const [mode, setMode] = useState('deposit');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!initData) return;
    api.wallet.balance(initData).then((r) => setBalance(r.balance)).catch(() => {});
    api.wallet.history(initData).then((r) => setHistory(r.entries)).catch(() => {});
  }, [initData]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const payload = { amount: Number(amount), provider: 'telebirr', providerReference: reference };
      if (mode === 'deposit') {
        await api.wallet.deposit(payload, initData);
        setMessage('Deposit request submitted — pending approval.');
      } else {
        await api.wallet.withdraw(payload, initData);
        setMessage('Withdrawal request submitted — pending approval.');
      }
      haptic.success();
      setAmount('');
      setReference('');
    } catch (err) {
      setError(err.message);
      haptic.error();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page wallet-page">
      <header className="room-page__header">
        <button className="ghost-button" onClick={() => navigate('/')}>
          ← Lobby
        </button>
        <span className="room-page__code">Wallet</span>
      </header>

      <div className="wallet-balance-card">
        <span className="lobby__balance-label">Available balance</span>
        <span className="wallet-balance-card__amount">
          {balance === null ? '—' : `${balance.toFixed(2)} ETB`}
        </span>
      </div>

      <div className="wallet-tabs">
        <button className={mode === 'deposit' ? 'wallet-tab wallet-tab--active' : 'wallet-tab'} onClick={() => setMode('deposit')}>
          Deposit
        </button>
        <button className={mode === 'withdraw' ? 'wallet-tab wallet-tab--active' : 'wallet-tab'} onClick={() => setMode('withdraw')}>
          Withdraw
        </button>
      </div>

      <form className="wallet-form" onSubmit={handleSubmit}>
        <label className="wallet-form__label">
          Amount (ETB)
          <input
            type="number"
            min="1"
            step="0.01"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="wallet-form__input"
          />
        </label>
        <label className="wallet-form__label">
          {mode === 'deposit' ? 'Telebirr transaction reference' : 'Telebirr number to receive funds'}
          <input
            type="text"
            required
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="wallet-form__input"
          />
        </label>
        {mode === 'deposit' && (
          <p className="lobby__muted">
            Send the amount via Telebirr, then submit the transaction reference here for review.
          </p>
        )}
        {error && <p className="lobby__error">{error}</p>}
        {message && <p className="wallet-form__success">{message}</p>}
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? 'Submitting…' : `Request ${mode}`}
        </button>
      </form>

      <section className="wallet-history">
        <h2 className="lobby__section-title">Recent activity</h2>
        <ul className="wallet-history__list">
          {history.map((entry) => (
            <li key={entry.id} className="wallet-history__item">
              <span>{formatEntryType(entry.entry_type)}</span>
              <span className={Number(entry.amount) >= 0 ? 'wallet-history__amount--credit' : 'wallet-history__amount--debit'}>
                {Number(entry.amount) >= 0 ? '+' : ''}
                {Number(entry.amount).toFixed(2)}
              </span>
            </li>
          ))}
          {history.length === 0 && <p className="lobby__muted">No activity yet.</p>}
        </ul>
      </section>
    </div>
  );
}

function formatEntryType(type) {
  const labels = {
    deposit: 'Deposit',
    withdrawal: 'Withdrawal',
    withdrawal_reversal: 'Withdrawal reversed',
    room_stake: 'Table stake',
    room_payout: 'Table win',
    room_refund: 'Table refund',
    bonus: 'Bonus',
    adjustment: 'Adjustment',
  };
  return labels[type] || type;
}
