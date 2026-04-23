import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let PORT = process.env.PORT || 3000;
const app = express();
const server = app.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

const TOTAL_BOXES = parseInt(process.env.TOTAL_BOXES) || 2610;
const clients = new Set();
let currentMatrix = new Array(TOTAL_BOXES).fill(0);

// store which color toggled each box
let colorMatrix = new Array(TOTAL_BOXES).fill(null);

app.use(express.static(__dirname));







// ----------------------- Color generation logic -----------------------

// generates greyish colors..
let colorIndex = 0;
function generateUserColor() {
	const hue = (colorIndex * 137.5) % 360; // golden angle spread
	colorIndex++;
	const s = 30 + (colorIndex % 3) * 5;
	const l = 78 + (colorIndex % 3) * 3;
	return hslToHex(hue, s, l);
	

	// this one is..  HSL: low saturation (30-40%), high lightness (75-85%) → muted pastels
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

// ----------------------- ws logic -----------------------

wss.on("connection", (ws) => {
	console.log("new client aa gya");
	clients.add(ws);
	ws.userColor = generateUserColor();

	ws.send(
		JSON.stringify({
			type: "init",
			totalBoxes: TOTAL_BOXES,
			matrix: currentMatrix,
			colorMatrix: colorMatrix,
			yourColor: ws.userColor,
		}),
	);

	ws.on("message", (message) => {
		try {
			const data = JSON.parse(message);
			if (data.type === "toggle") {
				currentMatrix[data.index] = data.value;
				colorMatrix[data.index] = data.value === 1 ? ws.userColor : null;

				const broadcastMessage = JSON.stringify({
					type: "update",
					index: data.index,
					value: data.value,
					color: colorMatrix[data.index],
				});

				clients.forEach((client) => {
					if (client !== ws && client.readyState === WebSocket.OPEN) {
						client.send(broadcastMessage);
					}
				});
				console.log(`Box ${data.index} toggled to : ${data.value}`);
			}
		} catch (error) {
			console.error("Error occured : ", error);
		}
	});

	ws.on('close', () => {
		console.log("client chala gya");
		clients.delete(ws);
	});
});
