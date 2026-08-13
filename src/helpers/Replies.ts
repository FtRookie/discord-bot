import { KeywordStore } from "./KeywordStore.ts";

// case-insensitive substrings matched anywhere in a message → text reply
export const Replies = KeywordStore("replies", "text");
