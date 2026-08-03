// wink-lemmatizer ships no types; it's a CommonJS object of lemmatizers keyed by part of speech.
declare module "wink-lemmatizer" {
	const lemmatizer: {
		noun(word: string): string;
		verb(word: string): string;
		adjective(word: string): string;
	};
	export default lemmatizer;
}
