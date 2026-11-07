import { directQuote } from "../services/storeRateBinding";

type CurrencyLikeContext = {
	company?: { default_currency?: string } | null;
	pos_profile?: { currency?: string; company?: string } | null;
	currency?: string | null;
	selected_currency?: string | null;
	price_list_currency?: string | null;
	exchange_rate?: number | string | null;
	conversion_rate?: number | string | null;
	plc_conversion_rate?: number | string | null;
};

const asNumber = (value: unknown, fallback = 1): number => {
	const numeric = Number.parseFloat(String(value ?? ""));
	return Number.isFinite(numeric) && numeric !== 0 ? numeric : fallback;
};

export const getCompanyCurrency = (
	context: CurrencyLikeContext,
): string | undefined =>
	context?.company?.default_currency || context?.pos_profile?.currency;

export const getSelectedCurrency = (
	context: CurrencyLikeContext,
): string | undefined =>
	context?.selected_currency || context?.currency || context?.pos_profile?.currency;

export const getPriceListCurrency = (
	context: CurrencyLikeContext,
): string | undefined =>
	context?.price_list_currency || getCompanyCurrency(context);

export const getConversionRate = (context: CurrencyLikeContext): number => {
	const selectedCurrency = getSelectedCurrency(context);
	const companyCurrency = getCompanyCurrency(context);
	if (selectedCurrency && companyCurrency && selectedCurrency === companyCurrency) {
		return 1;
	}
	return asNumber(context?.conversion_rate, 1);
};

export const getPlcConversionRate = (context: CurrencyLikeContext): number => {
	const explicit = Number.parseFloat(String(context?.plc_conversion_rate ?? ""));
	if (Number.isFinite(explicit) && explicit > 0) {
		return explicit;
	}

	const priceListCurrency = getPriceListCurrency(context);
	const selectedCurrency = getSelectedCurrency(context);
	const companyCurrency = getCompanyCurrency(context);

	if (priceListCurrency && companyCurrency && priceListCurrency === companyCurrency) {
		return 1;
	}

	const displayRate = asNumber(context?.exchange_rate, 1);
	const conversionRate = getConversionRate(context);

	if (priceListCurrency && selectedCurrency && priceListCurrency === selectedCurrency) {
		return conversionRate;
	}

	return displayRate * conversionRate;
};

// Ruhee C7 (fork m1-c7-client-rate): with a store binding, convert by the direct
// quote (USD -> CDF = base) instead of dividing or multiplying by a reciprocal.
const boundQuote = (context: CurrencyLikeContext): number | null => {
	const companyCurrency = getCompanyCurrency(context);
	const selectedCurrency = getSelectedCurrency(context);
	if (!companyCurrency || !selectedCurrency || companyCurrency === selectedCurrency) {
		return null;
	}
	return directQuote(companyCurrency, selectedCurrency);
};

export const toCompanyCurrency = (
	context: CurrencyLikeContext,
	amount: unknown,
): number => {
	const numeric = Number.parseFloat(String(amount ?? 0)) || 0;
	const quote = boundQuote(context);
	if (quote) return numeric / quote;
	return numeric * getConversionRate(context);
};

export const fromCompanyCurrency = (
	context: CurrencyLikeContext,
	amount: unknown,
): number => {
	const numeric = Number.parseFloat(String(amount ?? 0)) || 0;
	const quote = boundQuote(context);
	if (quote) return numeric * quote;
	const rate = getConversionRate(context);
	return rate ? numeric / rate : numeric;
};

export const priceListToSelectedCurrency = (
	context: CurrencyLikeContext,
	priceListAmount: unknown,
): number => {
	const numeric = Number.parseFloat(String(priceListAmount ?? 0)) || 0;
	const quote = boundQuote(context);
	if (quote && getPriceListCurrency(context) === getCompanyCurrency(context)) {
		return numeric * quote;
	}
	return numeric * getPlcConversionRate(context) / getConversionRate(context);
};
