/**
 * Live wire-format smoke tests against the Command Code Provider API.
 *
 * These run only when COMMANDCODE_API_KEY (or CMD_API_KEY, or the Command
 * Code CLI auth file) is available, and they skip models the current plan
 * cannot reach instead of failing. They validate what Pi relies on:
 * catalog discovery, chat streaming with usage, the Responses API, the
 * Anthropic Messages API, and tool calls.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const BASE_URL = process.env.COMMANDCODE_BASE_URL ?? "https://api.commandcode.ai/provider/v1";

function loadKey(): string | undefined {
	if (process.env.COMMANDCODE_API_KEY?.trim()) return process.env.COMMANDCODE_API_KEY.trim();
	if (process.env.CMD_API_KEY?.trim()) return process.env.CMD_API_KEY.trim();
	const legacy = join(homedir(), ".commandcode", "auth.json");
	if (existsSync(legacy)) {
		try {
			const key = JSON.parse(readFileSync(legacy, "utf8")).apiKey;
			if (typeof key === "string" && key.trim()) return key.trim();
		} catch {
			/* ignore */
		}
	}
	return undefined;
}

const API_KEY = loadKey();
const skip = API_KEY ? false : "no Command Code API key";

interface Result {
	status: number;
	body: unknown;
}

async function post(
	path: string,
	body: Record<string, unknown>,
	options: { anthropic?: boolean; stream?: boolean } = {},
): Promise<Result & { text: string }> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (options.anthropic) {
		headers["x-api-key"] = API_KEY as string;
		headers["anthropic-version"] = "2023-06-01";
	} else {
		headers.Authorization = `Bearer ${API_KEY}`;
	}
	const response = await fetch(`${BASE_URL.replace(/\/+$/u, "")}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(120_000),
	});
	const text = await response.text();
	let parsed: unknown = text;
	try {
		parsed = text ? JSON.parse(text) : undefined;
	} catch {
		/* keep raw text */
	}
	return { status: response.status, body: parsed, text };
}

function planSkip(status: number): string | undefined {
	if (status === 403) return "model not in the current plan";
	if (status === 422) return "model has no ZDR-capable upstream";
	if (status === 401) throw new Error("Command Code rejected the API key (401)");
	return undefined;
}

test("GET /models returns the live catalog", { skip }, async () => {
	const response = await fetch(`${BASE_URL.replace(/\/+$/u, "")}/models`, {
		headers: { Authorization: `Bearer ${API_KEY}` },
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as { data?: Array<{ id?: string; supported_endpoints?: string[] }> };
	assert.ok(Array.isArray(body.data) && body.data.length > 0);
	for (const model of body.data.slice(0, 20)) {
		assert.equal(typeof model.id, "string");
		assert.ok(Array.isArray(model.supported_endpoints));
	}
});

test("chat completions streams text and reports usage", { skip }, async (t) => {
	const model = "deepseek/deepseek-v4.1-flash";
	const response = await fetch(`${BASE_URL.replace(/\/+$/u, "")}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "Reply with the single word: pong" }],
			max_tokens: 32,
			stream: true,
			stream_options: { include_usage: true },
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const skipped = planSkip(response.status);
	if (skipped) {
		t.skip(skipped);
		return;
	}
	assert.equal(response.status, 200);
	const text = await response.text();
	assert.match(text, /data:/);
	assert.match(text, /\[DONE\]/);
	const usageChunk = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter((line) => line && line !== "[DONE]")
		.map((line) => JSON.parse(line) as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
		.find((chunk) => chunk.usage);
	assert.ok(usageChunk?.usage, "expected a final usage chunk");
});

test("chat completions performs tool calls", { skip }, async (t) => {
	const result = await post("/chat/completions", {
		model: "deepseek/deepseek-v4.1-flash",
		messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
		max_tokens: 256,
		tools: [
			{
				type: "function",
				function: {
					name: "get_weather",
					description: "Get the current weather for a city",
					parameters: {
						type: "object",
						properties: { city: { type: "string" } },
						required: ["city"],
					},
				},
			},
		],
	});
	const skipped = planSkip(result.status);
	if (skipped) {
		t.skip(skipped);
		return;
	}
	assert.equal(result.status, 200);
	const message = (result.body as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> }).choices?.[0]?.message;
	assert.ok(Array.isArray(message?.tool_calls) && message.tool_calls.length > 0, "expected a tool call");
});

test("responses endpoint answers GPT-family models", { skip }, async (t) => {
	const result = await post("/responses", {
		model: "gpt-5.6-luna",
		input: "Reply with the single word: pong",
		max_output_tokens: 64,
	});
	const skipped = planSkip(result.status);
	if (skipped) {
		t.skip(skipped);
		return;
	}
	assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300));
	const body = result.body as { output?: unknown[]; status?: string };
	assert.ok(Array.isArray(body.output), "expected a Responses API payload");
});

test("messages endpoint answers Claude models", { skip }, async (t) => {
	const result = await post(
		"/messages",
		{
			model: "claude-opus-5",
			max_tokens: 32,
			messages: [{ role: "user", content: "Reply with the single word: pong" }],
		},
		{ anthropic: true },
	);
	const skipped = planSkip(result.status);
	if (skipped) {
		t.skip(skipped);
		return;
	}
	assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300));
	const body = result.body as { content?: unknown[]; usage?: { input_tokens?: number } };
	assert.ok(Array.isArray(body.content), "expected an Anthropic Messages payload");
	assert.ok(typeof body.usage?.input_tokens === "number", "expected usage");
});

test("wrong endpoint for a model is rejected with a 400 (routing must avoid it)", { skip }, async (t) => {
	const result = await post("/chat/completions", {
		model: "claude-opus-5",
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 16,
	});
	if (result.status === 403) {
		t.skip("plan");
		return;
	}
	assert.equal(result.status, 400);
});
