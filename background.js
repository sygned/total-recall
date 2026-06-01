import { filterRestorableTabs, findClosedWindows, dedupeWindows, windowSignature } from "./lib.js";

const SNAPSHOT_KEY = "snapshot";
const PREVIOUS_KEY = "previousSnapshot";
const RECENT_KEY = "recentlyClosed";
const SESSION_MARKER = "sessionActive";
const DEBOUNCE_ALARM = "snapshot-debounce";
const DEBOUNCE_MS = 500;
const RECENT_CAP = 8;
const ICON_AVAILABLE_BG = "#7c3aed";
const ICON_IDLE_BG = "#666";


function drawIcon(size, bgColor) {
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext("2d");
	const radius = size * 0.18;

	ctx.fillStyle = bgColor;
	ctx.beginPath();
	ctx.roundRect(0, 0, size, size, radius);
	ctx.fill();
	ctx.fillStyle = "white";
	ctx.font = `bold ${Math.floor(size * 0.72)}px sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText("R", size / 2, size / 2 + size * 0.04);

	return ctx.getImageData(0, 0, size, size);
}


async function updateIcon() {
	const { [PREVIOUS_KEY]: prev, [RECENT_KEY]: recent } =
		await chrome.storage.local.get([PREVIOUS_KEY, RECENT_KEY]);
	const available = prev?.windows?.length || recent?.length;
	const bg = available ? ICON_AVAILABLE_BG : ICON_IDLE_BG;

	await chrome.action.setIcon({
		imageData: {
			16: drawIcon(16, bg),
			32: drawIcon(32, bg),
			48: drawIcon(48, bg),
			128: drawIcon(128, bg),
		},
	});
}


// Append whole windows that were closed mid-session to a capped, deduped list
// so they stay restorable until the next browser restart or a restore.
async function stashClosedWindows(closed) {
	const { [RECENT_KEY]: existing = [] } = await chrome.storage.local.get(RECENT_KEY);
	const seen = new Set(existing.map(windowSignature));
	const fresh = closed.filter((w) => !seen.has(windowSignature(w)));

	if (!fresh.length) return;

	const merged = [...fresh, ...existing].slice(0, RECENT_CAP);

	await chrome.storage.local.set({ [RECENT_KEY]: merged });
}


async function captureSnapshot() {
	const windows = await chrome.windows.getAll({ populate: true });
	// Don't clobber state when no windows are open — this is almost always a
	// browser-shutdown sequence, and the existing snapshot is what we'll need
	// to restore from on the next startup.
	if (windows.length === 0) return null;

	const [{ [SNAPSHOT_KEY]: prior }, { [SESSION_MARKER]: sessionId }] = await Promise.all([
		chrome.storage.local.get(SNAPSHOT_KEY),
		chrome.storage.session.get(SESSION_MARKER),
	]);

	const snapshot = {
		capturedAt: Date.now(),
		sessionId,
		windows: windows.map((w) => ({
			id: w.id,
			focused: w.focused,
			incognito: w.incognito,
			type: w.type,
			state: w.state,
			tabs: (w.tabs || []).map((t) => ({
				id: t.id,
				index: t.index,
				url: t.url,
				title: t.title,
				pinned: t.pinned,
				active: t.active,
				groupId: t.groupId,
			})),
		})),
	};

	// A window present last capture but gone now was closed while the browser
	// kept running — stash it so an accidental close stays recoverable. Only
	// diff against a prior capture from the SAME session: window ids are not
	// stable across a browser restart, so a cross-session prior would flag every
	// window from the last run as "closed" and stash the whole previous session
	// (which then duplicates previousSnapshot on restore).
	if (prior && prior.sessionId === sessionId) {
		const closed = findClosedWindows(prior.windows, snapshot.windows);

		if (closed.length) await stashClosedWindows(closed);
	}

	await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot });

	return snapshot;
}


function scheduleSnapshot() {
	chrome.alarms.create(DEBOUNCE_ALARM, { when: Date.now() + DEBOUNCE_MS });
}


async function rotateAndCapture() {
	const { [SNAPSHOT_KEY]: prior } = await chrome.storage.local.get(SNAPSHOT_KEY);

	if (prior?.windows?.length) {
		await chrome.storage.local.set({ [PREVIOUS_KEY]: prior });
	}

	// A fresh browser session supersedes the previous run's mid-session
	// closed-window stash — previousSnapshot now covers all of it.
	await chrome.storage.local.remove(RECENT_KEY);

	await captureSnapshot();
}


let sessionInit = null;


// New-session detection that works in every Chromium browser, not just the ones
// that reliably fire chrome.runtime.onStartup (Brave, notably, does not).
// chrome.storage.session is wiped by the browser on restart but survives the
// service worker's idle teardown — so a missing marker means "the browser has
// restarted since we last ran". rotateIfNew is false for the extension-install/
// update path so an auto-update doesn't masquerade as a browser restart and
// clobber previousSnapshot. The in-memory promise serialises concurrent callers
// so the rotation happens at most once per session.
async function initSession(rotateIfNew) {
	const { [SESSION_MARKER]: active } = await chrome.storage.session.get(SESSION_MARKER);

	if (active) return;

	// The marker doubles as the session id stamped onto each snapshot, so the
	// closed-window diff can tell a same-session prior from a stale cross-session
	// one. Any unique-per-session value works; the capture timestamp is handy.
	await chrome.storage.session.set({ [SESSION_MARKER]: Date.now() });

	if (rotateIfNew) await rotateAndCapture();
}


function ensureSession(rotateIfNew = true) {
	if (!sessionInit) {
		sessionInit = initSession(rotateIfNew).catch((e) => {
			sessionInit = null;
			throw e;
		});
	}

	return sessionInit;
}


async function handleSnapshotTrigger() {
	await ensureSession(true);
	await captureSnapshot();
}


chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === DEBOUNCE_ALARM) handleSnapshotTrigger();
});


async function restorePreviousSession() {
	const { [PREVIOUS_KEY]: prev, [RECENT_KEY]: recent } =
		await chrome.storage.local.get([PREVIOUS_KEY, RECENT_KEY]);

	// previousSnapshot first so its copy wins when a window also sits in the
	// mid-session recentlyClosed stash with identical content.
	const candidates = dedupeWindows([...(prev?.windows || []), ...(recent || [])]);

	if (!candidates.length) throw new Error("no previous session to restore");

	const openWindows = await chrome.windows.getAll({ populate: true });
	const openUrls = new Set();

	for (const w of openWindows) {
		for (const t of w.tabs || []) {
			if (t.url) openUrls.add(t.url);
		}
	}

	for (const w of filterRestorableTabs(candidates, openUrls)) {
		const tabs = w.tabs;

		const createOpts = {
			url: tabs.map((t) => t.url),
			incognito: !!w.incognito,
			type: w.type === "popup" ? "popup" : "normal",
			state: w.state === "minimized" ? "normal" : w.state,
		};

		let created;
		try {
			created = await chrome.windows.create(createOpts);
		} catch (e) {
			console.warn("restore: window create failed", { incognito: w.incognito, error: e.message });
			continue;
		}

		const createdTabs = created.tabs || [];
		for (let i = 0; i < createdTabs.length && i < tabs.length; i++) {
			const original = tabs[i];
			const updates = {};
			if (original.pinned) updates.pinned = true;
			if (original.active) updates.active = true;
			if (Object.keys(updates).length === 0) continue;
			try {
				await chrome.tabs.update(createdTabs[i].id, updates);
			} catch (e) {
				console.warn("restore: tab update failed", e.message);
			}
		}
	}

	await chrome.storage.local.remove([PREVIOUS_KEY, RECENT_KEY]);
	await chrome.storage.session.set({ restored: true });
}


async function openTab(url, incognito) {
	// If the URL is already open in a window of the requested kind, switch to that tab/window instead of opening a duplicate. Otherwise add a tab to an
	// existing matching window, or spawn one if none exist. URL match is exact — matching the dedup convention in restorePreviousSession.
	const wantIncognito = !!incognito;
	const wins = await chrome.windows.getAll({ populate: true });

	for (const w of wins) {
		if (!!w.incognito !== wantIncognito || w.type !== "normal") continue;
		for (const t of w.tabs || []) {
			if (t.url === url) {
				await chrome.tabs.update(t.id, { active: true });
				await chrome.windows.update(w.id, { focused: true });
				return;
			}
		}
	}

	const target = wins.find((w) => !!w.incognito === wantIncognito && w.type === "normal");

	if (target) {
		await chrome.tabs.create({ windowId: target.id, url, active: true });
		await chrome.windows.update(target.id, { focused: true });
	} else {
		await chrome.windows.create({ url, incognito: wantIncognito });
	}
}


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg?.type === "restore") {
		restorePreviousSession()
			.then(() => sendResponse({ ok: true }))
			.catch((e) => sendResponse({ ok: false, error: e.message }));
		return true;
	}

	if (msg?.type === "openTab") {
		openTab(msg.url, msg.incognito)
			.then(() => sendResponse({ ok: true }))
			.catch((e) => sendResponse({ ok: false, error: e.message }));
		return true;
	}
});


// An extension install/update clears chrome.storage.session too, so it must
// claim the session marker WITHOUT rotating — otherwise an auto-update mid-
// session would overwrite previousSnapshot with the current session.
chrome.runtime.onInstalled.addListener(() => {
	ensureSession(false).then(captureSnapshot);
});

chrome.runtime.onStartup.addListener(() => {
	ensureSession(true);
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && (PREVIOUS_KEY in changes || RECENT_KEY in changes)) updateIcon();
});

updateIcon().catch((e) => console.warn("icon: initial paint failed", e.message));

chrome.windows.onCreated.addListener(scheduleSnapshot);
chrome.windows.onRemoved.addListener(scheduleSnapshot);

chrome.tabs.onCreated.addListener(scheduleSnapshot);
chrome.tabs.onRemoved.addListener(scheduleSnapshot);

chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
	if (changeInfo.url || changeInfo.title || changeInfo.pinned) scheduleSnapshot();
});

chrome.tabs.onMoved.addListener(scheduleSnapshot);

chrome.tabs.onAttached.addListener(scheduleSnapshot);
chrome.tabs.onDetached.addListener(scheduleSnapshot);
chrome.tabs.onReplaced.addListener(scheduleSnapshot);
