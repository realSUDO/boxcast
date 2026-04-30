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

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(__dirname, {
	setHeaders: (res, filePath) => {
		if (filePath.endsWith(".js"))  res.setHeader("Content-Type", "application/javascript");
		if (filePath.endsWith(".css")) res.setHeader("Content-Type", "text/css");
	}
}));

// Two Redis clients: one for pub/sub (can't do other commands while subscribed), one for everything else
const redis = new Redis(REDIS_URL);
const sub = new Redis(REDIS_URL);

const CHANNEL = "boxes:updates";

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

// ----------------------- Redis helpers -----------------------

// Returns toggled entries in [start, end) as { index, color }[]
async function fetchChunk(start, end) {
	const count = end - start;
	const cmds = [];
	for (let i = start; i < end; i++) cmds.push("GET", "u1", i);
	const values = await redis.bitfield("boxes:state", ...cmds);

	// Collect toggled indices, then batch-fetch colors via pipeline
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

// ----------------------- Client count + jitter broadcast -----------------------

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
	const data = JSON.parse(message);
	// Broadcast to all local socket.io clients
	io.emit("update", data);
});

// ----------------------- socket.io -----------------------

io.on("connection", async (socket) => {
	console.log("new client aa gya");
	clientCount++;
	broadcastClientCount();

	socket.userColor = generateUserColor();

	// Send first chunk
	const firstChunk = await fetchChunk(0, Math.min(CHUNK_SIZE, TOTAL_BOXES));

	socket.emit("init", {
		totalBoxes: TOTAL_BOXES,
		chunkSize: CHUNK_SIZE,
		yourColor: socket.userColor,
		chunk: firstChunk, // only toggled boxes in first window
	});

	socket.on("fetch-chunk", async ({ start }) => {
		const end = Math.min(start + CHUNK_SIZE, TOTAL_BOXES);
		const chunk = await fetchChunk(start, end);
		socket.emit("chunk", { start, chunk });
	});

	socket.on("toggle", async ({ index, value }) => {
		await setBox(index, value, socket.userColor);
		const payload = JSON.stringify({
			index,
			value,
			color: value === 1 ? socket.userColor : null,
		});
		await redis.publish(CHANNEL, payload);
	});

	socket.on("disconnect", () => {
		console.log("client chala gya");
		clientCount--;
		broadcastClientCount();
	});
});

httpServer.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
