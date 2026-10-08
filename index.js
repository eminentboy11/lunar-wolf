/**
 * June Pmini — minimal personal WhatsApp bot.
 * Two files total: index.js (boot/auth/socket/store) + handler.js (the trio:
 * autoreact, antidelete, vv). No commands, no command loader, no utils.
 *
 * Run:  node index.js
 * Pair: scan the QR in the terminal, or set PHONE=234… (env or .env) for a
 *       pairing code. Config/data live in data/pmini.json — edit and restart.
 *
 * Panel-hosted (Pterodactyl/katabump) notes:
 *   - credentials live in ./session and settings in ./data — both survive a
 *     re-extract when the loader skips those directory names
 *   - the process never exits on connection drops; it reconnects with backoff
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const ROOT = __dirname;
const AUTH_DIR = path.join(ROOT, 'session');   // 'session' + 'data' survive repo-loader re-extracts
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pmini.json');

const log = (...a) => console.log('[Pmini]', ...a);

/* ── JSON store: owners, settings, antidelete history ─────────────────── */
const DEFAULTS = {
  owners: [],                 // phone numbers (digits) — seeded from OWNER_NUMBER env
  antideleteMode: 'private',  // 'chat' (reply in same chat) | 'private' (DM self) | 'off'
  autoReact: {
    enabled: true,
    target: 'both',           // 'dms' | 'groups' | 'both'
    random: true,             // random emoji from the pool in handler.js
    emoji: '🌪️',              // used when random = false
  },
  messages: {},               // antidelete history: chatId → msgId → entry
};

let saveTimer = null;
const store = {
  data: null,
  load() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      this.data = {
        ...DEFAULTS,
        ...parsed,
        autoReact: { ...DEFAULTS.autoReact, ...(parsed.autoReact || {}) },
        messages: parsed.messages || {},
      };
    } catch (_) {
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
    }
    // env owners always (re)seed — env is the source of truth for identity
    const envOwners = String(process.env.OWNER_NUMBER || '')
      .split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
    if (envOwners.length) this.data.owners = [...new Set([...envOwners])];
    this.save();
    return this.data;
  },
  save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
        fs.renameSync(tmp, DATA_FILE);
      } catch (e) {
        console.error('[Pmini] store save failed:', e.message);
      }
    }, 1500);
    saveTimer.unref?.();
  },
  flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 1));
    } catch (_) {}
  },
};

/* ── shared context handed to the handler ─────────────────────────────── */
const selfJid = (sock) => (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
const isOwner = (jid) => {
  const num = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return !!num && store.data.owners.includes(num);
};
const ctx = { store, isOwner, selfJid };
const handler = require('./handler');

/* ── boot ─────────────────────────────────────────────────────────────── */
let starting = false;
let retries = 0;

async function start() {
  if (starting) return;
  starting = true;
  try {
    store.load();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger()),
      },
      printQRInTerminal: false,
      browser: ['June Pmini', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger: silentLogger(),
    });
    starting = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr && !state.creds.registered) {
        const phone = String(process.env.PHONE || '').replace(/\D/g, '');
        if (phone) {
          try {
            const code = await sock.requestPairingCode(phone);
            log('─────────────────────────────────');
            log(`PAIRING CODE for +${phone}:`);
            log(`    ${String(code).match(/.{1,4}/g)?.join('-')}`);
            log('WhatsApp → Settings → Linked devices → Link with phone number');
            log('─────────────────────────────────');
          } catch (e) { log('pairing code failed:', e.message); }
        } else {
          try { require('qrcode-terminal').generate(qr, { small: true }); }
          catch (_) { log('QR (paste into any qr viewer):', qr); }
          log('or restart with PHONE=234xx… (env or .env) to use a pairing code');
        }
      }

      if (connection === 'open') {
        retries = 0;
        log('connected as', selfJid(sock));
        log('trio active: autoreact ✓  antidelete ✓ (' + store.data.antideleteMode + ')  vv ✓');
        if (!store.data.owners.length) log('tip: set OWNER_NUMBER=234xx… (env or .env) so your number can trigger vv');
        store.flush();
      }

      if (connection === 'connecting') retries = 0;

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
          log('logged out / banned — wiping credentials. Restart to pair again.');
          store.flush();
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          process.exit(1);
        }
        if (code === DisconnectReason.connectionReplaced || code === 440) {
          log('connection replaced (opened elsewhere) — stopping. Close the other session and restart.');
          store.flush();
          process.exit(0);
        }
        // every other close (incl. first-connect churn like 515): retry, STAY ALIVE
        retries++;
        const wait = Math.min(60_000, 3_000 * retries);
        log(`connection closed (${code ?? 'unknown'}) — reconnecting in ${wait / 1000}s`);
        // NOTE: no .unref() here — a detached timer would let the event loop
        // empty and the panel would mark the server offline.
        setTimeout(start, wait);
      }
    });

    sock.ev.on('messages.upsert', async ({ type, messages }) => {
      if (type !== 'notify') return; // ignore history/appends
      for (const msg of messages) {
        try { await handler.handleMessage(sock, msg, ctx); } catch (e) {
          console.error('[Pmini] handler error:', e.message);
        }
      }
    });

    sock.ev.on('messages.delete', async (item) => {
      const keys = Array.isArray(item) ? item : (item?.keys || []);
      try { await handler.handleDelete(sock, keys, ctx); } catch (e) {
        console.error('[Pmini] antidelete error:', e.message);
      }
    });

    // trim antidelete history periodically; persist on exit
    setInterval(() => handler.pruneHistory(ctx), 10 * 60 * 1000).unref?.();
    process.on('SIGINT', () => { log('bye'); store.flush(); process.exit(0); });
    process.on('SIGTERM', () => { store.flush(); process.exit(0); });
  } catch (e) {
    starting = false;
    console.error('[Pmini] start failed:', e.message, '— retrying in 15s');
    setTimeout(start, 15_000);
  }
}

// swallow pino-style noise without a real logger dependency
function silentLogger() {
  const noop = () => {};
  const l = { level: 'silent', log: noop, info: noop, error: noop, warn: noop, debug: noop, trace: noop, fatal: noop, child: () => l };
  return l;
}

// headless survival: never die on background errors
process.on('unhandledRejection', (e) => console.error('[Pmini] unhandled rejection:', e?.message || e));
process.on('uncaughtException', (e) => { console.error('[Pmini] uncaught exception:', e?.message || e); store.flush(); });

start().catch((e) => { console.error('[Pmini] fatal:', e); process.exit(1); });
