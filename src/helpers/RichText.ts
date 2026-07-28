/** XML character escapes Roblox rich text uses for literal <, >, ", '. (&amp; is handled separately.) */
const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'" };

function fromCodePoint(n: number): string {
	return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** Decode Roblox rich-text escapes. &amp; goes last, so "&amp;lt;" stays "&lt;" instead of collapsing to "<". */
function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => fromCodePoint(Number(dec)))
		.replace(/&(lt|gt|quot|apos);/g, (whole, name) => NAMED_ENTITIES[name] ?? whole)
		.replace(/&amp;/g, "&");
}

/**
 * Convert Roblox rich-text markup (an XML-like subset) to Discord markdown: <b>/<i>/<u>/<s> map to their
 * markdown equivalents, <br/> to a newline, and container tags like <font>/<stroke> are dropped while their
 * inner text is kept. Escapes are decoded afterward, so a literal "&lt;" ends up as "<" rather than being
 * re-read as a tag. Only these known tags are rewritten, so a stray "<" or ">" in prose is left untouched.
 * Plain text with no markup passes through unchanged.
 */
export function richTextToMarkdown(input: string): string {
	return decodeEntities(
		input
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/?b>/gi, "**")
			.replace(/<\/?i>/gi, "*")
			.replace(/<\/?u>/gi, "__")
			.replace(/<\/?(?:s|strike)>/gi, "~~")
			.replace(/<\/?(?:font|stroke)\b[^>]*>/gi, ""),
	);
}
