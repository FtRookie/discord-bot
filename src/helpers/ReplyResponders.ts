import type { Message } from "discord.js";
import { Perms, PermsOf } from "./Permissions.ts";

// A reply whose text contains `match` gets a response computed from the message it replies to — which is what
// separates these from Replies.ts, where a keyword maps to static text.
type ReplyResponder = {
	match: string;
	allow: number; // the triggering user must hold at least one of these bits (Permissions.ts)
	respond: (reply: Message, referenced: Message) => Promise<boolean>;
};

// first custom emoji in a message: <:name:id>, or animated <a:name:id>
const CUSTOM_EMOJI = /<(a)?:\w+:(\d+)>/;

/**
 * "Jarvis, enhance" → repost the referenced message's first custom emoji as its CDN image. Posting the bare
 * link is what does the work: Discord embeds it at image size, far larger than the inline emoji, with no
 * download, resize or re-encode on this side — the CDN serves it as-is, and animated stays a gif.
 */
async function enhanceEmoji(reply: Message, referenced: Message): Promise<boolean> {
	const match = referenced.content.match(CUSTOM_EMOJI);
	if (!match) return false;
	const animated = match[1] === "a";
	const id = match[2];
	if (!id) return false;

	const url = `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}`;
	await reply.reply({ content: url, allowedMentions: { parse: [] } }).catch(() => {});
	return true;
}

const responders: ReplyResponder[] = [
	{ match: "jarvis enhance", allow: Perms.Owner | Perms.Inspect, respond: enhanceEmoji },
];

// strips Unicode punctuation, so "Jarvis, enhance!" still matches "jarvis enhance"
const strip = (text: string) => text.replace(/\p{P}/gu, "");

/**
 * True when a responder handled the message, so the caller can stop before the generic keyword handlers. The
 * cheap checks — is-a-reply, phrase match, permission — all run before the reference is fetched.
 */
export async function RespondToReplyPhrase(message: Message): Promise<boolean> {
	if (!message.reference?.messageId) return false;
	const phrase = strip(message.content.toLowerCase());
	const responder = responders.find((r) => phrase.includes(r.match));
	if (!responder) return false;
	if ((PermsOf(message.author.id) & responder.allow) === 0) return false;

	const referenced = await message.fetchReference().catch(() => null);
	if (!referenced) return false;
	return responder.respond(message, referenced);
}
