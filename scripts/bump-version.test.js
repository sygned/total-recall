import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bump } from "./bump-version.js";


describe("bump", () => {
	test("patch is the default and increments the last segment", () => {
		assert.equal(bump("0.1.0"), "0.1.1");
		assert.equal(bump("0.1.0", "patch"), "0.1.1");
		assert.equal(bump("1.2.3", "patch"), "1.2.4");
	});

	test("minor increments the middle segment and resets patch", () => {
		assert.equal(bump("0.1.5", "minor"), "0.2.0");
		assert.equal(bump("1.0.0", "minor"), "1.1.0");
	});

	test("major increments the first segment and resets minor + patch", () => {
		assert.equal(bump("0.9.9", "major"), "1.0.0");
		assert.equal(bump("2.4.7", "major"), "3.0.0");
	});

	test("none returns the version unchanged — used by the release test", () => {
		assert.equal(bump("0.1.0", "none"), "0.1.0");
		assert.equal(bump("9.9.9", "none"), "9.9.9");
	});

	test("rejects non-semver inputs", () => {
		assert.throws(() => bump("0.1"), /unrecognised version/);
		assert.throws(() => bump("v1.0.0"), /unrecognised version/);
		assert.throws(() => bump("1.0.0-beta"), /unrecognised version/);
		assert.throws(() => bump(""), /unrecognised version/);
	});

	test("rejects unknown bump kinds", () => {
		assert.throws(() => bump("1.0.0", "huge"), /unknown bump kind/);
	});
});
