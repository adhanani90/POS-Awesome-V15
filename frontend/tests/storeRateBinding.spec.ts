import { beforeEach, describe, expect, it, vi } from "vitest";

const offlineMocks = vi.hoisted(() => ({
	isOffline: vi.fn(() => false),
	getCachedExchangeRate: vi.fn(() => null),
	saveExchangeRateCache: vi.fn(),
}));
vi.mock("../src/offline/index", () => offlineMocks);
vi.mock("../src/offline/repositories", () => ({
	currencyRateRepository: {
		findLatestOnOrBefore: vi.fn().mockResolvedValue(null),
	},
}));

import {
	applyStoreRateBinding,
	getActiveStoreRate,
	refreshStoreRate,
	stampBillIssued,
} from "../src/posapp/services/storeRateBinding";
import {
	fromCompanyCurrency,
	priceListToSelectedCurrency,
	toCompanyCurrency,
} from "../src/posapp/utils/erpnextCurrency";
import {
	clearExchangeRateResolverCache,
	resolveExchangeRate,
} from "../src/posapp/services/exchangeRateResolver";

const profile = {
	name: "C7 New Depo",
	company: "Ruhee Spike",
	currency: "USD",
	ruhee_c7_store_rate: 1,
};
// Company rate 9999 on purpose: only the store record may drive CDF amounts.
const cdfBill = {
	company: { default_currency: "USD" },
	pos_profile: profile,
	selected_currency: "CDF",
	price_list_currency: "USD",
	conversion_rate: 1 / 9999,
};
const record = {
	found: true,
	name: "rate-2300",
	company: "Ruhee Spike",
	pos_profile: "C7 New Depo",
	effective_from: "2026-11-06 00:00:00",
	base: 2300,
	higher: 2320,
};

describe("Ruhee C7 store-rate binding (fork m1-c7-client-rate)", () => {
	beforeEach(async () => {
		const store = new Map<string, string>();
		(globalThis as any).localStorage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
		};
		(globalThis as any).frappe = {
			call: vi.fn().mockResolvedValue({ message: record }),
		};
		offlineMocks.isOffline.mockReturnValue(false);
		clearExchangeRateResolverCache();
		await refreshStoreRate(profile);
	});

	it("prices CDF lines as USD price x base, never through the company reciprocal", () => {
		expect(priceListToSelectedCurrency(cdfBill, 100)).toBe(230000);
		expect(priceListToSelectedCurrency(cdfBill, 3200)).toBe(7360000);
		expect(fromCompanyCurrency(cdfBill, 100)).toBe(230000);
		expect(toCompanyCurrency(cdfBill, 23200000)).toBeCloseTo(10086.9565, 4);
	});

	it("keeps upstream behaviour for a profile without the C7 flag", async () => {
		await refreshStoreRate({ ...profile, ruhee_c7_store_rate: 0 });
		expect(getActiveStoreRate()).toBeNull();
		expect(priceListToSelectedCurrency(cdfBill, 100)).toBeCloseTo(
			999900,
			6,
		);
	});

	it("resolves USD/CDF from the store record for the bound profile", async () => {
		const usdToCdf = await resolveExchangeRate({
			profileName: "C7 New Depo",
			fromCurrency: "USD",
			toCurrency: "CDF",
			effectiveDate: "2026-11-06",
		});
		expect(usdToCdf).toMatchObject({
			found: true,
			rate: 2300,
			source: "store_rate",
		});
		// Only the binding fetch reached the server, never resolve_exchange_rate.
		expect((globalThis as any).frappe.call).toHaveBeenCalledTimes(1);
	});

	it("reuses the last record received when the PC is offline", async () => {
		offlineMocks.isOffline.mockReturnValue(true);
		(globalThis as any).frappe.call.mockRejectedValue(new Error("offline"));
		await refreshStoreRate(profile);
		expect(getActiveStoreRate()).toMatchObject({
			name: "rate-2300",
			base: 2300,
			source: "cache",
		});
	});

	it("binds every payload and stamps the issue time once, with its offset", () => {
		const doc: any = { pos_profile: "C7 New Depo" };
		stampBillIssued(applyStoreRateBinding(doc));
		expect(doc).toMatchObject({
			ruhee_c7_rate: "rate-2300",
			ruhee_c7_base: 2300,
			ruhee_c7_higher: 2320,
		});
		expect(doc.ruhee_c7_issued_at).toMatch(
			/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/,
		);
		const first = doc.ruhee_c7_issued_at;
		stampBillIssued(applyStoreRateBinding(doc));
		expect(doc.ruhee_c7_issued_at).toBe(first);
	});

	it("never moves a bill to a different record", () => {
		const doc: any = {
			pos_profile: "C7 New Depo",
			ruhee_c7_rate: "rate-old",
			ruhee_c7_base: 2200,
		};
		applyStoreRateBinding(doc);
		expect(doc).toMatchObject({
			ruhee_c7_rate: "rate-old",
			ruhee_c7_base: 2200,
		});
	});
});
