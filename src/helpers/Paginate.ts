import type { ChatInputCommandInteraction } from "discord.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";

/** Comfortably inside the 15-minute interaction-token window, so a late click fails cleanly rather than errors. */
const PAGE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Renders `pages` one at a time under ◀ ▶ controls on an already-deferred reply. A single page is sent plain,
 * with no buttons. The collector is scoped to the invoking user and freezes the controls once it expires, so
 * stale buttons don't look clickable.
 */
export async function paginate(interaction: ChatInputCommandInteraction, pages: string[]): Promise<void> {
	if (pages.length <= 1) {
		await interaction.editReply({ content: pages[0] ?? "_Nothing to show._", allowedMentions: { parse: [] } });
		return;
	}

	let page = 0;
	const controls = (index: number, active: boolean) =>
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId("prev")
				.setLabel("◀")
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(!active || index === 0),
			new ButtonBuilder()
				.setCustomId("page")
				.setLabel(`${index + 1} / ${pages.length}`)
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(true),
			new ButtonBuilder()
				.setCustomId("next")
				.setLabel("▶")
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(!active || index === pages.length - 1),
		);

	const message = await interaction.editReply({
		content: pages[page],
		components: [controls(page, true)],
		allowedMentions: { parse: [] },
	});
	const collector = message.createMessageComponentCollector({
		componentType: ComponentType.Button,
		time: PAGE_TIMEOUT_MS,
		filter: (i) => i.user.id === interaction.user.id,
	});

	collector.on("collect", async (i) => {
		page = Math.max(0, Math.min(i.customId === "next" ? page + 1 : page - 1, pages.length - 1));
		await i.update({ content: pages[page], components: [controls(page, true)] });
	});

	collector.on("end", () => {
		void interaction.editReply({ components: [controls(page, false)] }).catch(() => {});
	});
}
