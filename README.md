# Aviator-Style Demo Website

A full-stack demo crash-multiplier game with user auth, wallet deposit/withdraw
requests, admin approval workflow, and a provably-fair, server-authoritative
game engine.

⚠️ **Important**: There is still no automated payment processor wired in.
Money moves via a **manual Telebirr workflow**:

- **Deposits**: the user sends Birr to the operator's Telebirr account
  outside this app, then submits the amount + Telebirr transaction reference
  here. An admin checks that reference against the real Telebirr business
  account and only then approves it, which credits the user's balance.
- **Withdrawals**: the user requests a withdrawal with their Telebirr phone
  number. An admin must **actually send the money via Telebirr first**, then
  approve the request here using the Telebirr reference from that transfer
  as proof. Approving debits the user's balance.

This means "approved" in the admin panel is meant to correspond to a real
transfer having happened — but the app itself does not call Telebirr's API
and cannot verify a reference automatically. The admin is the one verifying
deposits and initiating withdrawals by hand. Make sure your operational
process (who has admin access, how references get checked, what happens on a
disputed transaction) matches what your gambling license requires, since
this is now handling real user funds.

## Project structure

```
aviator-website/
├── frontend/
│   └── src/
│       ├── pages/          Login.jsx, Register.jsx, Dashboard.jsx, Aviator.jsx, Admin.jsx
│       ├── components/     Navbar.jsx, Wallet.jsx, GameBoard.jsx
│       ├── api.js
│       └── App.jsx
└── backend/
    └── src/
        ├── auth.js         (registration/login routes + JWT/bcrypt logic + auth middleware)
        ├── wallet.js       (deposit/withdraw requests + transaction history)
        ├── game.js         (provably-fair round engine + bet/cashout routes + Socket.IO)
        ├── admin.js         (user management + approve/reject transactions)
        ├── database.js     (Mongo connection + all Mongoose schemas)
        └── server.js       (Express app, security middleware, HTTP/HTTPS bootstrap)
```

## Prerequisites

- Node.js 18+
- MongoDB running locally (or a connection string to Atlas/other hosted Mongo)

## Backend setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env: set a real JWT_SECRET, your MONGO_URI, etc.
```

Start MongoDB locally if you don't already have it running, e.g.:

```bash
mongod --dbpath /path/to/your/db
```

Seed an initial admin account (reads SEED_ADMIN_* vars from .env):

```bash
npm run seed:admin
```

Run the backend:

```bash
npm run dev      # with nodemon auto-reload
# or
npm start
```

The API will be available at `http://localhost:5000/api`, and Socket.IO on
the same port.

## Frontend setup

```bash
cd frontend
npm install
cp .env.example .env
# Edit .env if your backend isn't on localhost:5000
npm run dev
```

The app will be available at `http://localhost:5173`.

## First run walkthrough

1. Start MongoDB, then the backend (`npm run dev` in `backend/`).
2. Run `npm run seed:admin` once to create an admin login (from `.env` values).
3. Start the frontend (`npm run dev` in `frontend/`).
4. Visit `http://localhost:5173`, register a normal user account.
5. Log in as the seeded admin (separate browser/incognito window) at the same
   URL, then visit `/admin` to see the admin panel.
6. As the normal user, send a test Telebirr payment (or use a placeholder
   reference while testing locally), then submit a deposit request from the
   Wallet card with the amount and that Telebirr reference.
7. As the admin, open "Pending Requests", verify the reference (in real use,
   check it against the real Telebirr business account), then click
   Approve and confirm the reference — this credits the user's balance.
8. Back as the user, place a bet in the Aviator game during the "Betting
   open" phase, then try to cash out before the plane crashes.
9. Try a withdrawal: submit a Telebirr phone number, then as the admin,
   actually send the funds via Telebirr (in production) before approving
   with that transfer's reference — this debits the user's balance.

## How the game logic works (server-authoritative)

All round state (betting window, multiplier ticks, crash point) lives in
`backend/src/game.js` and is broadcast to every connected client over
Socket.IO. The crash point for each round is:

1. Generated from a random 32-byte server seed **before** the round starts.
2. Only the SHA-256 hash of that seed is published up front (`server_seed_hash`).
3. After the round ends, the raw seed is revealed, so the crash point can be
   independently recomputed and verified (`GET /api/game/verify/:round_id`).

The client (`GameBoard.jsx`) never computes or predicts the crash point — it
only renders `round:betting` / `round:flying` / `round:tick` / `round:crashed`
events pushed from the server, and sends `place bet` / `cash out` intents back
to the API. All balance changes happen inside `game.js`'s route handlers
against the database, never trusting anything the client reports about the
outcome.

## Security features included

- Passwords hashed with bcrypt (configurable salt rounds via `.env`)
- JWT-based auth with expiry, `requireAuth` / `requireAdmin` middleware
- `express-validator` input validation on all mutating routes
- `express-rate-limit`: global API limiter, stricter limiter on auth routes,
  and on financial (deposit/withdraw) routes
- `helmet` for standard security headers, `cors` scoped to `CLIENT_ORIGIN`
- Centralized error handler that hides stack traces in production
- Admin routes gated behind both `requireAuth` and `requireAdmin`
- Deposits/withdrawals require explicit admin approval before balances move
- HTTPS-ready: `server.js` will start an HTTPS server directly if
  `SSL_KEY_PATH`/`SSL_CERT_PATH` are set, otherwise plain HTTP is expected to
  sit behind a reverse proxy (nginx/Caddy) doing TLS termination in
  production — set `TRUST_PROXY=1` in that case.

## Known limitations / what to add before any real deployment

- No real payment gateway integration — deposit/withdraw are just approval
  workflows around a fake balance.
- No KYC/age verification.
- No email verification or password-reset flow.
- No refresh-token rotation (JWTs are long-lived access tokens only).
- Single-process game state (`currentRound` in `game.js` is in-memory) — for
  horizontal scaling you'd move round state into Redis or a dedicated game
  service.
