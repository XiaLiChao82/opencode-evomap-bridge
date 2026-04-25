import { describe, expect, test } from "bun:test";
import { renderAdvisories } from "../src/advisory.ts";

describe("renderAdvisories", () => {
	test("renders a sentinel-wrapped advisory block", () => {
		const rendered = renderAdvisories([
			{
				id: "adv-1",
				tool: "bash",
				message: "Avoid repeating the same failing bash command.",
				observationId: "obs-1",
				createdAt: new Date().toISOString(),
				lastUsedAt: null,
				useCount: 0,
				maxUses: 3,
				cooldownUntil: null,
				pathHints: [],
				source: "session",
			},
		]);

		expect(rendered).toContain("<!-- evomap-bridge:advisory -->");
		expect(rendered).toContain("Avoid repeating the same failing bash command.");
	});
});
