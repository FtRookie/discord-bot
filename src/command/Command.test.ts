import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "./Command.ts";
import { Commands } from "./Commands.ts";

// Discord's documented ceilings. The builder enforces the name and description ones itself and rejects a 26th
// choice, but it accepts a 26th option and lets duplicate option names through, so those fail at registration
// rather than here — which is a boot the bot does not survive.
const MAX_OPTIONS = 25;

const commandsDir = join(import.meta.dirname, "commands");

const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
	});

/**
 * Loaded by walking the directory rather than reading index.ts's list, for two reasons: importing index.ts
 * logs the bot in, and a command file that throws on import takes the process down whether or not anything
 * registered it.
 */
const loaded = await Promise.all(
	walk(commandsDir)
		.filter((path) => !path.endsWith(".test.ts"))
		.sort()
		.map(async (path) => {
			const module = (await import(path)) as Record<string, unknown>;
			const command = Object.values(module).find(
				(value): value is Command => typeof value === "object" && value !== null && "data" in value,
			);
			return { path: path.slice(commandsDir.length + 1), command };
		}),
);

type Option = { name: string; description: string; required?: boolean; options?: Option[] };

/** Subcommands nest their own options one level down, and Discord applies the same ceilings to both. */
const optionGroups = (options: Option[] = []): Option[][] => [
	options,
	...options.flatMap((option) => (option.options ? optionGroups(option.options) : [])),
];

describe("command registration", () => {
	test("the walk found commands, so an empty pass cannot look like a green one", () => {
		expect(loaded.length).toBeGreaterThan(0);
	});

	for (const { path, command } of loaded) {
		describe(path, () => {
			// The import above is the real assertion — a module that throws at load never reaches this point,
			// which is exactly how an invalid option name took the bot down rather than failing a check.
			test("exports a Command", () => {
				expect(command).toBeDefined();
			});

			test("serializes", () => {
				expect(() => command?.data.toJSON()).not.toThrow();
			});

			test("stays inside Discord's limits, with no duplicate or misordered options", () => {
				const json = command?.data.toJSON() as { name: string; options?: Option[] };

				for (const group of optionGroups(json.options)) {
					expect(group.length).toBeLessThanOrEqual(MAX_OPTIONS);

					const names = group.map((option) => option.name);
					expect(names).toEqual([...new Set(names)]);

					// Discord rejects a required option declared after an optional one at registration time.
					const lastRequired = names.length - 1 - [...group].reverse().findIndex((o) => o.required);
					const firstOptional = group.findIndex((o) => !o.required);
					if (group.some((o) => o.required) && firstOptional !== -1) {
						expect(lastRequired).toBeLessThan(firstOptional);
					}
				}
			});
		});
	}

	test("no two commands share a name", () => {
		const names = loaded.map(({ command }) => command?.data.name).filter(Boolean);
		expect(names).toEqual([...new Set(names)]);
	});

	// Nothing scans commands/ at runtime, so a file missing from the registry is simply never registered —
	// silently, with no error anywhere.
	test("every command file is registered in Commands.ts", () => {
		const registered = new Set(Commands.map((command) => command.data.name));
		const unregistered = loaded
			.filter(({ command }) => command && !registered.has(command.data.name))
			.map(({ path }) => path);
		expect(unregistered).toEqual([]);
	});
});
