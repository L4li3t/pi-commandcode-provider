#!/usr/bin/env node
/**
 * Regenerate src/catalog/models.generated.ts from the live Command Code
 * catalog plus upstream metadata.
 *
 * Metadata sources, lowest precedence first:
 *   1. models.dev            cost, limits, modalities, reasoning
 *   2. Pi's built-in catalog cost, limits, reasoning, thinking maps, compat
 *   3. seed-facts.json       per-model Command Code capability tags
 *   4. overrides.json        hand-maintained corrections (highest)
 *   5. --probe-vision        empirical image support, overrides every vision flag
 *
 * The live /models response is authoritative for id, name, context window and
 * supported_endpoints. Cost and capability metadata come from the sources
 * above because /models does not carry them.
 *
 * Usage:
 *   node scripts/sync-catalog.mjs                     # fast sync (1 request)
 *   node scripts/sync-catalog.mjs --probe-vision      # + one tiny probe per model
 *   node scripts/sync-catalog.mjs --no-modelsdev
 *   node scripts/sync-catalog.mjs --dry-run
 *
 * Credentials come from COMMANDCODE_API_KEY, CMD_API_KEY, or the Command Code
 * CLI's ~/.commandcode/auth.json.
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_FILE = join(ROOT, "src", "catalog", "models.generated.ts");
const REPORT_FILE = join(ROOT, "catalog-report.json");
const OVERRIDES_FILE = join(HERE, "overrides.json");
const SEED_FILE = join(HERE, "seed-facts.json");
const CACHE_DIR = join(HERE, ".cache");
const MODELSDEV_CACHE = join(CACHE_DIR, "models-dev.json");
const BASE_URL = process.env.COMMANDCODE_BASE_URL ?? "https://api.commandcode.ai/provider/v1";
const USER_AGENT = "pi-commandcode-provider/sync";

const args = new Set(process.argv.slice(2));
const flag = (name) => args.has(name);
const option = (name, fallback) => {
	const index = process.argv.indexOf(name);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const PROBE_VISION = flag("--probe-vision");
const DRY_RUN = flag("--dry-run");
const USE_MODELSDEV = !flag("--no-modelsdev");
const REFRESH_MODELSDEV = flag("--refresh-modelsdev");
const SLEEP_MS = Number(option("--sleep", "250"));

// ── credentials ────────────────────────────────────────────────────────────

function loadApiKey() {
	if (process.env.COMMANDCODE_API_KEY?.trim()) return process.env.COMMANDCODE_API_KEY.trim();
	if (process.env.CMD_API_KEY?.trim()) return process.env.CMD_API_KEY.trim();
	const legacy = join(homedir(), ".commandcode", "auth.json");
	if (existsSync(legacy)) {
		try {
			const key = JSON.parse(readFileSync(legacy, "utf8")).apiKey;
			if (typeof key === "string" && key.trim()) return key.trim();
		} catch {
			/* fall through */
		}
	}
	throw new Error("No Command Code API key. Set COMMANDCODE_API_KEY or log in with the CLI first.");
}

// ── normalization + candidate matching ─────────────────────────────────────

const norm = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9.]/g, "");
const slugOf = (id) => String(id).split("/").pop() ?? String(id);
const vendorOf = (id) => (String(id).includes("/") ? String(id).split("/")[0] : "");

const VENDOR_TO_PROVIDER = {
	deepseek: "deepseek",
	"z-ai": "zai",
	"zai-org": "zai",
	moonshotai: "moonshotai",
	minimaxai: "minimax",
	google: "google",
	xai: "xai",
	meta: "meta",
	nvidia: "nvidia",
};

/**
 * Catalog providers that model flat-rate subscriptions: their per-token cost
 * is recorded as zero, which would understate real Command Code billing.
 * Other facts (limits, modalities, reasoning) are still useful.
 */
const SUBSCRIPTION_PROVIDERS = new Set([
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"kimi-coding",
	"zai-coding-cn",
]);

function vendorProvider(id) {
	const vendor = vendorOf(id).toLowerCase();
	if (VENDOR_TO_PROVIDER[vendor]) return VENDOR_TO_PROVIDER[vendor];
	if (/^claude/.test(id)) return "anthropic";
	if (/^(gpt-|o[0-9])/.test(id)) return "openai";
	return vendor;
}

function tokensOf(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/(\d)\.(\d)/g, "$1$2")
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 1);
}

function tokenOverlap(a, b) {
	const left = new Set(tokensOf(a));
	const right = new Set(tokensOf(b));
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	return shared / Math.max(left.size, right.size);
}

function costIsZero(cost) {
	return Boolean(cost) && cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0;
}

/** Score a candidate against a live model; 0 means implausible. */
function scoreCandidate(model, candidate) {
	const provider = vendorProvider(model.id);
	const sameProvider = candidate.provider === provider;
	const slug = norm(slugOf(model.id));
	const candidateId = norm(candidate.id);
	const candidateSlug = norm(slugOf(candidate.id));
	const name = norm(model.name ?? "");
	const free = /:free$/i.test(model.id);

	let score = 0;
	if (candidateSlug === slug) score += 100;
	if (candidateId === slug) score += 90;
	if (name && name === norm(candidate.name)) score += sameProvider ? 85 : 45;
	const overlap = tokenOverlap(model.name ?? model.id, candidate.name ?? candidate.id);
	if (overlap >= 0.6) score += Math.round(overlap * 50);
	if (sameProvider) score += 75;
	if (candidate.source === "pi-ai") score += 15;
	// A zero cost from a subscription catalog or gateway understates billing.
	if (!free && costIsZero(candidate.facts?.cost)) score -= 30;
	if (score > 100 && !sameProvider && name !== norm(candidate.name)) score = 0;
	return score;
}

function bestCandidate(model, candidates, minScore = 80) {
	let best = null;
	let bestScore = 0;
	for (const candidate of candidates) {
		const score = scoreCandidate(model, candidate);
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return bestScore >= minScore ? best : null;
}

// ── metadata sources ───────────────────────────────────────────────────────

function factsFromPiAi(model, provider) {
	const facts = {
		...(typeof model.cost === "object" && model.cost ? { cost: model.cost } : {}),
		...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
		...(Array.isArray(model.input) ? { input: model.input } : {}),
		...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		...(model.promptCache ? { promptCache: model.promptCache } : {}),
		...(model.compat ? { compat: model.compat } : {}),
	};
	if (SUBSCRIPTION_PROVIDERS.has(provider)) delete facts.cost;
	return facts;
}

function factsFromModelsDev(model) {
	const facts = {};
	if (model.cost) {
		facts.cost = {
			input: model.cost.input ?? 0,
			output: model.cost.output ?? 0,
			cacheRead: model.cost.cache_read ?? 0,
			cacheWrite: model.cost.cache_write ?? 0,
		};
	}
	if (typeof model.limit?.output === "number") facts.maxTokens = model.limit.output;
	if (Array.isArray(model.modalities?.input)) facts.input = model.modalities.input;
	if (typeof model.reasoning === "boolean") facts.reasoning = model.reasoning;
	return facts;
}

function piAiDataRoots() {
	const roots = [];
	const explicit = option("--pi-ai-data", "");
	if (explicit) roots.push(explicit);
	try {
		const modelsJs = require.resolve("@earendil-works/pi-ai/models");
		roots.push(join(dirname(modelsJs), "providers", "data"));
	} catch {
		/* not installed locally */
	}
	const managed = process.env.PI_MANAGED_INSTALL_ROOT;
	if (managed && existsSync(join(managed, "releases"))) {
		for (const release of readdirSync(join(managed, "releases"))) {
			roots.push(
				join(managed, "releases", release, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"),
			);
		}
	}
	return roots;
}

function loadPiAiCandidates() {
	const candidates = [];
	const seen = new Set();
	for (const root of piAiDataRoots()) {
		if (seen.has(root) || !existsSync(root)) continue;
		seen.add(root);
		for (const file of readdirSync(root)) {
			if (!file.endsWith(".json")) continue;
			const provider = file.replace(/\.json$/u, "");
			let payload;
			try {
				payload = JSON.parse(readFileSync(join(root, file), "utf8"));
			} catch {
				continue;
			}
			for (const bucket of Object.values(payload)) {
				if (!bucket || typeof bucket !== "object") continue;
				for (const model of Object.values(bucket)) {
					if (!model || typeof model !== "object" || typeof model.id !== "string") continue;
					candidates.push({
						source: "pi-ai",
						provider: model.provider ?? provider,
						id: model.id,
						name: model.name,
						api: model.api,
						facts: factsFromPiAi(model, model.provider ?? provider),
					});
				}
			}
		}
	}
	return candidates;
}

async function loadModelsDevCandidates() {
	if (!USE_MODELSDEV) return [];
	let payload;
	if (!REFRESH_MODELSDEV && existsSync(MODELSDEV_CACHE) && Date.now() - statSync(MODELSDEV_CACHE).mtimeMs < 86_400_000) {
		payload = JSON.parse(readFileSync(MODELSDEV_CACHE, "utf8"));
	}
	if (!payload) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 20_000);
		try {
			const response = await fetch("https://models.dev/api.json", { signal: controller.signal });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			payload = await response.json();
			mkdirSync(CACHE_DIR, { recursive: true });
			writeFileSync(MODELSDEV_CACHE, JSON.stringify(payload));
		} catch (error) {
			console.warn(`  models.dev unavailable (${error.message}); continuing without it`);
			return [];
		} finally {
			clearTimeout(timer);
		}
	}
	const candidates = [];
	for (const [provider, data] of Object.entries(payload)) {
		for (const [id, model] of Object.entries(data.models ?? {})) {
			candidates.push({
				source: "models.dev",
				provider,
				id: model.id ?? id,
				name: model.name,
				facts: factsFromModelsDev(model),
			});
		}
	}
	return candidates;
}

// ── overrides + seed facts ─────────────────────────────────────────────────

function loadJson(path, fallback) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesPattern(id, pattern) {
	if (pattern === id) return true;
	if (!pattern.includes("*")) return false;
	return new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`).test(id);
}

function applyOverrides(overrides, id, facts) {
	for (const override of overrides) {
		const { match, ...rest } = override;
		if (match && matchesPattern(id, match)) Object.assign(facts, rest);
	}
	return facts;
}

// ── live catalog ───────────────────────────────────────────────────────────

async function fetchLiveCatalog(apiKey) {
	const response = await fetch(`${BASE_URL.replace(/\/+$/u, "")}/models`, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": USER_AGENT },
	});
	if (!response.ok) {
		throw new Error(`GET /models failed: HTTP ${response.status} ${await response.text().catch(() => "")}`);
	}
	const body = await response.json();
	const list = Array.isArray(body) ? body : (body.data ?? []);
	return list
		.filter((model) => typeof model?.id === "string")
		.map((model) => ({
			id: model.id,
			name: model.name,
			context_length: model.context_length,
			supported_endpoints: model.supported_endpoints ?? [],
			created: model.created,
		}));
}

// ── vision probe (ported from the Factory sync script) ─────────────────────

const PROBE_IMAGE_SIZE = 64;
const VISION_MAX_TOKENS = 900;
const VISION_QUESTION = "What single word describes the color of this image? Reply with one word.";
const RED_WORDS = /\b(red|crimson|scarlet|vermilion|ff0000|ff0)\b/i;
const NON_VERDICT_ERRORS = [
	"no available providers",
	"temporarily unavailable",
	"overloaded",
	"rate limit",
	"timed out",
	"timeout",
	"upstream",
	"bad request",
];

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buffer) {
	let crc = -1;
	for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
	return (crc ^ -1) >>> 0;
}

function redPngDataUri(size = PROBE_IMAGE_SIZE) {
	const pixel = Buffer.from([255, 0, 0, 255]);
	const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: size }, () => pixel)]);
	const raw = Buffer.concat(Array.from({ length: size }, () => row));
	const chunk = (tag, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(tag), data])));
		return Buffer.concat([length, Buffer.from(tag), data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 6; // RGBA
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
	return `data:image/png;base64,${png.toString("base64")}`;
}

function responseText(payload) {
	const choice = payload?.choices?.[0]?.message;
	if (choice) {
		if (typeof choice.content === "string") return choice.content;
		if (Array.isArray(choice.content)) return choice.content.map((part) => part?.text ?? "").join(" ");
	}
	const content = payload?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join(" ");
	return "";
}

function responseReasoning(payload) {
	const message = payload?.choices?.[0]?.message ?? {};
	for (const key of ["reasoning_content", "reasoning", "thinking"]) {
		if (typeof message[key] === "string" && message[key]) return message[key];
	}
	return "";
}

async function probeVision(model, apiKey) {
	const anthropic = model.id.startsWith("claude-");
	const url = `${BASE_URL.replace(/\/+$/u, "")}${anthropic ? "/messages" : "/chat/completions"}`;
	const headers = { "Content-Type": "application/json", "User-Agent": USER_AGENT };
	if (anthropic) {
		headers["x-api-key"] = apiKey;
		headers["anthropic-version"] = "2023-06-01";
	} else {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const dataUri = redPngDataUri();
	const content = anthropic
		? [
				{ type: "text", text: VISION_QUESTION },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: dataUri.split(",")[1] } },
			]
		: [
				{ type: "text", text: VISION_QUESTION },
				{ type: "image_url", image_url: { url: dataUri } },
			];

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: model.id, max_tokens: VISION_MAX_TOKENS, messages: [{ role: "user", content }] }),
			signal: AbortSignal.timeout(180_000),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			const lower = body.toLowerCase();
			if (NON_VERDICT_ERRORS.some((needle) => lower.includes(needle))) {
				return { verdict: "unknown", detail: `HTTP ${response.status} (not a verdict)` };
			}
			return { verdict: "no-image", detail: `HTTP ${response.status} ${body.slice(0, 100)}` };
		}
		const payload = await response.json();
		const text = responseText(payload).trim();
		const reasoning = responseReasoning(payload).trim();
		if (RED_WORDS.test(text)) return { verdict: "sees-image", detail: text.slice(0, 40) };
		if (RED_WORDS.test(reasoning)) return { verdict: "sees-image", detail: "reasoning named the colour" };
		if (!text && !reasoning) return { verdict: "no-image", detail: "empty response (image ignored)" };
		return { verdict: "unclear", detail: (text || reasoning).slice(0, 40) };
	} catch (error) {
		return { verdict: "unknown", detail: `NETERR ${error.message}` };
	}
}

// ── main ───────────────────────────────────────────────────────────────────

function render(entries, generatedAt) {
	const body = JSON.stringify(entries, null, "\t");
	return `/**
 * AUTO-GENERATED by scripts/sync-catalog.mjs - do not edit by hand.
 * Generated: ${generatedAt}
 * Models: ${entries.length}
 *
 * Run \`npm run sync\` (optionally with --probe-vision) to refresh.
 */

import type { CatalogEntry } from "./types.ts";

export const CATALOG_GENERATED_AT = ${JSON.stringify(generatedAt)};

export const CATALOG = ${body} satisfies CatalogEntry[];
`;
}

async function main() {
	const apiKey = loadApiKey();
	console.log(`Fetching ${BASE_URL}/models ...`);
	const live = await fetchLiveCatalog(apiKey);
	console.log(`Live catalog: ${live.length} models`);

	const piAi = loadPiAiCandidates();
	console.log(`Pi built-in candidates: ${piAi.length}`);
	const modelsDev = await loadModelsDevCandidates();
	console.log(`models.dev candidates: ${modelsDev.length}`);
	const seedFacts = loadJson(SEED_FILE, {});
	const overrides = loadJson(OVERRIDES_FILE, []);
	console.log(`Seed facts: ${Object.keys(seedFacts).length}  overrides: ${overrides.length}`);

	const { chooseApi } = await import(new URL("../src/endpoints.ts", import.meta.url).href);

	const entries = [];
	const report = [];
	let probed = 0;

	for (const model of live) {
		const routeApi = chooseApi(model.supported_endpoints, model.id);
		const facts = {};
		// Prefer the model vendor's own catalog over reseller gateways, then
		// fall back to the global pool. A weak provider-only fuzzy match must
		// not override a strong match from the other source, hence minScore.
		const vendor = vendorProvider(model.id);
		const modelsDevMatch =
			bestCandidate(model, modelsDev.filter((candidate) => candidate.provider === vendor)) ??
			bestCandidate(model, modelsDev);
		if (modelsDevMatch) Object.assign(facts, modelsDevMatch.facts);
		const piAiMatch =
			bestCandidate(model, piAi.filter((candidate) => candidate.provider === vendor), 130) ??
			bestCandidate(model, piAi, 130);
		if (piAiMatch) {
			const upstreamFacts = { ...piAiMatch.facts };
			// Compat quirks and thinking maps are protocol-specific: only carry
			// them over when the upstream API matches the routed one.
			if (piAiMatch.api && piAiMatch.api !== routeApi) {
				delete upstreamFacts.compat;
				delete upstreamFacts.thinkingLevelMap;
			}
			Object.assign(facts, upstreamFacts);
		}

		const seed = seedFacts[model.id];
		if (seed) Object.assign(facts, seed);
		applyOverrides(overrides, model.id, facts);

		// An output limit can never exceed the context window.
		if (typeof facts.maxTokens === "number" && model.context_length && facts.maxTokens > model.context_length) {
			facts.maxTokens = model.context_length;
		}

		let vision = null;
		if (PROBE_VISION) {
			vision = await probeVision(model, apiKey);
			probed += 1;
			if (vision.verdict === "sees-image") facts.input = ["text", "image"];
			else if (vision.verdict === "no-image") facts.input = ["text"];
			console.log(
				`  [${String(probed).padStart(3)}/${live.length}] ${model.id.padEnd(44)} ${vision.verdict.padEnd(11)} ${vision.detail}`,
			);
			if (SLEEP_MS > 0) await new Promise((done) => setTimeout(done, SLEEP_MS));
		}

		entries.push({
			id: model.id,
			name: model.name,
			contextWindow: model.context_length,
			endpoints: model.supported_endpoints,
			...facts,
		});
		report.push({
			id: model.id,
			vision: vision?.verdict ?? null,
			modelsDev: modelsDevMatch ? `${modelsDevMatch.provider}/${modelsDevMatch.id}` : null,
			piAi: piAiMatch ? `${piAiMatch.provider}/${piAiMatch.id}` : null,
			seed: Boolean(seed),
			override: overrides.some((override) => override.match && matchesPattern(model.id, override.match)),
			endpoints: model.supported_endpoints,
		});
	}

	const withCost = entries.filter((entry) => entry.cost).length;
	const withVision = entries.filter((entry) => entry.input?.includes("image")).length;
	const withReasoning = entries.filter((entry) => entry.reasoning === true).length;
	const unmatched = report.filter((item) => !item.modelsDev && !item.piAi).map((item) => item.id);
	const changedVision = PROBE_VISION
		? report.filter((item) => item.vision === "sees-image" || item.vision === "no-image").length
		: 0;

	const generatedAt = new Date().toISOString();
	writeFileSync(
		REPORT_FILE,
		JSON.stringify(
			{ generatedAt, baseUrl: BASE_URL, count: entries.length, withCost, withVision, withReasoning, changedVision, unmatched, report, entries },
			null,
			2,
		),
	);

	console.log("");
	console.log(`Entries: ${entries.length}  cost: ${withCost}  vision: ${withVision}  reasoning: ${withReasoning}`);
	if (unmatched.length > 0) {
		console.log(`Unmatched (family defaults only): ${unmatched.join(", ")}`);
	}
	console.log(`Report: ${REPORT_FILE}`);

	if (DRY_RUN) {
		console.log("Dry run: not writing models.generated.ts");
		return;
	}
	writeFileSync(OUT_FILE, render(entries, generatedAt));
	console.log(`Wrote ${OUT_FILE}`);
}

main().catch((error) => {
	console.error(error.stack ?? error.message ?? error);
	process.exitCode = 1;
});
