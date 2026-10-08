# June Pmini (lunar-wolf)

Minimal personal WhatsApp bot. **Two code files, zero commands.**

| Feature | What it does |
|---|---|
| **autoreact** | Reacts to every incoming message (random emoji pool, or a fixed one) |
| **antidelete** | Snapshots messages; when one is revoked it's recovered — to the original chat (`chat` mode) or your own DM (`private` mode). Media included for ~48h |
| **vv** | React to any view-once message from your own number (or an owner number) → the media is revealed into your own DM with a ✅ |

## Run

```bash
npm install
node index.js
```

First run prints a **QR** — scan it from WhatsApp → Linked devices.
Or `PHONE=2348012345678 node index.js` to get a **pairing code** instead.

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
