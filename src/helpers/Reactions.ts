import { KeywordStore } from "./KeywordStore.ts";

// case-insensitive substrings matched anywhere in a message → emoji reaction
export const Reactions = KeywordStore("reactions", "emoji");
