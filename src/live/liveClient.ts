// Live execution client: derives credentials, signs + posts GTC orders, cancels,
// all behind a rate limiter. Order amounts are capped by config for safety.
//
// !! The /order and /cancel payload shapes are isolated here; verify against the
// live API and test with a $1 order before scaling. !!
import { Wallet } from "ethers";
import type { AppConfig } from "../core/config.js";
import { buildL2Headers, type L2Credentials } from "../core/clob.js";
import { deriveOrCreateApiKey } from "./auth.js";
import { buildAndSignOrder, type OrderSide } from "./orderSigning.js";
import { RateLimiter } from "./rateLimiter.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("live");

export interface LivePlaceArgs {
	tokenId: string;
	side: OrderSide;
	price: number;
	size: number;
	negRisk?: boolean;
}

export class LiveClient {
	private readonly cfg: AppConfig;
	private readonly wallet: Wallet;
	private creds: L2Credentials | null = null;
	private readonly limiter = new RateLimiter();

	constructor(cfg: AppConfig) {
		if (!cfg.privateKey) throw new Error("PRIVATE_KEY required for live mode");
		this.cfg = cfg;
		this.wallet = new Wallet(cfg.privateKey);
	}

	get address(): string {
		return this.wallet.address;
	}

	async init(): Promise<void> {
		this.creds =
			this.cfg.clobApiKey && this.cfg.clobApiSecret && this.cfg.clobApiPassphrase
				? { apiKey: this.cfg.clobApiKey, apiSecret: this.cfg.clobApiSecret, passphrase: this.cfg.clobApiPassphrase }
				: await deriveOrCreateApiKey(this.cfg);
		log.info(`live client ready (signer=${this.wallet.address}, sigType=${this.cfg.signatureType})`);
	}

	private creds_(): L2Credentials {
		if (!this.creds) throw new Error("LiveClient.init() not called");
		return this.creds;
	}

	private async authedPost(requestPath: string, body: unknown): Promise<any> {
		await this.limiter.acquire();
		const headers = {
			...buildL2Headers(this.creds_(), this.wallet.address, "POST", requestPath, body),
			"Content-Type": "application/json",
		};
		const res = await fetch(`${this.cfg.clobHttpUrl}${requestPath}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		if (res.status === 429) {
			log.warn("rate limited (429); backing off 1s");
			await new Promise((r) => setTimeout(r, 1000));
			return this.authedPost(requestPath, body);
		}
		if (!res.ok) throw new Error(`POST ${requestPath} failed: ${res.status} ${res.statusText}`);
		return res.json();
	}

	async placeOrder(args: LivePlaceArgs): Promise<{ id: string }> {
		const notional = args.price * args.size;
		if (notional > this.cfg.liveMaxOrderUsd) {
			throw new Error(`order notional $${notional.toFixed(2)} exceeds LIVE_MAX_ORDER_USD ($${this.cfg.liveMaxOrderUsd})`);
		}
		const funder = this.cfg.funderAddress || this.wallet.address;
		const signed = await buildAndSignOrder(this.wallet, {
			tokenId: args.tokenId,
			side: args.side,
			price: args.price,
			size: args.size,
			signatureType: this.cfg.signatureType,
			signerEoa: this.wallet.address,
			funder,
			chainId: this.cfg.chainId,
			negRisk: args.negRisk,
		});
		const payload = { order: signed, owner: this.creds_().apiKey, orderType: "GTC" };
		const resp = await this.authedPost("/order", payload);
		const id = String(resp?.orderID ?? resp?.orderId ?? resp?.id ?? "");
		log.info(`placed ${args.side} ${args.size}@${args.price} -> ${id || "(no id returned)"}`);
		return { id };
	}

	async cancelOrder(orderId: string): Promise<void> {
		await this.authedPost("/order/cancel", { orderID: orderId });
		log.info(`cancelled ${orderId}`);
	}

	async cancelAll(): Promise<void> {
		await this.authedPost("/cancel-all", {});
		log.info("cancelled all open orders");
	}
}
