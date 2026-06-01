import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isRestorableUrl, filterRestorableTabs, findClosedWindows, dedupeWindows, windowSignature } from "./lib.js";

describe("isRestorableUrl", () => {
	test("allows http and https", () => {
		assert.equal(isRestorableUrl("http://example.com"), true);
		assert.equal(isRestorableUrl("https://example.com/path?q=1#frag"), true);
	});

	test("allows file, ftp, about", () => {
		assert.equal(isRestorableUrl("file:///etc/hosts"), true);
		assert.equal(isRestorableUrl("ftp://ftp.example.com/pub"), true);
		assert.equal(isRestorableUrl("about:blank"), true);
	});

	test("rejects chrome and chrome-extension", () => {
		assert.equal(isRestorableUrl("chrome://extensions"), false);
		assert.equal(isRestorableUrl("chrome-extension://abcdef/popup.html"), false);
	});

	test("rejects other schemes that chrome.windows.create chokes on", () => {
		assert.equal(isRestorableUrl("javascript:void(0)"), false);
		assert.equal(isRestorableUrl("data:text/html,<h1>hi</h1>"), false);
		assert.equal(isRestorableUrl("view-source:https://example.com"), false);
		assert.equal(isRestorableUrl("blob:https://example.com/abc"), false);
	});

	test("rejects empty, undefined, null", () => {
		assert.equal(isRestorableUrl(""), false);
		assert.equal(isRestorableUrl(undefined), false);
		assert.equal(isRestorableUrl(null), false);
	});

	test("scheme match is case-insensitive", () => {
		assert.equal(isRestorableUrl("HTTPS://example.com"), true);
		assert.equal(isRestorableUrl("About:Blank"), true);
	});

	test("requires the scheme prefix — substring matches don't count", () => {
		assert.equal(isRestorableUrl("not-http://x"), false);
		assert.equal(isRestorableUrl("xhttps://x"), false);
	});
});

describe("filterRestorableTabs", () => {
	test("drops tabs whose URLs are already open in another window", () => {
		const prev = [
			{ id: 1, incognito: false, tabs: [
				{ url: "https://a.com" },
				{ url: "https://b.com" },
			]},
		];
		const openUrls = new Set(["https://a.com"]);
		const out = filterRestorableTabs(prev, openUrls);

		assert.equal(out.length, 1);
		assert.deepEqual(out[0].tabs.map((t) => t.url), ["https://b.com"]);
	});

	test("drops unrestorable URLs (chrome://, chrome-extension://)", () => {
		const prev = [
			{ tabs: [
				{ url: "chrome://extensions" },
				{ url: "chrome-extension://abc/popup.html" },
				{ url: "https://keep.me" },
			]},
		];
		const out = filterRestorableTabs(prev, new Set());

		assert.deepEqual(out[0].tabs.map((t) => t.url), ["https://keep.me"]);
	});

	test("skips windows whose every tab was filtered out", () => {
		const prev = [
			{ id: 1, tabs: [{ url: "https://a.com" }] },
			{ id: 2, tabs: [{ url: "chrome://extensions" }] },
			{ id: 3, tabs: [{ url: "https://b.com" }] },
		];
		const openUrls = new Set(["https://a.com"]);
		const out = filterRestorableTabs(prev, openUrls);

		assert.equal(out.length, 1);
		assert.equal(out[0].id, 3);
	});

	test("preserves window metadata (incognito, type, state) on surviving windows", () => {
		const prev = [
			{ id: 7, incognito: true, type: "popup", state: "maximized",
				tabs: [{ url: "https://x.com", pinned: true, active: true }] },
		];
		const out = filterRestorableTabs(prev, new Set());

		assert.equal(out[0].incognito, true);
		assert.equal(out[0].type, "popup");
		assert.equal(out[0].state, "maximized");
		assert.equal(out[0].tabs[0].pinned, true);
	});

	test("URL match is exact — trailing slashes and fragments matter", () => {
		// Same URL repeated would dedupe; subtly different URLs must not.
		const prev = [{ tabs: [
			{ url: "https://a.com/" },
			{ url: "https://a.com#frag" },
		]}];
		const openUrls = new Set(["https://a.com"]);
		const out = filterRestorableTabs(prev, openUrls);

		assert.equal(out[0].tabs.length, 2);
	});

	test("the same URL appearing in two prev windows survives both — dedup is against open, not against self", () => {
		// The dedup snapshot is taken once at the start and not refreshed as we create windows
		// lets previousSnapshot honestly contain the same URL in two different windows
		const prev = [
			{ id: 1, tabs: [{ url: "https://shared.com" }] },
			{ id: 2, tabs: [{ url: "https://shared.com" }] },
		];
		const out = filterRestorableTabs(prev, new Set());

		assert.equal(out.length, 2);
	});

	test("handles empty/missing input safely", () => {
		assert.deepEqual(filterRestorableTabs(null, new Set()), []);
		assert.deepEqual(filterRestorableTabs(undefined, new Set()), []);
		assert.deepEqual(filterRestorableTabs([], new Set()), []);
		assert.deepEqual(filterRestorableTabs([{ id: 1 }], new Set()), []);
		assert.deepEqual(filterRestorableTabs([{ id: 1, tabs: [] }], new Set()), []);
	});
});

describe("findClosedWindows", () => {
	test("returns windows present before but gone now (matched by id)", () => {
		const prev = [
			{ id: 1, tabs: [{ url: "https://a.com" }] },
			{ id: 2, incognito: true, tabs: [{ url: "https://secret.com" }] },
		];
		const live = [{ id: 1, tabs: [{ url: "https://a.com" }] }];
		const out = findClosedWindows(prev, live);

		assert.equal(out.length, 1);
		assert.equal(out[0].id, 2);
		assert.equal(out[0].incognito, true);
		assert.deepEqual(out[0].tabs.map((t) => t.url), ["https://secret.com"]);
	});

	test("ignores windows that are still open", () => {
		const prev = [{ id: 1, tabs: [{ url: "https://a.com" }] }];
		const live = [{ id: 1, tabs: [{ url: "https://a.com" }, { url: "https://b.com" }] }];

		assert.deepEqual(findClosedWindows(prev, live), []);
	});

	test("drops closed windows whose tabs are all unrestorable", () => {
		const prev = [
			{ id: 2, tabs: [{ url: "chrome://newtab" }, { url: "chrome-extension://x/y" }] },
			{ id: 3, tabs: [{ url: "https://keep.me" }] },
		];
		const out = findClosedWindows(prev, []);

		assert.equal(out.length, 1);
		assert.equal(out[0].id, 3);
	});

	test("keeps only the restorable tabs of a closed window", () => {
		const prev = [
			{ id: 2, tabs: [{ url: "https://keep.me" }, { url: "chrome://settings" }] },
		];
		const out = findClosedWindows(prev, []);

		assert.deepEqual(out[0].tabs.map((t) => t.url), ["https://keep.me"]);
	});

	test("handles empty/missing input safely", () => {
		assert.deepEqual(findClosedWindows(null, null), []);
		assert.deepEqual(findClosedWindows(undefined, undefined), []);
		assert.deepEqual(findClosedWindows([], []), []);
		assert.deepEqual(findClosedWindows([{ id: 1, tabs: [] }], []), []);
	});
});

describe("windowSignature", () => {
	test("is the join of tab urls", () => {
		assert.equal(
			windowSignature({ tabs: [{ url: "https://a.com" }, { url: "https://b.com" }] }),
			"https://a.com\nhttps://b.com",
		);
	});

	test("ignores window id/incognito — content is identity", () => {
		const a = { id: 1, incognito: false, tabs: [{ url: "https://a.com" }] };
		const b = { id: 99, incognito: true, tabs: [{ url: "https://a.com" }] };

		assert.equal(windowSignature(a), windowSignature(b));
	});

	test("handles missing tabs", () => {
		assert.equal(windowSignature({}), "");
	});
});

describe("dedupeWindows", () => {
	test("drops a later window with the same tab-url signature, keeping the first", () => {
		const first = { id: 1, source: "previous", tabs: [{ url: "https://a.com" }] };
		const dup = { id: 2, source: "recent", tabs: [{ url: "https://a.com" }] };
		const out = dedupeWindows([first, dup]);

		assert.equal(out.length, 1);
		assert.equal(out[0].source, "previous");
	});

	test("keeps windows whose tab sets differ", () => {
		const a = { tabs: [{ url: "https://a.com" }] };
		const b = { tabs: [{ url: "https://a.com" }, { url: "https://b.com" }] };

		assert.equal(dedupeWindows([a, b]).length, 2);
	});

	test("handles empty/missing input safely", () => {
		assert.deepEqual(dedupeWindows(null), []);
		assert.deepEqual(dedupeWindows(undefined), []);
		assert.deepEqual(dedupeWindows([]), []);
	});
});
