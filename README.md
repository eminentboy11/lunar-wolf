# June Pmini (lunar-wolf)

Minimal personal WhatsApp bot. **Two code files, zero commands.**

| Feature | What it does |
|---|---|
| **autoreact** | Reacts to every incoming message (random emoji pool, or a fixed one) |
| **antidelete** | Snapshots messages; when one is revoked it's recovered — to the original chat (`chat` mode) or your own DM (`private` mode). Media included for ~48h |
| **vv** | **Automatic**: every view-once from other people lands in your DM the moment it arrives. Manual fallbacks: react to it with any emoji, or reply `.vv`. Toggle with `.vv on\|off` |

## Run

```bash
npm install
node index.js
```

### Login — two ways

**1. June Session Server (no scanning, no codes):** put a June handle in the env and the bot pulls the session itself:

```
SESSION_ID=JUNE-X~yourhandle
```

On boot it fetches the session blob from the June server, stores it in `session/`, and connects. If the handle is revoked/unknown or the server is down, it falls back to manual pairing automatically. Once `session/creds.json` exists, the local session is used (no re-fetch) until it logs out.

**2. Manual pairing:** first run prints a **QR** — scan from WhatsApp → Linked devices. Or set `PHONE=2348012345678` for a **pairing code** instead (one code per 90s window, so it can't be rotated out from under you).

Optional: `OWNER_NUMBER=2348012345678` (comma-separate several) — seeds the owners list; your own linked number always counts for vv via fromMe.

## Panel hosting (Pterodactyl / katabump)

Works behind a repo-loader (download zip → extract → run) with **no loader changes**:

- Credentials are stored in **`session/`** and settings in **`data/`** — add both names to the loader's skip list (the usual June loader already skips `session` and `data`), so re-extraction never wipes the login.
- The bot **never exits on connection drops** — it reconnects with backoff, so the panel keeps it "online".
- Dependencies resolve from a `node_modules` at the panel root (require walks up from the extracted folder), or commit `node_modules` into your zip if the host doesn't install.
- Pair on a headless panel: put `PHONE=2348012345678` in the panel `.env` (the loader injects it), restart, then read the **PAIRING CODE** from the console: WhatsApp → Linked devices → Link with phone number.

Example panel `.env`:

```
PHONE=2348012345678
OWNER_NUMBER=2348012345678
```

## Owner commands

Hardcoded, owner-only (your number / `OWNER_NUMBER` / fromMe), prefix `.` — no commands folder, no loader:

| Command | Effect |
|---|---|
| `.antidelete` | show mode · `.antidelete chat\|private\|off` to switch (saved live) |
| `.autoreact` | show state · `.autoreact on\|off` · `.autoreact dms\|groups\|both` · `.autoreact random` · `.autoreact fixed <emoji>` |
| `.vv` | reply to a view-once → revealed into your DM · `.vv on\|off` toggles automatic mode |

Unknown `.` commands are ignored. Non-owners are ignored completely.

## Config — `data/pmini.json`

Edit by hand and restart (the file is created on first run):

```json
{
  "owners": ["2348012345678"],
  "antideleteMode": "private",   // "chat" | "private" | "off"
  "autoReact": {
    "enabled": true,
    "target": "both",            // "dms" | "groups" | "both"
    "random": true,              // false → use the fixed emoji below
    "emoji": "🌪️"
  }
}
```

## Files

```
index.js    boot, pairing, socket, reconnect, JSON store
handler.js  the trio: autoreact + antidelete + vv
auth/       WhatsApp credentials (auto-created, git-ignored)
data/       pmini.json — settings + antidelete history (git-ignored)
```

That's the whole bot. No commands folder, no utils, no database server, no deploy files — `node index.js` and you're live.
