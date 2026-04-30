const container = document.querySelector(".main");

// Sparse state: only toggled boxes stored
const toggledBoxes = {}; // { index: { value, color } }

let myColor = null;
let totalBoxes = 0;
let chunkSize = 1500;
let renderedCount = 0;
let clientCount = 1;
let socket = null;
let sentinel = null;
let observer = null;

// ----------------------- Jitter -----------------------

function jitterDelay() {
	const max = Math.min(clientCount * 2, 2000);
	return Math.random() * max;
}

// ----------------------- DOM helpers -----------------------

function showSkeleton() {
	container.innerHTML = "";
	container.classList.add("skeleton");
}

function createBox(index) {
	const box = document.createElement("div");
	box.classList.add("checkbox");
	box.dataset.index = index;
	const state = toggledBoxes[index];
	if (state) {
		box.classList.add("toggled");
		box.style.backgroundColor = state.color || "";
	}
	return box;
}

function updateBoxVisual(index, value, color) {
	// Only update if box is currently rendered
	const box = container.querySelector(`[data-index="${index}"]`);
	if (!box) return;
	if (value === 1) {
		box.classList.add("toggled");
		box.style.backgroundColor = color || "";
	} else {
		box.classList.remove("toggled");
		box.style.backgroundColor = "";
	}
}

// ----------------------- Chunked rendering -----------------------

function appendChunk(start, count) {
	const frag = document.createDocumentFragment();
	for (let i = start; i < start + count; i++) {
		frag.appendChild(createBox(i));
	}
	// Remove old sentinel before appending
	if (sentinel) sentinel.remove();
	container.appendChild(frag);
	renderedCount = start + count;

	// Re-attach sentinel if more boxes remain
	if (renderedCount < totalBoxes) {
		sentinel = document.createElement("div");
		sentinel.className = "sentinel";
		container.appendChild(sentinel);
		observer.observe(sentinel);
	}
}

function setupObserver() {
	observer = new IntersectionObserver((entries) => {
		if (!entries[0].isIntersecting) return;
		observer.unobserve(sentinel);
		socket.emit("fetch-chunk", { start: renderedCount });
	}, { rootMargin: "200px" });
}

// ----------------------- Socket -----------------------

function connect() {
	socket = io({
		reconnection: true,
		reconnectionAttempts: Infinity,
		reconnectionDelay: 500,         // start at 500ms
		reconnectionDelayMax: 10000,    // cap at 10s
		randomizationFactor: 0.7,       // ±70% jitter on each delay
	});

	socket.on("connect", showSkeleton);

	socket.on("client-count", (count) => {
		clientCount = count;
	});

	socket.on("init", ({ totalBoxes: total, chunkSize: cs, yourColor, chunk }) => {
		totalBoxes = total;
		chunkSize = cs;
		myColor = yourColor;

		// Apply first chunk state to sparse map
		for (const { index, color } of chunk) {
			toggledBoxes[index] = { value: 1, color };
		}

		container.classList.remove("skeleton");
		container.innerHTML = "";
		renderedCount = 0;

		setupObserver();
		appendChunk(0, Math.min(chunkSize, totalBoxes));
	});

	socket.on("chunk", ({ start, chunk }) => {
		for (const { index, color } of chunk) {
			toggledBoxes[index] = { value: 1, color };
		}
		appendChunk(start, Math.min(chunkSize, totalBoxes - start));
	});

	socket.on("update", ({ index, value, color }) => {
		if (value === 1) toggledBoxes[index] = { value, color };
		else delete toggledBoxes[index];
		updateBoxVisual(index, value, color);
	});
}

// ----------------------- Click handler -----------------------

container.addEventListener("click", (e) => {
	const box = e.target.closest(".checkbox");
	if (!box || !socket?.connected) return;

	const index = parseInt(box.dataset.index);
	const current = toggledBoxes[index];
	const newValue = current ? 0 : 1;
	const newColor = newValue === 1 ? myColor : null;

	// Optimistic update
	if (newValue === 1) toggledBoxes[index] = { value: 1, color: newColor };
	else delete toggledBoxes[index];
	updateBoxVisual(index, newValue, newColor);

	// Jittered emit
	setTimeout(() => {
		socket.emit("toggle", { index, value: newValue });
	}, jitterDelay());
});

showSkeleton();
connect();
