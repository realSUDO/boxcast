import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const TOTAL_BOXES = parseInt(process.env.TOTAL_BOXES) || 2610;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(__dirname, {
	setHeaders: (res, path) => {
		if (path.endsWith(".js"))  res.setHeader("Content-Type", "application/javascript");
		if (path.endsWith(".css")) res.setHeader("Content-Type", "text/css");
	}
}));

let currentMatrix = new Array(TOTAL_BOXES).fill(0);
let colorMatrix = new Array(TOTAL_BOXES).fill(null);

// ----------------------- Color generation logic -----------------------

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

// ----------------------- socket.io logic -----------------------

io.on("connection", (socket) => {
	console.log("new client aa gya");
	socket.userColor = generateUserColor();

	socket.emit("init", {
		totalBoxes: TOTAL_BOXES,
		matrix: currentMatrix,
		colorMatrix: colorMatrix,
		yourColor: socket.userColor,
	});

	socket.on("toggle", (data) => {
		try {
			currentMatrix[data.index] = data.value;
			colorMatrix[data.index] = data.value === 1 ? socket.userColor : null;

			socket.broadcast.emit("update", {
				index: data.index,
				value: data.value,
				color: colorMatrix[data.index],
			});

			console.log(`Box ${data.index} toggled to : ${data.value}`);
		} catch (error) {
			console.error("Error occured : ", error);
		}
	});

	socket.on("disconnect", () => {
		console.log("client chala gya");
	});
});

httpServer.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`);
});
