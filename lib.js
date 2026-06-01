export function isRestorableUrl(url) {
	if (!url) return false;

	return /^(https?|file|ftp|about):/i.test(url);
}

// Given previousSnapshot.windows and a Set of URLs currently open across every window, return only the windows that have at least one tab worth
// (re)creating — each window's tabs filtered to restorable, non-duplicate URLs, all other window fields preserved.
export function filterRestorableTabs(prevWindows, openUrls) {
	const result = [];

	for (const w of prevWindows || []) {
		const tabs = (w.tabs || []).filter(
			(t) => isRestorableUrl(t.url) && !openUrls.has(t.url),
		);

		if (tabs.length) result.push({ ...w, tabs });
	}

	return result;
}

// A stable identity for a window based purely on its tab URLs, used to dedupe
// windows that hold the same content (across the recentlyClosed stash and the
// previousSnapshot ∪ recentlyClosed restore union).
export function windowSignature(w) {
	return (w.tabs || []).map((t) => t.url).join("\n");
}

// Collapse windows with identical tab-URL signatures, keeping the first
// occurrence. Used on the restore union so a window that appears in both
// previousSnapshot and recentlyClosed is only opened once.
export function dedupeWindows(windows) {
	const seen = new Set();
	const out = [];

	for (const w of windows || []) {
		const sig = windowSignature(w);

		if (seen.has(sig)) continue;

		seen.add(sig);
		out.push(w);
	}

	return out;
}

// Given the windows from the previous capture and the windows that are live
// now, return the windows that vanished entirely (matched by id) and still have
// at least one restorable tab — i.e. whole windows closed mid-session while the
// browser kept running. These are stashed so an accidental close (especially of
// a private window) stays recoverable. Closing individual tabs inside a window
// that survives is deliberately ignored: only whole-window losses are retained.
export function findClosedWindows(prevWindows, liveWindows) {
	const liveIds = new Set((liveWindows || []).map((w) => w.id));
	const closed = [];

	for (const w of prevWindows || []) {
		if (liveIds.has(w.id)) continue;

		const tabs = (w.tabs || []).filter((t) => isRestorableUrl(t.url));

		if (tabs.length) closed.push({ ...w, tabs });
	}

	return closed;
}
