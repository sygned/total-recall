import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";


export function bump(version, kind = "patch") {
	if (kind === "none") return version;

	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

	if (!m) throw new Error(`unrecognised version: ${version}`);

	const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);

	switch (kind) {
		case "major": return `${major + 1}.0.0`;
		case "minor": return `${major}.${minor + 1}.0`;
		case "patch": return `${major}.${minor}.${patch + 1}`;
		default: throw new Error(`unknown bump kind: ${kind}`);
	}
}


function writeVersion(path, next) {
	const raw = readFileSync(path, "utf8");
	const obj = JSON.parse(raw);

	obj.version = next;

	const trailingNewline = raw.endsWith("\n") ? "\n" : "";

	writeFileSync(path, JSON.stringify(obj, null, "\t") + trailingNewline);
}


if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const kind = process.env.BUMP || "patch";
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	const next = bump(manifest.version, kind);

	if (next === manifest.version) {
		console.log(`version unchanged: ${manifest.version}`);
	} else {
		writeVersion("manifest.json", next);
		writeVersion("package.json", next);
		console.log(`version bumped: ${manifest.version} -> ${next}`);
	}
}
