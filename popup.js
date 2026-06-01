import { dedupeWindows } from "./lib.js";

const btn = document.getElementById("restore");
const statusEl = document.getElementById("status");
const tabListEl = document.getElementById("tab-list");
const recallEl = document.querySelector(".recall");

const tabs = [];
let selectedIndex = -1;


async function openTab(url, incognito) {
	// Delegate to the service worker — it picks the right window (and reuses an existing tab if the URL is already open),
	// and isn't tied to the popup's lifetime, which dies when the destination window gets focus.
	try {
		const response = await chrome.runtime.sendMessage({ type: "openTab", url, incognito });
		if (!response?.ok) throw new Error(response?.error || "open failed");
	} catch (e) {
		statusEl.textContent = `Error: ${e.message}`;
	}
}


function renderTabList(snapshot) {
	tabListEl.replaceChildren();
	tabs.length = 0;
	selectedIndex = -1;

	let hasPrior = false;

	for (const w of snapshot.windows) {
		let firstOfWindow = true;

		for (const t of w.tabs || []) {
			if (!t.url) continue;

			const li = document.createElement("li");

			li.textContent = t.title || t.url;
			li.title = t.url;

			if (w.incognito) li.classList.add("incognito");
			if (hasPrior && firstOfWindow) li.classList.add("window-start");

			li.addEventListener("click", () => openTab(t.url, w.incognito));
			tabListEl.appendChild(li);
			tabs.push({ url: t.url, incognito: w.incognito, li });
			firstOfWindow = false;
			hasPrior = true;
		}
	}
}


function setSelection(idx) {
	if (selectedIndex >= 0 && tabs[selectedIndex]) {
		tabs[selectedIndex].li.classList.remove("selected");
	}

	selectedIndex = idx;
	recallEl.classList.toggle("open", idx >= 0);

	if (idx >= 0 && tabs[idx]) {
		tabs[idx].li.classList.add("selected");
		tabs[idx].li.scrollIntoView({ block: "nearest" });
	}
}


document.addEventListener("keydown", (e) => {
	if (!tabs.length) return;

	if (e.key === "ArrowDown") {
		e.preventDefault();
		setSelection(selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, tabs.length - 1));
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		setSelection(selectedIndex < 0 ? tabs.length - 1 : Math.max(selectedIndex - 1, 0));
	} else if (e.key === "Enter" && selectedIndex >= 0) {
		e.preventDefault();
		const t = tabs[selectedIndex];
		openTab(t.url, t.incognito);
	} else if (e.key === "Escape" && selectedIndex >= 0) {
		e.preventDefault();
		setSelection(-1);
	}
});


async function init() {
	const [{ previousSnapshot, recentlyClosed }, { restored }] = await Promise.all([
		chrome.storage.local.get(["previousSnapshot", "recentlyClosed"]),
		chrome.storage.session.get("restored"),
	]);

	// Restore offers both the previous session and any whole windows closed
	// during this one (e.g. a private window closed by accident).
	const windows = dedupeWindows([...(previousSnapshot?.windows || []), ...(recentlyClosed || [])]);

	if (!windows.length) {
		btn.disabled = true;
		statusEl.textContent = restored
			? "Session has been restored."
			: "No previous session found.";
		return;
	}

	const winCount = windows.length;
	const tabCount = windows.reduce((n, w) => n + (w.tabs?.length || 0), 0);

	statusEl.textContent = `${winCount} window${winCount === 1 ? "" : "s"}, ${tabCount} tab${tabCount === 1 ? "" : "s"}`;
	renderTabList({ windows });
}


btn.addEventListener("click", async () => {
	btn.disabled = true;
	statusEl.textContent = "Restoring…";

	try {
		const response = await chrome.runtime.sendMessage({ type: "restore" });

		if (!response?.ok) throw new Error(response?.error || "restore failed");

		statusEl.textContent = "Session has been restored.";
		tabListEl.replaceChildren();
	} catch (e) {
		statusEl.textContent = `Error: ${e.message}`;
		btn.disabled = false;
	}
});


init();
