import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(projectRoot, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));

const EXPECTED_FILES = [
	"assets/wordlogo.png",
	"background.js",
	"lib.js",
	"manifest.json",
	"popup.html",
	"popup.js",
	"style.css",
].sort();


test("manifest.json and package.json declare the same version", () => {
	// bump-version.js writes both in lockstep — drift means someone hand-edited
	// one without the other, or a bump path missed package.json.
	assert.equal(pkg.version, manifest.version);
});


test("npm run release produces a zip with exactly the expected files", () => {
	// BUMP=none keeps the test side-effect-free — without it, every test run
	// would mutate manifest.json's version. The bump function itself is unit
	// tested in scripts/bump-version.test.js.
	execFileSync("npm", ["run", "release"], {
		cwd: projectRoot,
		stdio: "pipe",
		env: { ...process.env, BUMP: "none" },
	});

	const zipPath = join(projectRoot, "release", `total-recall-${manifest.version}.zip`);

	assert.ok(existsSync(zipPath), `expected release zip at ${zipPath}`);

	const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
	const actual = listing.trim().split("\n").sort();

	// An exact-match assertion is intentional: the moment someone adds a file
	// that popup.html or background.js references but the zip doesn't ship
	// (or vice versa), this test forces an explicit update here.
	assert.deepEqual(actual, EXPECTED_FILES);
});
