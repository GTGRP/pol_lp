// Strategy layer public surface.
export {
	buildQuotes,
	reconcileQuotes,
	DEFAULT_QUOTE_PARAMS,
	type QuoteParams,
	type DesiredOrder,
	type Reconciliation,
} from "./quoter.js";
export {
	buildInventoryExit,
	netExposureUsd,
	DEFAULT_INVENTORY_PARAMS,
	type InventoryParams,
} from "./inventoryManager.js";
export {
	canQuote,
	shouldStopLoss,
	DriftDetector,
	AdverseSelectionMonitor,
	DEFAULT_RISK_PARAMS,
	type RiskParams,
} from "./riskGuard.js";
export {
	buildStackedArb,
	DEFAULT_STACKED_ARB_PARAMS,
	type ArbBook,
	type StackedArbParams,
	type StackedArbQuote,
} from "./stackedArb.js";
