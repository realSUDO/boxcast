let container = document.querySelector(".main");

let matrix = [];
let colorMatrix = [];
let myColor = null;
let socket = null;

const THROTTLE_MS = 50;
const lastSent = {};

function canSend(index) {
	const now = Date.now();
	if (!lastSent[index] || now - lastSent[index] >= THROTTLE_MS) {
		lastSent[index] = now;
		return true;
	}
	return false;
}

function showSkeleton() {
	container.innerHTML = "";
	container.classList.add("skeleton");
}

function createBoxes(count) {
	container.classList.remove("skeleton");
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

function connectSocket() {
	socket = io();

	socket.on("connect", () => {
		console.log("Connected to server");
		showSkeleton();
	});

	socket.on("init", (data) => {
		myColor = data.yourColor;
		matrix = data.matrix;
		colorMatrix = data.colorMatrix;
		createBoxes(data.totalBoxes);
		syncAllVisuals();
		console.log(`Initialized with ${data.totalBoxes} boxes, color: ${myColor}`);
	});

	socket.on("update", (data) => {
		matrix[data.index] = data.value;
		colorMatrix[data.index] = data.color;
		updateBoxVisual(data.index, data.value, data.color);
	});

	socket.on("disconnect", () => {
		console.log("Disconnected, reconnecting...");
	});
}

container.addEventListener("click", (event) => {
	let clickedBox = event.target.closest(".checkbox");
	if (!clickedBox || !socket || !socket.connected) return;

	let index = parseInt(clickedBox.dataset.index);
	if (!canSend(index)) return;

	let newValue = matrix[index] === 1 ? 0 : 1;
	matrix[index] = newValue;
	colorMatrix[index] = newValue === 1 ? myColor : null;

	updateBoxVisual(index, newValue, colorMatrix[index]);
	socket.emit("toggle", { index, value: newValue });
});

showSkeleton();
connectSocket();
