/**
 * Ruhee C7 store-rate binding (experimental, fork branch m1-c7-client-rate).
 *
 * Active only for a POS Profile with `ruhee_c7_store_rate` set; every other
 * profile keeps upstream behaviour. The store record (identity plus direct
 * base/higher quotes) comes from the ruhee_erp spike method and is kept in
 * localStorage so an offline PC keeps billing with the last record it received.
 *
 * - CDF line prices: USD price x base (multiplication by the direct quote).
 * - USD bill paid in CDF: CDF due = USD x higher; CDF received is valued at base
 *   on the server (separate Payment Entry).
 * - Every invoice payload carries the record name, the quotes it was billed with
 *   and the bill-issued time with its UTC offset.
 *
 * Rounding to 50 FC (Q1), change in the other currency (Q2) and the no-rate
 * policy (Q5) are not decided here: amounts use currency precision only, and
 * with no record the client sends no binding, so the server rejects CDF bills.
 */
import { isOffline } from "../../offline/index";

declare const frappe: any;

export type StoreRateBinding = {
	name: string;
	company: string;
	pos_profile: string;
	store?: string;
	effective_from: string;
	base: number;
	higher: number;
	fetched_at: string;
	source: "server" | "cache";
};

const METHOD = "ruhee_erp.spike.store_rate_hooks.get_store_rate";
const STORAGE_PREFIX = "posa_c7_store_rate::";
const COMPANY_CURRENCY = "USD";
const BILL_CURRENCY = "CDF";

let active: StoreRateBinding | null = null;

const truthy = (value: unknown) =>
	value === true || value === 1 || value === "1";

const positive = (value: unknown): number | null => {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

export function storeRateEnabled(profile: any): boolean {
	return Boolean(profile) && truthy(profile?.ruhee_c7_store_rate);
}

function storageKey(profileName: string) {
	return `${STORAGE_PREFIX}${profileName}`;
}

function readCache(profileName: string): StoreRateBinding | null {
	try {
		const raw = localStorage.getItem(storageKey(profileName));
		const parsed = raw ? JSON.parse(raw) : null;
		if (
			parsed &&
			positive(parsed.base) &&
			positive(parsed.higher) &&
			parsed.name
		) {
			return { ...parsed, source: "cache" };
		}
	} catch (error) {
		console.warn("Unable to read the cached store rate", error);
	}
	return null;
}

function writeCache(binding: StoreRateBinding) {
	try {
		localStorage.setItem(
			storageKey(binding.pos_profile),
			JSON.stringify(binding),
		);
	} catch (error) {
		console.warn("Unable to cache the store rate", error);
	}
}

/** Fetch the record in force (online) or reuse the last one received (offline). */
export async function refreshStoreRate(
	profile: any,
): Promise<StoreRateBinding | null> {
	if (!storeRateEnabled(profile)) {
		active = null;
		return null;
	}
	const profileName = String(profile.name || "");
	if (!isOffline()) {
		try {
			const response = await frappe.call({
				method: METHOD,
				args: { pos_profile: profileName },
			});
			const message = response?.message || {};
			if (
				message.found &&
				positive(message.base) &&
				positive(message.higher)
			) {
				active = {
					name: message.name,
					company: message.company,
					pos_profile: message.pos_profile,
					store: message.store,
					effective_from: message.effective_from,
					base: Number(message.base),
					higher: Number(message.higher),
					fetched_at: new Date().toISOString(),
					source: "server",
				};
				writeCache(active);
				return active;
			}
			// The server has no record in force: no binding (Q5 is not decided).
			active = null;
			return null;
		} catch (error) {
			console.warn(
				"Store rate unavailable from the server; using the cached record",
				error,
			);
		}
	}
	active = readCache(profileName);
	return active;
}

export function getActiveStoreRate(): StoreRateBinding | null {
	return active;
}

/** Direct quote for pricing: company currency (USD) -> bill currency (CDF) = base. */
export function directQuote(
	fromCurrency?: string,
	toCurrency?: string,
): number | null {
	if (
		!active ||
		fromCurrency !== COMPANY_CURRENCY ||
		toCurrency !== BILL_CURRENCY
	) {
		return null;
	}
	return active.base;
}

/** Resolver rate for the C7 pair: USD->CDF = base, CDF->USD = 1 / base. */
export function storeResolverRate(
	profileName: string | undefined,
	fromCurrency: string,
	toCurrency: string,
): number | null {
	if (!active || (profileName && profileName !== active.pos_profile)) {
		return null;
	}
	if (fromCurrency === COMPANY_CURRENCY && toCurrency === BILL_CURRENCY) {
		return active.base;
	}
	if (fromCurrency === BILL_CURRENCY && toCurrency === COMPANY_CURRENCY) {
		return 1 / active.base;
	}
	return null;
}

/** USD bill paid in CDF: the higher quote, when a binding is active for this profile. */
export function usdBillCdfQuotes(
	profileName: string | undefined,
	invoiceCurrency: string,
	paymentCurrency: string,
): StoreRateBinding | null {
	if (
		!active ||
		invoiceCurrency !== COMPANY_CURRENCY ||
		paymentCurrency !== BILL_CURRENCY ||
		(profileName && profileName !== active.pos_profile)
	) {
		return null;
	}
	return active;
}

/** Local time with its UTC offset, e.g. 2026-11-06T14:03:22.123+01:00. */
export function localIsoWithOffset(date = new Date()): string {
	const pad = (value: number, size = 2) =>
		String(Math.abs(value)).padStart(size, "0");
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
	);
}

/** Every invoice payload of a bound profile carries the record and the quotes billed with. */
export function applyStoreRateBinding(doc: any) {
	if (!doc || !active || doc.pos_profile !== active.pos_profile) {
		return doc;
	}
	if (doc.ruhee_c7_rate && doc.ruhee_c7_rate !== active.name) {
		// A bill keeps the record it was priced with; the server rejects a changed one.
		return doc;
	}
	doc.ruhee_c7_rate = active.name;
	doc.ruhee_c7_base = active.base;
	doc.ruhee_c7_higher = active.higher;
	return doc;
}

/** Stamp the bill-issued time once; retries and replays keep the first stamp. */
export function stampBillIssued(doc: any) {
	if (doc && doc.ruhee_c7_rate && !doc.ruhee_c7_issued_at) {
		doc.ruhee_c7_issued_at = localIsoWithOffset();
	}
	return doc;
}
