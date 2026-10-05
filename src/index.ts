/**
 * Command Code provider for Pi.
 *
 * Registers a native provider (so `/login` and `/model` work like any built-in
 * provider) plus the `/commandcode` diagnostic command.
 *
 * Run directly while developing:
 *   pi -e ./src/index.ts --list-models commandcode --offline
 *   pi -e ./src/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommandCodeCommand } from "./command.ts";
import { PROVIDER_ID } from "./endpoints.ts";
import { createCommandCodeProvider } from "./provider.ts";

export default function commandCodeProviderExtension(pi: ExtensionAPI): void {
	pi.registerProvider(createCommandCodeProvider());
	registerCommandCodeCommand(pi);

	pi.on("session_start", (_event, ctx) => {
		// Pi restores the cached catalog at startup and only fetches when asked,
		// so kick a background refresh here. The provider still enforces its TTL,
		// which makes this one no-op instead of one request on every session.
		void ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] }).catch(() => undefined);
	});
}

export { createCommandCodeProvider } from "./provider.ts";
export { CATALOG, CATALOG_GENERATED_AT } from "./catalog/models.generated.ts";
