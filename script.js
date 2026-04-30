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
	const token = getToken();

	socket = io({
		reconnection: true,
		reconnectionAttempts: Infinity,
		reconnectionDelay: 500,
		reconnectionDelayMax: 10000,
		randomizationFactor: 0.7,
		auth: { token: token || null },
	});

	socket.on("connect", () => {
		showSkeleton();
	});

	socket.on("client-count", (count) => {
		clientCount = count;
		const el = document.getElementById("connectedCount");
		if (el) el.textContent = `Connected: ${count}`;
	});

	socket.on("init", ({ totalBoxes: total, chunkSize: cs, yourColor, chunk, score }) => {
		totalBoxes = total;
		chunkSize = cs;
		myColor = yourColor;

		updateScore(score);

		for (const { index, color } of chunk) {
			toggledBoxes[index] = { value: 1, color };
		}

		container.classList.remove("skeleton");
		container.innerHTML = "";
		renderedCount = 0;

		setupObserver();
		appendChunk(0, Math.min(chunkSize, totalBoxes));
	});

	socket.on("score", (s) => {
		updateScore(s);
	});

	socket.on("leaderboard", (board) => {
		renderLeaderboard(board);
	});

	socket.on("auth-invalid", async () => {
		const newToken = await refreshAccessToken();
		if (newToken) {
			socket.emit("auth", { token: newToken });
		} else {
			clearAuth();
			loginOverlay.classList.add("open");
		}
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

const lastToggled = {};
const TOGGLE_THROTTLE = 300;

container.addEventListener("click", (e) => {
	const box = e.target.closest(".checkbox");
	if (!box || !socket?.connected) return;

	const index = parseInt(box.dataset.index);
	const now = Date.now();
	if (lastToggled[index] && now - lastToggled[index] < TOGGLE_THROTTLE) return;
	lastToggled[index] = now;
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

// ----------------------- Sidebar -----------------------

const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("sidebarOverlay");

function openSidebar()  { sidebar.classList.add("open"); overlay.classList.add("open"); }
function closeSidebar() { sidebar.classList.remove("open"); overlay.classList.remove("open"); }

document.getElementById("sidebarToggle").addEventListener("click", openSidebar);
document.getElementById("sidebarClose").addEventListener("click", closeSidebar);
overlay.addEventListener("click", closeSidebar);

// ----------------------- Score -----------------------

function updateScore(score) {
	const el = document.getElementById("scoreDisplay");
	if (el) el.textContent = `Score: ${score}`;
}

// ----------------------- Leaderboard -----------------------

function renderLeaderboard({ board, online }) {
	const onlineSet = new Set(online || []);
	const list = document.getElementById("leaderboardList");
	if (!list) return;
	list.innerHTML = board.map((entry, i) =>
		`<li class="lb-entry ${i === 0 ? 'lb-first' : ''}">
			<span class="lb-rank">${i + 1}</span>
			<span class="lb-name">
				${onlineSet.has(entry.id) ? '<span class="lb-dot"></span>' : ''}${entry.name}
			</span>
			<span class="lb-score">${entry.score}</span>
		</li>`
	).join("");
}

// Guest prompt visibility
function updateGuestPrompt() {
	const prompt = document.getElementById("guestPrompt");
	if (!prompt) return;
	prompt.style.display = getUser() ? "none" : "flex";
}

document.getElementById("guestLoginBtn")?.addEventListener("click", () => {
	closeSidebar();
	loginOverlay.classList.add("open");
});

// ----------------------- Auth -----------------------

const AUTH_API = "https://auth.sudohq.me";

function getToken()    { return localStorage.getItem("auth_token"); }
function getRefresh()  { return localStorage.getItem("auth_refresh"); }
function getUser()     { return JSON.parse(localStorage.getItem("auth_user") || "null"); }

async function refreshAccessToken() {
	const refresh = getRefresh();
	if (!refresh) return null;
	try {
		const res = await fetch("/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: refresh }),
		});
		const data = await res.json();
		if (data.access_token) {
			localStorage.setItem("auth_token", data.access_token);
			if (data.refresh_token) localStorage.setItem("auth_refresh", data.refresh_token);
			return data.access_token;
		}
	} catch {}
	return null;
}

function setAuth(token, user, refreshToken) {
	localStorage.setItem("auth_token", token);
	localStorage.setItem("auth_user", JSON.stringify(user));
	if (refreshToken) localStorage.setItem("auth_refresh", refreshToken);
	updateNavAuth(user);
	updateGuestPrompt();
	if (socket?.connected) {
		socket.emit("auth", { token });
	} else {
	}
}

function clearAuth() {
	localStorage.removeItem("auth_token");
	localStorage.removeItem("auth_user");
	localStorage.removeItem("auth_refresh");
	updateNavAuth(null);
	updateGuestPrompt();
}

function updateNavAuth(user) {
	const btn = document.getElementById("loginBtn");
	if (user) {
		const name = (user.name || user.email || "user").slice(0, 7);
		btn.dataset.name = name;
		btn.textContent = name;
		btn.classList.add("logged-in");
		btn.onclick = clearAuth;
	} else {
		btn.textContent = "Login";
		btn.classList.remove("logged-in");
		btn.dataset.name = "";
		btn.onclick = () => loginOverlay.classList.add("open");
	}
}

// Check existing session on load
const existingUser = getUser();
if (existingUser) updateNavAuth(existingUser);
updateGuestPrompt();

// ----------------------- Login modal -----------------------

const loginOverlay  = document.getElementById("loginOverlay");
const signupOverlay = document.getElementById("signupOverlay");

document.getElementById("loginBtn").addEventListener("click", () => {
	if (!getUser()) loginOverlay.classList.add("open");
	else clearAuth();
});
document.getElementById("loginClose").addEventListener("click",  () => loginOverlay.classList.remove("open"));
document.getElementById("signupClose").addEventListener("click", () => signupOverlay.classList.remove("open"));
loginOverlay.addEventListener("click",  (e) => { if (e.target === loginOverlay)  loginOverlay.classList.remove("open"); });
signupOverlay.addEventListener("click", (e) => { if (e.target === signupOverlay) signupOverlay.classList.remove("open"); });

document.getElementById("showSignup").addEventListener("click", (e) => {
	e.preventDefault();
	loginOverlay.classList.remove("open");
	signupOverlay.classList.add("open");
});
document.getElementById("showLogin").addEventListener("click", (e) => {
	e.preventDefault();
	signupOverlay.classList.remove("open");
	loginOverlay.classList.add("open");
});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
	e.preventDefault();
	const btn = document.getElementById("loginSubmit");
	const err = document.getElementById("loginError");
	btn.disabled = true; btn.textContent = "Logging in...";
	err.textContent = "";
	try {
		const res = await fetch(`${AUTH_API}/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: document.getElementById("loginEmail").value,
				password: document.getElementById("loginPassword").value,
			}),
		});
		const data = await res.json();
		if (!res.ok) { err.textContent = data.error || "Login failed"; return; }
		setAuth(data.accessToken, data.user, data.refreshToken);
		loginOverlay.classList.remove("open");
	} catch {
		err.textContent = "Network error";
	} finally {
		btn.disabled = false; btn.textContent = "Login";
	}
});

document.getElementById("signupForm").addEventListener("submit", async (e) => {
	e.preventDefault();
	const btn = document.getElementById("signupSubmit");
	const err = document.getElementById("signupError");
	btn.disabled = true; btn.textContent = "Creating account...";
	err.textContent = "";
	try {
		const res = await fetch(`${AUTH_API}/auth/signup`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: document.getElementById("signupName").value,
				email: document.getElementById("signupEmail").value,
				password: document.getElementById("signupPassword").value,
			}),
		});
		const data = await res.json();
		if (!res.ok) { err.textContent = data.error || "Signup failed"; return; }
		setAuth(data.accessToken, data.user, data.refreshToken);
		signupOverlay.classList.remove("open");
	} catch {
		err.textContent = "Network error";
	} finally {
		btn.disabled = false; btn.textContent = "Sign up";
	}
});
