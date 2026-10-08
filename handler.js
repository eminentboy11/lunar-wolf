/**
 * June Pmini — handler.js
 * The trio, hardcoded. No commands, no loader.
 *
 *   vv         — react (any emoji) to a view-once as the owner → media lands in your own DM
 *   antidelete — every message is snapshotted; when revoked it is recovered to the
 *                original chat (mode 'chat') or to your own DM (mode 'private')
 *   autoreact  — every incoming message gets a reaction (config in data/pmini.json)
 */
'use strict';

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const EMOJIS = ['🌪️', '⚡', '🔥', '💯', '🎉', '😎', '🤖', '🌟', '✨', '💫', '🙃', '🚀'];
const MEDIA_MAP = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', stickerMessage: 'sticker', documentMessage: 'document' };
const HISTORY_TTL = 48 * 60 * 60 * 1000;   // 48h antidelete history
const MAX_PER_CHAT = 200;
const VO_TTL = 10 * 60 * 1000;             // view-once reaction window

const log = (...a) => console.log('[Pmini]', ...a);

/* ── generic helpers (inlined — no utils folder) ──────────────────────── */
const digits = (v) => String(v || '').split('@')[0].split(':')[0].replace(/\D/g, '');

function unwrap(raw) {
  let m = raw;
  for (let i = 0; i < 5 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessage?.message ||
      m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m || {};
}

// revive {type:'Buffer',data:[…]} produced by JSON round-trips back into Buffers
function reviveBuffers(value) {
  if (Array.isArray(value)) return value.map(reviveBuffers);
  if (value && typeof value === 'object' && !(value instanceof Buffer)) {
    if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    for (const k of Object.keys(value)) value[k] = reviveBuffers(value[k]);
  }
  return value;
}

function snapshotMedia(inner) {
  // cycle-proof copy of the media content needed by downloadContentFromMessage
  try { return JSON.parse(JSON.stringify(inner)); } catch (_) {
    const m = Object.keys(inner || {})[0];
    const c = (m && inner[m]) || {};
    return { [m || 'unknown']: { mimetype: c.mimetype, caption: c.caption, url: c.url, directPath: c.directPath, mediaKey: c.mediaKey, ptt: c.ptt, fileName: c.fileName } };
  }
}

async function downloadMedia(content, kind) {
  const chunks = [];
  const stream = await downloadContentFromMessage(content, kind);
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/* ── vv: view-once cache + reveal ─────────────────────────────────────── */
const voCache = new Map(); // msgId → { msg, expires }
function cacheViewOnce(msg) {
  const raw = msg.message || {};
  const isVO =
    !!raw.viewOnceMessageV2Extension || !!raw.viewOnceMessageV2 || !!raw.viewOnceMessage ||
    !!raw.ephemeralMessage?.message?.viewOnceMessageV2 ||
    raw.imageMessage?.viewOnce || raw.videoMessage?.viewOnce || raw.audioMessage?.viewOnce;
  if (!isVO || !msg.key?.id) return;
  if (voCache.size % 20 === 0) { const now = Date.now(); for (const [k, v] of voCache) if (v.expires < now) voCache.delete(k); }
  voCache.set(msg.key.id, { msg, expires: Date.now() + VO_TTL });
}

async function revealVo(sock, originalMsg, targetJid) {
  let raw = originalMsg.message || {};
  if (raw.ephemeralMessage?.message) raw = raw.ephemeralMessage.message;
  const WRAPPERS = ['viewOnceMessageV2Extension', 'viewOnceMessageV2', 'viewOnceMessage'];
  let content = null, kind = null, mtype = null;
  for (const w of WRAPPERS) {
    const inner = raw[w]?.message;
    if (inner) {
      mtype = Object.keys(inner).find(k => MEDIA_MAP[k]);
      if (mtype) { content = inner[mtype]; kind = MEDIA_MAP[mtype]; break; }
    }
  }
  if (!content) { // direct viewOnce flag on a bare media message
    for (const [mt, k] of Object.entries(MEDIA_MAP)) {
      if (raw[mt]?.viewOnce) { content = { ...raw[mt], viewOnce: false }; mtype = mt; kind = k; break; }
    }
  }
  if (!content) return false;
  const caption = content.caption || '';
  if (kind === 'image') await sock.sendMessage(targetJid, { image: await downloadMedia(content, kind), caption: caption || '🖼️ view-once' });
  else if (kind === 'video') await sock.sendMessage(targetJid, { video: await downloadMedia(content, kind), caption: caption || '🎬 view-once' });
  else if (kind === 'audio') await sock.sendMessage(targetJid, { audio: await downloadMedia(content, kind), ptt: content.ptt === true });
  else if (kind === 'sticker') await sock.sendMessage(targetJid, { sticker: await downloadMedia(content, kind) });
  else await sock.sendMessage(targetJid, { document: await downloadMedia(content, kind), fileName: content.fileName || 'file', caption: caption || '📄 view-once' });
  return true;
}

/* ── antidelete: snapshot + recover ───────────────────────────────────── */
function storeForAntidelete(ctx, msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast' || !msg.key.id) return;
  const inner = unwrap(msg.message);
  const mtype = Object.keys(MEDIA_MAP).find(k => inner[k]);
  const text = inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption ||
    inner.videoMessage?.caption || inner.documentMessage?.caption || null;
  if (!text && !mtype) return;
  const entry = {
    t: Date.now(),
    sender: msg.key.participant || chatId,
    type: mtype ? MEDIA_MAP[mtype] : 'text',
    text: text || null,
    media: mtype ? snapshotMedia({ [mtype]: inner[mtype] }) : null,
  };
  const store = ctx.store;
  (store.data.messages[chatId] = store.data.messages[chatId] || {})[msg.key.id] = entry;
  const chat = store.data.messages[chatId];
  const ids = Object.keys(chat);
  if (ids.length > MAX_PER_CHAT) {
    ids.sort((a, b) => chat[a].t - chat[b].t);
    for (const id of ids.slice(0, ids.length - MAX_PER_CHAT)) delete chat[id];
  }
  store.save();
}

function pruneHistory(ctx) {
  const msgs = ctx.store.data.messages;
  const cutoff = Date.now() - HISTORY_TTL;
  let total = 0;
  for (const chatId of Object.keys(msgs)) {
    for (const id of Object.keys(msgs[chatId])) {
      if ((msgs[chatId][id].t || 0) < cutoff) delete msgs[chatId][id];
    }
    if (!Object.keys(msgs[chatId]).length) delete msgs[chatId];
    else total += Object.keys(msgs[chatId]).length;
  }
  ctx.store.save();
  return total;
}

function header(entry, chatLabel) {
  const time = new Date(entry.t || Date.now()).toLocaleString('en-GB', { hour12: false });
  const who = digits(entry.sender) || 'unknown';
  return `🗑️ *Deleted message recovered*\n👤 @${who}\n🕐 ${time}${chatLabel ? `\n📍 ${chatLabel}` : ''}\n━━━━━━━━━━━━`;
}

async function recoverEntry(sock, ctx, entry, chatLabel, target) {
  const mentions = entry.sender ? [entry.sender] : [];
  const head = header(entry, chatLabel);
  if (entry.type === 'text') {
    await sock.sendMessage(target, { text: `${head}\n📝 ${entry.text}`, mentions });
    return;
  }
  const inner = reviveBuffers(entry.media) || {};
  const mtype = Object.keys(MEDIA_MAP).find(k => inner[k]);
  if (!mtype) return;
  const content = inner[mtype];
  const kind = MEDIA_MAP[mtype];
  let buffer = null;
  try { buffer = await downloadMedia(content, kind); } catch (_) {}
  const caption = `${head}${entry.text ? `\n📝 ${entry.text}` : ''}`;
  if (!buffer) { await sock.sendMessage(target, { text: `${head}\n⚠️ media expired (CDN link gone)`, mentions }); return; }
  if (kind === 'image') await sock.sendMessage(target, { image: buffer, caption, mentions });
  else if (kind === 'video') await sock.sendMessage(target, { video: buffer, caption, mentions });
  else if (kind === 'audio') { await sock.sendMessage(target, { audio: buffer, ptt: content.ptt === true }); await sock.sendMessage(target, { text: head, mentions }); }
  else if (kind === 'sticker') { await sock.sendMessage(target, { sticker: buffer }); await sock.sendMessage(target, { text: head, mentions }); }
  else await sock.sendMessage(target, { document: buffer, mimetype: content.mimetype || 'application/octet-stream', fileName: content.fileName || 'file', caption, mentions });
}
async function handleDelete(sock, keys, ctx) {
  const mode = ctx.store.data.antideleteMode;
  if (!keys?.length || mode === 'off') return;
  for (const key of keys) {
    const chatId = key.remoteJid;
    if (!chatId || chatId === 'status@broadcast' || !key.id) continue;
    const entry = ctx.store.data.messages[chatId]?.[key.id];
    if (!entry) continue;
    delete ctx.store.data.messages[chatId][key.id];
    const target = mode === 'chat' ? chatId : ctx.selfJid(sock);
    let label = '';
    if (mode === 'private' && chatId !== target) label = chatId.endsWith('@g.us') ? 'group chat' : `DM ${digits(chatId)}`;
    try { await recoverEntry(sock, ctx, entry, label, target); } catch (e) { log('recover failed:', e.message); }
  }
  ctx.store.save();
}

/* ── main entry ───────────────────────────────────────────────────────── */
async function handleMessage(sock, msg, ctx) {
  if (!msg.message || !msg.key?.id) return;

  // LID DM fix — @lid jids need remoteJidAlt to actually reply
  let from = msg.key.remoteJid;
  if (!from.endsWith('@g.us') && from.endsWith('@lid') && msg.key.remoteJidAlt) from = msg.key.remoteJidAlt;
  if (from === 'status@broadcast') return;

  const isGroup = from.endsWith('@g.us');

  // ── vv trigger: owner reacts to a cached view-once ─────────────────────
  if (msg.message.reactionMessage) {
    const rx = msg.message.reactionMessage;
    const sender = msg.key.fromMe ? ctx.selfJid(sock) : (msg.key.participant || from);
    if (rx.text && (msg.key.fromMe || ctx.isOwner(sender))) {
      const cached = rx.key?.id ? voCache.get(rx.key.id) : null;
      if (cached && cached.expires > Date.now()) {
        const ok = await revealVo(sock, cached.msg, ctx.selfJid(sock)).catch(() => false);
        if (ok) await sock.sendMessage(from, { react: { text: '✅', key: msg.key } }).catch(() => {});
      }
    }
    return; // reactions never need anything else
  }

  cacheViewOnce(msg);
  storeForAntidelete(ctx, msg);

  // ── autoreact ──────────────────────────────────────────────────────────
  try {
    const ar = ctx.store.data.autoReact;
    const targetOk = ar.target === 'both' || (ar.target === 'groups' && isGroup) || (ar.target === 'dms' && !isGroup);
    if (ar.enabled && !msg.key.fromMe && targetOk) {
      const emoji = ar.random ? EMOJIS[Math.floor(Math.random() * EMOJIS.length)] : (ar.emoji || EMOJIS[0]);
      await sock.sendMessage(from, { react: { text: emoji, key: msg.key } });
    }
  } catch (e) { log('autoreact failed:', e.message); }
}

module.exports = { handleMessage, handleDelete, pruneHistory };
