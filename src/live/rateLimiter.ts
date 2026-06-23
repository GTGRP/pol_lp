// Minimal token-bucket rate limiter to stay within CLOB API limits.
export class RateLimiter {
	private tokens: number;
	private readonly capacity: number;
	private readonly refillPerSec: number;
	private last = Date.now();

	constructor(capacity = 8, refillPerSec = 4) {
		this.capacity = capacity;
		this.tokens = capacity;
		this.refillPerSec = refillPerSec;
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = (now - this.last) / 1000;
		this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
		this.last = now;
	}

	async acquire(): Promise<void> {
		this.refill();
		while (this.tokens < 1) {
			const waitMs = Math.ceil((1 - this.tokens) / this.refillPerSec * 1000);
			await new Promise((r) => setTimeout(r, waitMs));
			this.refill();
		}
		this.tokens -= 1;
	}
}
