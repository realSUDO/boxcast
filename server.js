import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import Redis from "ioredis";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const TOTAL_BOXES = parseInt(process.env.TOTAL_BOXES) || 1_000_000;
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE) || 1500;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const AUTH_API = process.env.AUTH_API || "http://52.172.129.58";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(__dirname, {
	setHeaders: (res, filePath) => {
		if (filePath.endsWith(".js"))  res.setHeader("Content-Type", "application/javascript");
		if (filePath.endsWith(".css")) res.setHeader("Content-Type", "text/css");
	}
}));

app.use(express.json());

// Proxy refresh — keeps client_secret server-side
app.post("/refresh", async (req, res) => {
	const { refresh_token } = req.body;
	if (!refresh_token) return res.status(400).json({ error: "refresh_token required" });
	try {
		const r = await fetch(`${AUTH_API}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token,
				client_id: process.env.AUTH_CLIENT_ID,
				client_secret: process.env.AUTH_CLIENT_SECRET,
			}),
		});
		const data = await r.json();
		res.status(r.status).json(data);
	} catch (e) {
		console.error(`[refresh] error:`, e.message);
		res.status(500).json({ error: "refresh failed" });
	}
});

const redis = new Redis(REDIS_URL);
const sub   = new Redis(REDIS_URL);

const CHANNEL   = "boxes:updates";
const LEADERBOARD_KEY = "leaderboard";
const HIGHSCORE_KEY   = "highscores"; // Hash: userId → score

// ----------------------- Color generation -----------------------

let colorIndex = 0;
function generateUserColor() {
	const hue = (colorIndex * 137.5) % 360;
	colorIndex++;
	const s = 30 + (colorIndex % 3) * 5;
	const l = 78 + (colorIndex % 3) * 3;
	return hslToHex(hue, s, l);
}

function hslToHex(h, s, l) {
	s /= 100; l /= 100;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => {
		const k = (n + h / 30) % 12;
		const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
		return Math.round(255 * color).toString(16).padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

// ----------------------- Auth verification -----------------------

async function verifyToken(token) {
	try {
		const res = await fetch(`${AUTH_API}/auth/verify`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const data = await res.json();
		if (data.valid) return data.decoded;
	} catch {}
	return null;
}

function truncate(str, max = 7) {
	return str.length > max ? str.slice(0, max) : str;
}

// ----------------------- Redis helpers -----------------------

async function fetchChunk(start, end) {
	const count = end - start;
	const cmds = [];
	for (let i = start; i < end; i++) cmds.push("GET", "u1", i);
	const values = await redis.bitfield("boxes:state", ...cmds);

	const toggledIndices = [];
	for (let i = 0; i < count; i++) {
		if (values[i] === 1) toggledIndices.push(start + i);
	}
	if (toggledIndices.length === 0) return [];

	const pipeline = redis.pipeline();
	for (const idx of toggledIndices) pipeline.hget("boxes:colors", String(idx));
	const colors = await pipeline.exec();

	return toggledIndices.map((idx, i) => ({ index: idx, color: colors[i][1] }));
}

async function setBox(index, value, color) {
	await redis.bitfield("boxes:state", "SET", "u1", index, value);
	if (value === 1) {
		await redis.hset("boxes:colors", String(index), color);
	} else {
		await redis.hdel("boxes:colors", String(index));
	}
}

// ----------------------- Score / Leaderboard -----------------------

// On startup: remove all guest entries (they're session-only)
async function cleanGuestEntries() {
	const all = await redis.zrange(LEADERBOARD_KEY, 0, -1);
	const guests = all.filter(id => id.startsWith("guest_"));
	if (guests.length) {
		await redis.zrem(LEADERBOARD_KEY, ...guests);
		await redis.hdel(NAMES_KEY, ...guests);
	}
}
cleanGuestEntries().catch(console.error);

async function updateScore(socket, delta) {
	socket.liveScore = Math.max(0, (socket.liveScore || 0) + delta);
	const id = socket.userId || socket.guestId;

	// Update leaderboard sorted set
	await redis.zadd(LEADERBOARD_KEY, socket.liveScore, id);

	// Update high score for logged-in users
	if (socket.userId) {
		const current = parseInt(await redis.hget(HIGHSCORE_KEY, socket.userId) || "0");
		if (socket.liveScore > current) {
			await redis.hset(HIGHSCORE_KEY, socket.userId, socket.liveScore);
		}
	}

	scheduleLeaderboardBroadcast();
}

const NAMES_KEY = "displaynames"; // Hash: id → displayName
const displayNames = new Map(); // in-memory cache

async function setDisplayName(id, name) {
	displayNames.set(id, name);
	await redis.hset(NAMES_KEY, id, name);
}

async function removeDisplayName(id) {
	displayNames.delete(id);
	await redis.hdel(NAMES_KEY, id);
}

async function getLeaderboard() {
	const raw = await redis.zrevrange(LEADERBOARD_KEY, 0, 9, "WITHSCORES");
	const entries = [];
	for (let i = 0; i < raw.length; i += 2) {
		entries.push({ id: raw[i], score: parseInt(raw[i + 1]) });
	}
	if (!entries.length) return [];

	// Batch fetch names
	const pipeline = redis.pipeline();
	for (const e of entries) pipeline.hget(NAMES_KEY, e.id);
	const names = await pipeline.exec();

	return entries.map((e, i) => ({
		id: e.id,
		name: names[i][1] || displayNames.get(e.id) || e.id.slice(0, 7),
		score: e.score,
	}));
}

// Set of currently connected IDs
const onlineIds = new Set();

// Debounced leaderboard broadcast (max once per 500ms)
let leaderboardTimer = null;
function scheduleLeaderboardBroadcast() {
	if (leaderboardTimer) return;
	leaderboardTimer = setTimeout(async () => {
		leaderboardTimer = null;
		const board = await getLeaderboard();
		io.emit("leaderboard", { board, online: [...onlineIds] });
	}, 500);
}

// ----------------------- Client count -----------------------

let clientCount = 0;
function broadcastClientCount() {
	io.emit("client-count", clientCount);
}

// ----------------------- Redis pub/sub -----------------------

sub.subscribe(CHANNEL, (err) => {
	if (err) console.error("Redis subscribe error:", err);
});

sub.on("message", (channel, message) => {
	if (channel !== CHANNEL) return;
	io.emit("update", JSON.parse(message));
});

// ----------------------- socket.io -----------------------

io.on("connection", async (socket) => {
	clientCount++;
	broadcastClientCount();

	socket.liveScore = 0;
	socket.userColor = generateUserColor();

	const token = socket.handshake.auth?.token;

	if (token) {
		const decoded = await verifyToken(token);
		if (decoded) {
			socket.userId = decoded.sub;
			let rawName = decoded.email?.split("@")[0] || "user";
			try {
				const r = await fetch(`${AUTH_API}/oauth/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
				const info = await r.json();
				rawName = info.name || info.email?.split("@")[0] || rawName;
			} catch (e) {
				console.error(`[connect] userinfo failed:`, e.message);
			}
			socket.displayName = truncate(rawName);
			// liveScore starts at 0 each session — it's volatile
			socket.liveScore = 0;
			const hs = parseInt(await redis.hget(HIGHSCORE_KEY, socket.userId) || "0");
		} else {
			socket.emit("auth-invalid");
		}
	}

	if (!socket.userId) {
		socket.guestId = `guest_${socket.id.slice(0, 6)}`;
		socket.displayName = `Guest#${socket.id.slice(0, 4)}`;
	}

	const id = socket.userId || socket.guestId;
	await setDisplayName(id, socket.displayName);
	await redis.zadd(LEADERBOARD_KEY, socket.liveScore, id);
	onlineIds.add(id);
	scheduleLeaderboardBroadcast();

	// Send first chunk + initial score
	const firstChunk = await fetchChunk(0, Math.min(CHUNK_SIZE, TOTAL_BOXES));
	socket.emit("init", {
		totalBoxes: TOTAL_BOXES,
		chunkSize: CHUNK_SIZE,
		yourColor: socket.userColor,
		chunk: firstChunk,
		score: socket.liveScore,
	});

	// Guest → auth merge (user logs in mid-session)
	socket.on("auth", async ({ token }) => {
		const decoded = await verifyToken(token);
		if (!decoded) {
			socket.emit("auth-invalid");
			return;
		}

		const oldId = socket.guestId || socket.userId;
		const guestScore = socket.liveScore;

		socket.userId = decoded.sub;
		// Fetch full name from userinfo
		let rawName = decoded.email?.split("@")[0] || "user";
		try {
			const r = await fetch(`${AUTH_API}/oauth/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
			const info = await r.json();
			rawName = info.name || info.email?.split("@")[0] || rawName;
		} catch {}
		socket.displayName = truncate(rawName);
		socket.guestId = null;

		// Remove guest entry, add user entry with merged score
		if (oldId !== socket.userId) {
			await redis.zrem(LEADERBOARD_KEY, oldId);
			await removeDisplayName(oldId);
			onlineIds.delete(oldId);
			onlineIds.add(socket.userId);
		}

		// liveScore carries over from guest session
		// highScore updated only if guestScore beats it
		const hs = parseInt(await redis.hget(HIGHSCORE_KEY, socket.userId) || "0");
		socket.liveScore = guestScore; // live score = what they earned this session
		if (guestScore > hs) {
			await redis.hset(HIGHSCORE_KEY, socket.userId, guestScore);
		}

		await setDisplayName(socket.userId, socket.displayName);
		await redis.zadd(LEADERBOARD_KEY, socket.liveScore, socket.userId);
		scheduleLeaderboardBroadcast();

		socket.emit("score", socket.liveScore);
	});

	socket.on("fetch-chunk", async ({ start }) => {
		const end = Math.min(start + CHUNK_SIZE, TOTAL_BOXES);
		const chunk = await fetchChunk(start, end);
		socket.emit("chunk", { start, chunk });
	});

	socket.on("toggle", async ({ index, value }) => {
		await setBox(index, value, socket.userColor);
		const delta = value === 1 ? 10 : -10;
		await updateScore(socket, delta);
		socket.emit("score", socket.liveScore);

		await redis.publish(CHANNEL, JSON.stringify({
			index,
			value,
			color: value === 1 ? socket.userColor : null,
		}));
	});

	socket.on("disconnect", async () => {
		clientCount--;
		broadcastClientCount();

		const id = socket.userId || socket.guestId;
		onlineIds.delete(id);
		await removeDisplayName(id);

		// Remove from leaderboard on disconnect (guests always, users only if score is 0)
		if (!socket.userId || socket.liveScore === 0) {
			await redis.zrem(LEADERBOARD_KEY, id);
		}
		scheduleLeaderboardBroadcast();
	});
});

httpServer.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
