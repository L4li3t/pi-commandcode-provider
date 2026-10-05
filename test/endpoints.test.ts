import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_CATALOG_TTL_MS,
	baseUrlForApi,
	chooseApi,
	chooseEndpoint,
	isZdrEnabled,
	catalogTtlMs,
	preferResponses,
} from "../src/endpoints.ts";

test("chooseEndpoint routes Claude-only models to /messages", () => {
	assert.equal(chooseEndpoint(["/messages"], "claude-opus-5"), "/messages");
	assert.equal(chooseEndpoint(["/messages"], "claude-haiku-4-5-20251001"), "/messages");
});

test("chooseEndpoint keeps chat-only models on /chat/completions", () => {
	assert.equal(chooseEndpoint(["/chat/completions"], "stealth/space-bunny-alpha"), "/chat/completions");
	assert.equal(chooseEndpoint(["/chat/completions"], "Qwen/Qwen3.8-Flash"), "/chat/completions");
});

test("chooseEndpoint prefers /responses for GPT-family models", () => {
	assert.equal(chooseEndpoint(["/chat/completions", "/responses"], "gpt-5.6-luna"), "/responses");
	assert.equal(chooseEndpoint(["/chat/completions", "/responses"], "gpt-6-astra"), "/responses");
});

test("chooseEndpoint defaults open models to /chat/completions when both work", () => {
	assert.equal(chooseEndpoint(["/chat/completions", "/responses"], "deepseek/deepseek-v4.1-flash"), "/chat/completions");
	assert.equal(chooseEndpoint(["/chat/completions", "/responses"], "z-ai/glm-5.3-flash"), "/chat/completions");
});

test("chooseEndpoint infers routing when supported_endpoints is missing", () => {
	assert.equal(chooseEndpoint(undefined, "claude-sonnet-5"), "/messages");
	assert.equal(chooseEndpoint([], "gpt-5.4"), "/responses");
	assert.equal(chooseEndpoint(undefined, "deepseek/deepseek-v4-pro"), "/chat/completions");
});

test("chooseApi maps endpoints to Pi api ids", () => {
	assert.equal(chooseApi(["/messages"], "claude-opus-5"), "anthropic-messages");
	assert.equal(chooseApi(["/responses"], "gpt-5.5"), "openai-responses");
	assert.equal(chooseApi(["/chat/completions"], "deepseek/deepseek-v4-flash"), "openai-completions");
});

test("preferResponses only matches GPT-family ids", () => {
	assert.equal(preferResponses("gpt-6-luna"), true);
	assert.equal(preferResponses("openai/gpt-6"), true);
	assert.equal(preferResponses("o3-mini"), true);
	assert.equal(preferResponses("deepseek/deepseek-v4-flash"), false);
});

test("isZdrEnabled follows the CLI's CMD_ZDR convention", () => {
	assert.equal(isZdrEnabled({}), false);
	assert.equal(isZdrEnabled({ CMD_ZDR: "0" }), false);
	assert.equal(isZdrEnabled({ CMD_ZDR: "1" }), true);
	assert.equal(isZdrEnabled({ CMD_ZDR: "true" }), true);
	assert.equal(isZdrEnabled({ CMD_ZDR: "TRUE" }), true);
});

test("catalogTtlMs uses the default and honors the override", () => {
	assert.equal(catalogTtlMs({}), DEFAULT_CATALOG_TTL_MS);
	assert.equal(catalogTtlMs({ PI_COMMANDCODE_TTL_MS: "1000" }), 1000);
	assert.equal(catalogTtlMs({ PI_COMMANDCODE_TTL_MS: "-5" }), DEFAULT_CATALOG_TTL_MS);
	assert.equal(catalogTtlMs({ PI_COMMANDCODE_TTL_MS: "nope" }), DEFAULT_CATALOG_TTL_MS);
});

test("anthropic models drop the /v1 suffix for the Anthropic SDK", () => {
	assert.equal(baseUrlForApi("https://api.commandcode.ai/provider/v1", "anthropic-messages"), "https://api.commandcode.ai/provider");
	assert.equal(baseUrlForApi("https://api.commandcode.ai/provider/v1/", "anthropic-messages"), "https://api.commandcode.ai/provider");
	assert.equal(baseUrlForApi("https://api.commandcode.ai/provider/v1", "openai-completions"), "https://api.commandcode.ai/provider/v1");
	assert.equal(baseUrlForApi("https://api.commandcode.ai/provider/v1", "openai-responses"), "https://api.commandcode.ai/provider/v1");
});
