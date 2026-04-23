# BoxCast

A real-time collaborative grid where everyone sees the same wall of boxes — and every person gets their own color.

Open it on two tabs. Click a box. Watch it light up on the other screen instantly.

---

## What it does

- Everyone connected sees the same grid of boxes
- Click a box to toggle it on/off
- Each user gets a unique muted color — boxes stay colored by whoever last touched them
- New users joining see the current state of the wall immediately
- If you disconnect, it reconnects automatically

---

## Stack

- **Node.js + Express** — serves the static files
- **WebSocket (ws)** — real-time sync between all clients
- No database. No framework. No build step.

---

## Run locally

```bash
npm install
TOTAL_BOXES=500 npm start
```

Then open `http://localhost:3000`

Or create a `.env` file:
```
TOTAL_BOXES = 500
```
and run with:
```bash
node --env-file=.env server.js
```

---

## Config

| Variable | What it does | Default |
|---|---|---|
| `TOTAL_BOXES` | Number of boxes in the grid | `2610` |
| `--box-size` in `style.css` | Size of each box | `2.7rem` |

---

## Deploy

Tested on [Render](https://render.com).

- Build command: `npm install`
- Start command: `npm start`
- Add `TOTAL_BOXES` as an environment variable

---

## How it works (short version)

The server holds two arrays — which boxes are on/off, and what color each box is. When you click a box, a tiny event is sent to the server, which forwards it to everyone else. All the visual work happens on the client. The server just passes messages.

```
you click → server broadcasts → everyone updates
```
