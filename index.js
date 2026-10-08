/**
 * June Pmini — minimal personal WhatsApp bot.
 * Two files total: index.js (boot/auth/socket/store) + handler.js (the trio:
 * autoreact, antidelete, vv). No commands, no command loader, no utils.
 *
 * Run:  node index.js
 * Pair: scan the QR in the terminal, or set PHONE=234... for a pairing code.
 * Config/data live in data/pmini.json — edit by hand and restart.
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
const AUTH_DIR = path.join(ROOT, 'auth');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pmini.json');

const log = (...a) => console.log('[Pmini]', ...a);

/* ── JSON store: owners, settings, antidelete history ─────────────────── */
const DEFAULTS = {
  owners: [],                 // phone numbers (digits) — auto-seeded from OWNER_NUMBER env
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
async function start() {
  store.load();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, { level: 'silent', child: () => ({ level: 'silent', log: () => {} }) }),
    },
    printQRInTerminal: false,
    browser: ['June Pmini', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger: { level: 'silent', child: () => ({ level: 'silent', log: () => {} }), info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {}, fatal: () => {} },
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr && !state.creds.registered) {
      const phone = String(process.env.PHONE || '').replace(/\D/g, '');
      if (phone) {
        try {
          const code = await sock.requestPairingCode(phone);
          log(`pairing code for +${phone}:  ${code?.match(/.{1,4}/g)?.join('-')}`);
        } catch (e) { log('pairing code failed:', e.message); }
      } else {
        try { require('qrcode-terminal').generate(qr, { small: true }); }
        catch (_) { log('QR (paste into any qr viewer):', qr); }
        log('or restart with PHONE=234xx… to get a pairing code instead');
      }
    }

    if (connection === 'open') {
      log('connected as', selfJid(sock));
      log('trio active: autoreact ✓  antidelete ✓ (' + store.data.antideleteMode + ')  vv ✓');
      if (!store.data.owners.length) log('tip: set OWNER_NUMBER=234xx… so your reactions trigger vv');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
        log('logged out — wiping auth, restart to pair again');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        process.exit(1);
      }
      const wait = Math.min(30_000, 3_000 * Math.max(1, (start.retries = (start.retries || 0) + 1)));
      log(`connection closed (${code ?? 'unknown'}) — reconnecting in ${wait / 1000}s`);
      setTimeout(start, wait).unref?.();
    }
    if (connection === 'connecting') start.retries = 0;
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

  // trim antidelete history + persist on exit
  setInterval(() => handler.pruneHistory(ctx), 10 * 60 * 1000).unref?.();
  process.on('SIGINT', () => { log('bye'); store.flush(); process.exit(0); });
  process.on('SIGTERM', () => { store.flush(); process.exit(0); });
}

start().catch((e) => { console.error('[Pmini] fatal:', e); process.exit(1); });
