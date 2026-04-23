let container = document.querySelector(".main");

let matrix = [];
let colorMatrix = [];
let myColor = null;
let ws = null;

// jittering for .. load (if there) 

const THROTTLE_MS = 50; // max one send per 50ms per box
const lastSent = {};

function canSend(index) {
	const now = Date.now();
	if (!lastSent[index] || now - lastSent[index] >= THROTTLE_MS) {
		lastSent[index] = now;
		return true;
	}
	return false;
}

function createBoxes(count) {
	container.innerHTML = "";
	for (let i = 0; i < count; i++) {
		let checkbox = document.createElement("div");
		checkbox.classList.add("checkbox");
		checkbox.dataset.index = i;
		container.appendChild(checkbox);
	}
}

function updateBoxVisual(index, value, color) {
	const box = container.children[index];
	if (value === 1) {
		box.classList.add("toggled");
		box.style.backgroundColor = color || "";
	} else {
		box.classList.remove("toggled");
		box.style.backgroundColor = "";
	}
}

function syncAllVisuals() {
	for (let i = 0; i < matrix.length; i++) {
		updateBoxVisual(i, matrix[i], colorMatrix[i]);
	}
}

function connectWebSocket() {
	ws = new WebSocket(`ws://${window.location.host}`);

	ws.onopen = () => {
		console.log("Connected to server");
	};

	ws.onmessage = (event) => {
		const data = JSON.parse(event.data);

		if (data.type === "init") {
			myColor = data.yourColor;
			matrix = data.matrix;
			colorMatrix = data.colorMatrix;
			createBoxes(data.totalBoxes);
			syncAllVisuals();
			console.log(`Initialized with ${data.totalBoxes} boxes, color: ${myColor}`);
		}

		if (data.type === "update") {
			matrix[data.index] = data.value;
			colorMatrix[data.index] = data.color;
			updateBoxVisual(data.index, data.value, data.color);
		}
	};

	ws.onerror = (error) => {
		console.error("WebSocket error : ", error);
	};

	ws.onclose = () => {
		console.log("Disconnected, reconnecting in 3 seconds...");
		setTimeout(connectWebSocket, 3000);
	};
}

container.addEventListener("click", (event) => {
	let clickedBox = event.target.closest(".checkbox");
	if (!clickedBox || !ws || ws.readyState !== WebSocket.OPEN) return;

	let index = parseInt(clickedBox.dataset.index);
	if (!canSend(index)) return; // jitter throttle

	let newValue = matrix[index] === 1 ? 0 : 1;
	matrix[index] = newValue;
	colorMatrix[index] = newValue === 1 ? myColor : null;

	updateBoxVisual(index, newValue, colorMatrix[index]);

	ws.send(JSON.stringify({ type: "toggle", index, value: newValue }));
});

connectWebSocket();
