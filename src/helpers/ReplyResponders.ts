import type { Message } from "discord.js";
import { Perms, permsOf } from "./Permissions.ts";

// A reply whose text contains `match` gets a response computed from the message it replies to. This is
// what sets it apart from Replies.ts (static keyword → text): the responder reads the replied-to message.
type ReplyResponder = {
	match: string;
	/** The triggering user must hold at least one of these permission bits (see Permissions.ts). */
	allow: number;
	respond: (reply: Message, referenced: Message) => Promise<boolean>;
};

// First custom emoji in a message: <:name:id>, or animated <a:name:id>.
const CUSTOM_EMOJI = /<(a)?:\w+:(\d+)>/;

/**
 * "Jarvis, enhance" → repost the referenced message's first custom emoji as its CDN image. Posting the bare
 * link is the whole trick: Discord embeds it at image size — far larger than the inline emoji — while we do
 * no downloading, resizing, or re-encoding of our own; the CDN serves it as-is (animated stays a gif).
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

// Strip Unicode punctuation so "Jarvis, enhance!" still matches "jarvis enhance".
const strip = (text: string) => text.replace(/\p{P}/gu, "");

/**
 * When a reply's text carries a responder phrase, run that responder against the message it replies to.
 * Returns true if one handled it, so the caller can stop before the generic keyword handlers. The cheap
 * checks (is-a-reply, phrase match, permission) all run before the reference is fetched.
 */
export async function respondToReplyPhrase(message: Message): Promise<boolean> {
	if (!message.reference?.messageId) return false;
	const phrase = strip(message.content.toLowerCase());
	const responder = responders.find((r) => phrase.includes(r.match));
	if (!responder) return false;
	if ((permsOf(message.author.id) & responder.allow) === 0) return false;

	const referenced = await message.fetchReference().catch(() => null);
	if (!referenced) return false;
	return responder.respond(message, referenced);
}
