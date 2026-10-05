/**
 * `/commandcode` slash command: status, catalog refresh, model inventory.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CATALOG, CATALOG_GENERATED_AT } from "./catalog/models.generated.ts";
import { DEFAULT_BASE_URL, PROVIDER_ID, PROVIDER_NAME, catalogTtlMs, isZdrEnabled } from "./endpoints.ts";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Auth source, catalog age, model counts" },
	{ value: "refresh", label: "refresh", description: "Force a live catalog refresh" },
	{ value: "models", label: "models", description: "List registered models by protocol" },
	{ value: "help", label: "help", description: "Show usage" },
];

function emit(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, type);
	else console.log(text);
}

async function status(ctx: ExtensionCommandContext): Promise<void> {
	const provider = ctx.modelRegistry.getProvider(PROVIDER_ID);
	const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	const chat = provider?.getModels() ?? [];
	const all = provider?.getAllModels?.() ?? chat;
	const classifierCount = all.filter((model) => model.type === "classifier").length;
	const ttlHours = Math.max(1, Math.round(catalogTtlMs() / 3_600_000));

	const lines = [
		`${PROVIDER_NAME} provider`,
		`  base URL   ${provider?.baseUrl ?? DEFAULT_BASE_URL}`,
		`  auth       ${auth?.source ?? "not configured (run /login commandcode)"}`,
		`  models     ${chat.length} chat${classifierCount > 0 ? ` + ${classifierCount} classifier` : ""}`,
		`  catalog    ${CATALOG.length} bundled entries (generated ${CATALOG_GENERATED_AT})`,
		`  refresh    live check every ${ttlHours}h, cached across sessions`,
		`  ZDR        ${isZdrEnabled() ? "on (x-cmd-zdr: 1)" : "off (set CMD_ZDR=1 to enable)"}`,
	];
	if (chat.length > 0 && chat.length < CATALOG.length) {
		lines.push(
			`  note       fewer models than the bundled catalog (${CATALOG.length}) - a models.json entry may be overriding this provider`,
		);
	}
	emit(ctx, lines.join("\n"));
}

async function refresh(ctx: ExtensionCommandContext): Promise<void> {
	const provider = ctx.modelRegistry.getProvider(PROVIDER_ID);
	const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
	const error = result.errors.get(PROVIDER_ID);
	if (error) {
		emit(ctx, `${PROVIDER_NAME} catalog refresh failed: ${error.message}`, "error");
		return;
	}
	const count = provider?.getModels().length ?? 0;
	emit(ctx, `${PROVIDER_NAME} catalog refreshed: ${count} models.`);
}

function models(ctx: ExtensionCommandContext): void {
	const provider = ctx.modelRegistry.getProvider(PROVIDER_ID);
	const chat = provider?.getModels() ?? [];
	if (chat.length === 0) {
		emit(ctx, `${PROVIDER_NAME} has no registered models yet.`, "warning");
		return;
	}
	const byApi = new Map<string, number>();
	for (const model of chat) byApi.set(model.api, (byApi.get(model.api) ?? 0) + 1);

	const lines = [`${PROVIDER_NAME} models (${chat.length}):`];
	for (const [api, count] of [...byApi.entries()].sort()) lines.push(`  ${api}: ${count}`);
	lines.push("");
	for (const model of chat.slice(0, 60)) {
		lines.push(`  ${model.id}  [${model.api}]  ctx=${model.contextWindow}`);
	}
	if (chat.length > 60) lines.push(`  ... ${chat.length - 60} more`);
	emit(ctx, lines.join("\n"));
}

function help(ctx: ExtensionCommandContext): void {
	emit(
		ctx,
		[
			"Usage: /commandcode [status|refresh|models|help]",
			"",
			"  status   auth source, catalog age, model counts (default)",
			"  refresh  force a live /models fetch and persist the result",
			"  models   list registered models with their wire protocol",
			"  help     this text",
			"",
			"Environment: COMMANDCODE_API_KEY (or CMD_API_KEY) for headless auth,",
			"CMD_ZDR=1 for zero-data-retention routing, PI_COMMANDCODE_TTL_MS to",
			"override the 6h catalog freshness window.",
		].join("\n"),
	);
}

export function registerCommandCodeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("commandcode", {
		description: "Command Code provider: status, catalog refresh, model list",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			return SUBCOMMANDS.filter((item) => item.value.startsWith(query));
		},
		handler: async (args, ctx) => {
			const subcommand = args.trim().toLowerCase() || "status";
			switch (subcommand) {
				case "status":
					await status(ctx);
					break;
				case "refresh":
					await refresh(ctx);
					break;
				case "models":
					models(ctx);
					break;
				case "help":
					help(ctx);
					break;
				default:
					emit(ctx, `Unknown subcommand "${subcommand}". Run /commandcode help.`, "warning");
			}
		},
	});
}
