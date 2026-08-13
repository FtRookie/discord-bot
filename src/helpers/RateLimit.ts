/** How many hits sit inside the window, and how long until the oldest of them leaves it. */
export type Window = { count: number; retryAfterMs: number };

/**
 * A per-key sliding window, counting hits rather than deciding what to do about them — the four callers all
 * react differently (two throw, one returns a verdict, one issues a Discord timeout), and only the arithmetic
 * was ever shared.
 *
 * `peek` and `hit` are separate because a rejected request must not extend the window that rejected it, which
 * is how /render and /userid have always behaved: they check first and record only on the way through.
 *
 * Pruning is lazy. A key is trimmed when it is next hit, so someone who never comes back keeps their last few
 * timestamps until then — bounded by the number of users who have ever run the command.
 */
export class RateWindow {
	private readonly hits = new Map<string, number[]>();

	constructor(private readonly windowMs: number) {}

	private live(key: string, now: number): number[] {
		return (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
	}

	private state(recent: number[], now: number): Window {
		const oldest = recent[0];
		// nothing recorded means nothing to wait for; `?? now` here would report a whole window instead
		return {
			count: recent.length,
			retryAfterMs: oldest === undefined ? 0 : Math.max(0, oldest + this.windowMs - now),
		};
	}

	/** Report the window without recording anything. */
	peek(key: string): Window {
		const now = Date.now();
		return this.state(this.live(key, now), now);
	}

	/** Record a hit, then report the window counting it. */
	hit(key: string): Window {
		const now = Date.now();
		const recent = this.live(key, now);
		recent.push(now);
		this.hits.set(key, recent);
		return this.state(recent, now);
	}

	/** Forget a key, for callers that reset the window on a breach rather than letting it drain. */
	clear(key: string): void {
		this.hits.delete(key);
	}
}
