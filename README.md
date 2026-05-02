# BoxCast

A real-time collaborative checkbox grid. Every connected user sees the same wall of boxes - click one and it lights up for everyone instantly.

**Demo video:** https://youtu.be/PqxEnsy6eI0

**Live Link:** https://boxcast.sudohq.me

---

<table>
  <tr>
    <td><img width="350" height="196" alt="image" src="https://github.com/user-attachments/assets/a95f7f26-cc3a-4944-92fa-d85ae2e2f528" /></td>
    <td><img width="350" height="196" alt="image" src="https://github.com/user-attachments/assets/c70aa015-2b1b-4088-aa85-5fba0726d451" /></td>
    <td><img width="350" height="196" alt="image" src="https://github.com/user-attachments/assets/af3b17b2-745b-4c50-8fd8-6d8635335064" /></td>
  </tr>
</table>


## Features

- Up to **1,000,000** checkboxes, lazy-loaded in chunks via infinite scroll
- Real-time sync across all clients via Socket.IO
- Each user gets a unique color; boxes remember who last touched them
- Leaderboard with live scores (+10 / -10 per toggle)
- Guest and authenticated sessions - log in mid-session without losing score
- OAuth 2.0 / JWT auth with refresh token rotation (client secret stays server-side)
- Custom rate limiting on WebSocket toggle events - no external package
- Redis bitfield for state, Pub/Sub for multi-instance broadcasting
- Auto-reconnect; full state restored on reconnect

---

## Quick Start

**Prerequisites:** Node.js 18+, Redis

```bash
# Start Redis (Docker)
docker compose up -d

# Install and run
npm install
cp .env.example .env   # fill in your values
node --env-file=.env server.js
```

Open `http://localhost:3000`

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `TOTAL_BOXES` | Number of boxes in the grid | `1000000` |
| `CHUNK_SIZE` | Boxes loaded per scroll event | `1500` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `AUTH_API` | Base URL of the OAuth server | - |
| `AUTH_CLIENT_ID` | OAuth client ID | - |
| `AUTH_CLIENT_SECRET` | OAuth client secret (never sent to client) | - |

---

## Architecture

### Checkbox State (Core Functionality)

State lives in Redis, not in server memory. On connect the server sends the first 1500 toggled boxes; the client lazy-loads the rest as the user scrolls using `IntersectionObserver`.

- **`boxes:state`** - Redis bitfield, 1 bit per box. 1,000,000 boxes = ~125 KB.
- **`boxes:colors`** - Redis hash, index → hex color. Only set for toggled boxes.

The client stores state sparsely (`{ [index]: { value, color } }`) - not a 1M-element array. DOM updates only touch the specific element that changed.

On page reload the server re-sends current state from Redis, so nothing is lost.

### WebSocket Implementation

Socket.IO handles all real-time communication. Events:

| Event | Direction | Purpose |
|---|---|---|
| `init` | server → client | First chunk, total count, user color, score |
| `fetch-chunk` | client → server | Request next chunk by start index |
| `chunk` | server → client | Sparse toggled boxes for that range |
| `toggle` | client → server | Toggle a box |
| `update` | server → all | Broadcast toggle to every connected client |
| `score` | server → client | Updated score |
| `leaderboard` | server → all | Top-10 + online list (debounced, max 1/500ms) |
| `auth` | client → server | Send JWT after login (mid-session upgrade) |
| `auth-invalid` | server → client | Token rejected; client refreshes and retries |
| `client-count` | server → all | Live connection count |

On `toggle`: server writes to Redis, publishes to the Pub/Sub channel, and the subscriber forwards it to all Socket.IO clients. Connection and disconnection are both handled - scores and display names are cleaned up on disconnect.

### Redis Usage

Redis is used for three distinct purposes, each necessary:

1. **State persistence** - bitfield + colors hash survive server restarts and are shared across instances.
2. **Leaderboard** - sorted set (`leaderboard`) for O(log N) score updates and top-10 queries; hash (`highscores`) for all-time bests per user.
3. **Pub/Sub** - the `boxes:updates` channel lets any server instance publish a toggle and have every other instance broadcast it to its own clients. Without this, users on different instances would not see each other's updates.

A separate `ioredis` connection is used for subscribing (Redis requires a dedicated connection for Pub/Sub).

Redis key naming:

| Key | Type | Purpose |
|---|---|---|
| `boxes:state` | Bitfield | On/off state for all boxes |
| `boxes:colors` | Hash | Color per toggled box |
| `leaderboard` | Sorted set | Live scores |
| `highscores` | Hash | All-time high scores per user |
| `displaynames` | Hash | Display name per user/guest ID |

### Custom Rate Limiting

Implemented manually in `server.js` - no `express-rate-limit` or similar package.

Each socket has a counter and a window start timestamp. On every `toggle` event:

```
if (now - windowStart > WINDOW_MS) reset counter and window
if (counter >= MAX_EVENTS) drop the event (silent)
else increment counter and process
```

- Window: 1 second
- Limit: 10 toggle events per second per socket
- Keyed by socket ID (not IP) since all real-time actions go through authenticated sockets

This prevents event spam without adding middleware dependencies.

### Authentication (OAuth 2.0)

Flow:

1. User submits credentials → client POSTs to the auth server
2. Auth server returns `accessToken` (JWT) + `refreshToken`
3. Access token is passed in the Socket.IO `auth` handshake on connect
4. Server calls `/auth/verify` on the auth server to validate the JWT
5. When the token expires, the client calls `/refresh` on **this** server - a proxy that adds `client_secret` server-side before forwarding to the auth server
6. If a guest logs in mid-session, their score carries over via the `auth` socket event

Guests can use the app fully; authenticated users get persistent high scores. Protected socket actions (toggle, leaderboard entry) work for both.

### Frontend

- Boxes rendered in chunks using `DocumentFragment` - no layout thrashing
- `IntersectionObserver` with 200px root margin triggers the next chunk before the user hits the bottom
- Optimistic updates: the clicking user sees the change and score update immediately, before server confirmation
- Jittered emit delay (`Math.random() * min(clientCount * 2, 2000)` ms) reduces thundering-herd on the server under high concurrency
- Per-box client-side throttle (300ms) prevents double-clicks from spamming the server

---

## Project Structure

```
server.js           Express + Socket.IO, Redis state, auth, rate limiting, leaderboard
script.js           Client JS: socket, chunked rendering, auth UI, optimistic updates
index.html          App shell: grid, sidebar, login/signup modals
style/
  style.css         Grid layout, box styles, responsive layout
  login.css         Auth modal styles
docker-compose.yml  Redis for local development
.env.example        Environment variable template
```

---

## Deploy (Render)

- Build command: `npm install`
- Start command: `npm start`
- Set all env vars from the table above
- Provision a Redis instance and set `REDIS_URL`

Multiple instances work out of the box - Redis Pub/Sub keeps them in sync.

---

## System Design Notes

**Why Redis bitfield?** A 1M-boolean array as JSON is ~1 MB. A bitfield is ~125 KB and supports atomic single-bit reads/writes. It also makes chunked reads trivial: `BITFIELD boxes:state GET u1 <offset>` repeated in a pipeline.

**Why Pub/Sub?** Socket.IO's in-process broadcast only reaches clients on the same server instance. Pub/Sub decouples the broadcaster from the receivers - any instance can publish, all instances deliver.

**Why custom rate limiting?** The window-counter approach is the standard pattern: track (counter, windowStart) per identity, reset on window expiry, reject when over limit. It's ~10 lines and has no external dependencies.

**Why sparse client state?** Most boxes are off. A plain object keyed by index uses memory proportional to toggled boxes, not total boxes. Lookups are O(1) and iteration only touches what's set.
