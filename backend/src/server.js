require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');

const { RoomManager, registerSocketHandlers } = require('./gameEngine');
const { createRoomsRouter, walletRouter, adminRouter } = require('./routes');
const { ensureSeedAdmin } = require('./auth');

const PORT = process.env.PORT || 8080;
// CLIENT_ORIGIN matches the env var name used in your other project.
const CORS_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// The Mini App URL is your frontend's own deployed URL (CLIENT_ORIGIN
// serves that purpose here too — the bot needs it to build the button).
const MINI_APP_URL = process.env.MINI_APP_URL || process.env.CLIENT_ORIGIN;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const app = express();
const server = http.createServer(app);

if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Shared game state manager — owns all live rooms.
const roomManager = new RoomManager(io);

app.use('/api/rooms', createRoomsRouter(roomManager));
app.use('/api/wallet', walletRouter);
app.use('/api/admin', adminRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Central error handler — catches anything a route forgot to try/catch.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
});

registerSocketHandlers(io, roomManager);

/**
 * ===========================================================================
 * TELEGRAM BOT
 * ===========================================================================
 * Its only real job is to greet the user and hand them a button that
 * opens the Mini App. All actual gameplay happens inside the Mini App
 * itself, not through bot commands.
 * ===========================================================================
 */
function createBot() {
  if (!BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN not set — bot will not start. Set it to enable Telegram bot features.');
    return null;
  }

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome to Bingo! Tap below to play.', {
      reply_markup: { inline_keyboard: [[{ text: '🎱 Play Bingo', web_app: { url: MINI_APP_URL } }]] },
    });
  });

  bot.onText(/\/balance/, (msg) => {
    // Kept simple — full balance lookup happens inside the Mini App where
    // the user is properly authenticated via initData. A bot command
    // can't safely verify identity the same way, so we just redirect.
    bot.sendMessage(msg.chat.id, 'Open the app to check your balance and play.', {
      reply_markup: { inline_keyboard: [[{ text: '🎱 Open Bingo', web_app: { url: MINI_APP_URL } }]] },
    });
  });

  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));

  console.log('Telegram bot started (polling mode)');
  return bot;
}

async function start() {
  await ensureSeedAdmin();

  server.listen(PORT, () => {
    console.log(`Bingo backend listening on port ${PORT}`);
    createBot();
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
