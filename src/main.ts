try {
	if (window.self !== window.top) {
		throw new Error("Running in iframe");
	}
} catch {
	throw new Error("Blocked");
}

if ((window as any).__plarzaScraperInitialized) {
	throw new Error("Already initialized");
}
(window as any).__plarzaScraperInitialized = true;

const CONFIG = Object.freeze({
	SUBMIT_URL: "https://worker.aza.network/submit",
	BATCH_INTERVAL_MS: 10_000,
	SCAN_DEBOUNCE_MS: 500,
	PERSIST_DEBOUNCE_MS: 250,
	REQUEST_TIMEOUT_MS: 15_000,
	API_KEY_PROMPT_COOLDOWN_MS: 60_000,
	MASTER_LIST_MAX_SIZE: 10_000,
	STORAGE_KEYS: Object.freeze({
		pending: "plarza_pending_urls",
		master: "plarza_submitted_urls",
		apiKey: "plarza_api_key",
	}),
	URL_REGEX: /https?:\/\/[^\s<>"'`\]\)}\|\\]+/gi,
});

type StyleKind = "brand" | "success" | "error" | "warn" | "muted";

const STYLE: Record<StyleKind, string> = Object.freeze({
	brand: "color: #343a40; font-weight: bold",
	success: "color: #28a745",
	error: "color: #dc3545",
	warn: "color: #fd7e14",
	muted: "color: #6c757d",
});

function log(kind: StyleKind, message: string, ...extra: unknown[]) {
	const method = kind === "error" ? console.error : kind === "warn" ? console.warn : console.log;
	const tone = STYLE[kind] || STYLE.muted;
	method(`%c[Plarza] %c${message}`, STYLE.brand, tone, ...extra);
}

function logGroup(title: string, values: unknown) {
	try {
		console.groupCollapsed(`%c[Plarza] %c${title}`, STYLE.brand, STYLE.muted);
		console.log(values);
		console.groupEnd();
	} catch {
		log("muted", title, values);
	}
}

interface State {
	pendingUrls: Set<string>;
	masterUrls: Set<string>;
	submitInFlight: boolean;
	scanTimerId: number | null;
	scanInProgress: boolean;
	scanQueued: boolean;
	pendingPersistTimerId: number | null;
	masterPersistTimerId: number | null;
	lastApiKeyPromptAt: number;
	submitIntervalId: number | null;
	observer: MutationObserver | null;
}

const state: State = {
	pendingUrls: new Set(),
	masterUrls: new Set(),
	submitInFlight: false,
	scanTimerId: null,
	scanInProgress: false,
	scanQueued: false,
	pendingPersistTimerId: null,
	masterPersistTimerId: null,
	lastApiKeyPromptAt: 0,
	submitIntervalId: null,
	observer: null,
};

function safeGetValue(key: string, fallbackValue: unknown): unknown {
	try {
		return GM_getValue(key, fallbackValue);
	} catch (error) {
		log("error", `Storage read failed for ${key}`, error);
		return fallbackValue;
	}
}

function safeSetValue(key: string, value: unknown): boolean {
	try {
		GM_setValue(key, value);
		return true;
	} catch (error) {
		log("error", `Storage write failed for ${key}`, error);
		return false;
	}
}

function readStringSet(key: string): Set<string> {
	const raw = safeGetValue(key, "[]");
	let parsed: unknown;
	try {
		parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
	} catch (error) {
		log("warn", `Invalid JSON in ${key}; resetting`, error);
		return new Set();
	}

	if (!Array.isArray(parsed)) {
		log("warn", `Unexpected storage shape for ${key}; expected array`);
		return new Set();
	}

	const result = new Set<string>();
	for (const item of parsed) {
		if (typeof item === "string" && item) {
			result.add(item);
		}
	}
	return result;
}

function writeSet(key: string, set: Set<string>): boolean {
	return safeSetValue(key, JSON.stringify([...set]));
}

function flushPendingUrls() {
	if (state.pendingPersistTimerId !== null) {
		clearTimeout(state.pendingPersistTimerId);
		state.pendingPersistTimerId = null;
	}
	writeSet(CONFIG.STORAGE_KEYS.pending, state.pendingUrls);
}

function flushMasterUrls() {
	if (state.masterPersistTimerId !== null) {
		clearTimeout(state.masterPersistTimerId);
		state.masterPersistTimerId = null;
	}
	writeSet(CONFIG.STORAGE_KEYS.master, state.masterUrls);
}

function schedulePendingUrlsSave() {
	if (state.pendingPersistTimerId !== null) {
		clearTimeout(state.pendingPersistTimerId);
	}
	state.pendingPersistTimerId = window.setTimeout(() => {
		state.pendingPersistTimerId = null;
		writeSet(CONFIG.STORAGE_KEYS.pending, state.pendingUrls);
	}, CONFIG.PERSIST_DEBOUNCE_MS);
}

function scheduleMasterUrlsSave() {
	if (state.masterPersistTimerId !== null) {
		clearTimeout(state.masterPersistTimerId);
	}
	state.masterPersistTimerId = window.setTimeout(() => {
		state.masterPersistTimerId = null;
		writeSet(CONFIG.STORAGE_KEYS.master, state.masterUrls);
	}, CONFIG.PERSIST_DEBOUNCE_MS);
}

function normalizeApiKey(apiKey: string | null | undefined): string {
	return String(apiKey ?? "")
		.replace(/^Bearer\s+/i, "")
		.trim();
}

function setApiKey(apiKey: string | null | undefined): string | null {
	const normalized = normalizeApiKey(apiKey);
	if (!normalized) {
		return null;
	}
	safeSetValue(CONFIG.STORAGE_KEYS.apiKey, normalized);
	log("success", "API key saved successfully");
	return normalized;
}

function getStoredApiKey(): string | null {
	const raw = safeGetValue(CONFIG.STORAGE_KEYS.apiKey, null);
	if (typeof raw !== "string") {
		return null;
	}

	const normalized = normalizeApiKey(raw);
	if (!normalized) {
		return null;
	}

	if (normalized !== raw) {
		safeSetValue(CONFIG.STORAGE_KEYS.apiKey, normalized);
	}

	return normalized;
}

function promptForApiKey(options: { force?: boolean } = {}): string | null {
	const { force = false } = options;
	const now = Date.now();
	if (!force && now - state.lastApiKeyPromptAt < CONFIG.API_KEY_PROMPT_COOLDOWN_MS) {
		return null;
	}
	state.lastApiKeyPromptAt = now;

	let apiKeyInput: string | null = null;
	try {
		apiKeyInput = prompt("[Plarza] Please enter your API key:");
	} catch (error) {
		log("error", "API key prompt failed", error);
		return null;
	}

	if (!apiKeyInput || !apiKeyInput.trim()) {
		log("warn", "No API key provided; submissions will be retried later");
		return null;
	}

	return setApiKey(apiKeyInput);
}

function getApiKey(): string | null {
	return getStoredApiKey() || promptForApiKey();
}

function resetApiKey(): string | null {
	safeSetValue(CONFIG.STORAGE_KEYS.apiKey, null);
	log("muted", "API key has been reset");
	return promptForApiKey({ force: true });
}

function isHttpUrlString(value: unknown): value is string {
	return typeof value === "string" && /^(https?:)\/\//i.test(value.trim());
}

function isValidUrl(url: string): boolean {
	const candidate = url.trim();
	if (!candidate) {
		return false;
	}
	if (candidate.includes("...") || candidate.includes("\u2026")) {
		return false;
	}
	if (candidate.endsWith(".")) {
		return false;
	}

	try {
		const parsed = new URL(candidate);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function addUrl(url: string): boolean {
	const candidate = url.trim();
	if (!candidate || !isValidUrl(candidate)) {
		return false;
	}
	if (state.pendingUrls.has(candidate) || state.masterUrls.has(candidate)) {
		return false;
	}

	state.pendingUrls.add(candidate);
	schedulePendingUrlsSave();
	return true;
}

function addUrlsFromText(text: string | null | undefined): number {
	if (typeof text !== "string" || !text) {
		return 0;
	}

	const matches = text.match(CONFIG.URL_REGEX);
	if (!matches) {
		return 0;
	}

	let added = 0;
	for (const url of matches) {
		if (addUrl(url)) {
			added += 1;
		}
	}
	return added;
}

function addDirectHttpUrl(url: unknown): number {
	if (!isHttpUrlString(url)) {
		return 0;
	}
	return addUrl(url) ? 1 : 0;
}

function scanSrcset(srcsetValue: string | null | undefined): number {
	if (typeof srcsetValue !== "string" || !srcsetValue) {
		return 0;
	}

	let added = 0;
	for (const entry of srcsetValue.split(",")) {
		const candidate = entry.trim().split(/\s+/)[0];
		added += addDirectHttpUrl(candidate);
	}
	return added;
}

function safeQueryAll(selector: string): NodeListOf<Element> | Element[] {
	try {
		return document.querySelectorAll(selector);
	} catch (error) {
		log("error", `Selector failed: ${selector}`, error);
		return [];
	}
}

function scanPropertyUrls(selector: string, propertyName: string): number {
	let added = 0;
	for (const element of safeQueryAll(selector)) {
		try {
			added += addDirectHttpUrl((element as any)[propertyName]);
		} catch (error) {
			log("warn", `Failed reading ${propertyName} on ${selector}`, error);
		}
	}
	return added;
}

function scanAttributeText(selector: string, attributeName: string): number {
	let added = 0;
	for (const element of safeQueryAll(selector)) {
		try {
			added += addUrlsFromText(element.getAttribute(attributeName));
		} catch (error) {
			log("warn", `Failed reading ${attributeName} on ${selector}`, error);
		}
	}
	return added;
}

function scanScripts(): number {
	let added = 0;
	for (const script of safeQueryAll("script")) {
		try {
			added += addUrlsFromText(script.textContent);
		} catch (error) {
			log("warn", "Failed scanning script content", error);
		}
	}
	return added;
}

function scanDataAttributes(): number {
	let added = 0;
	for (const element of safeQueryAll("*")) {
		try {
			if (!element.attributes || element.attributes.length === 0) {
				continue;
			}
			for (const attr of element.attributes) {
				if (attr && attr.name && attr.name.startsWith("data-")) {
					added += addUrlsFromText(attr.value);
				}
			}
		} catch (error) {
			log("warn", "Failed scanning data attributes", error);
		}
	}
	return added;
}

function scanBodyText(): number {
	try {
		return addUrlsFromText(document.body ? document.body.innerText : "");
	} catch (error) {
		log("warn", "Failed scanning page text", error);
		return 0;
	}
}

function runFullScan(reason = "manual") {
	if (state.scanInProgress) {
		state.scanQueued = true;
		return;
	}

	state.scanInProgress = true;
	const beforePending = state.pendingUrls.size;

	try {
		scanPropertyUrls("a[href]", "href");
		scanPropertyUrls("[src]", "src");

		for (const element of safeQueryAll("[srcset]")) {
			try {
				scanSrcset(element.getAttribute("srcset"));
			} catch (error) {
				log("warn", "Failed scanning srcset", error);
			}
		}

		scanDataAttributes();
		scanAttributeText("[style]", "style");
		scanPropertyUrls("link[href]", "href");
		scanAttributeText("meta[content]", "content");
		scanBodyText();
		scanScripts();
	} catch (error) {
		log("error", `Unexpected scan failure (${reason})`, error);
	} finally {
		state.scanInProgress = false;

		const added = state.pendingUrls.size - beforePending;
		if (added > 0) {
			log("muted", `Scan (${reason}) added ${added} URL${added === 1 ? "" : "s"}; pending: ${state.pendingUrls.size}`);
		}

		if (state.scanQueued) {
			state.scanQueued = false;
			scheduleScan("queued", CONFIG.SCAN_DEBOUNCE_MS);
		}
	}
}

function scheduleScan(reason = "mutation", delayMs: number = CONFIG.SCAN_DEBOUNCE_MS) {
	if (state.scanTimerId !== null) {
		clearTimeout(state.scanTimerId);
	}

	state.scanTimerId = window.setTimeout(() => {
		state.scanTimerId = null;
		runFullScan(reason);
	}, Math.max(0, delayMs));
}

function enforceMasterListLimit() {
	if (state.masterUrls.size <= CONFIG.MASTER_LIST_MAX_SIZE) {
		return;
	}

	let removed = 0;
	while (state.masterUrls.size > CONFIG.MASTER_LIST_MAX_SIZE) {
		const oldest = state.masterUrls.values().next().value;
		if (typeof oldest !== "string") {
			break;
		}
		state.masterUrls.delete(oldest);
		removed += 1;
	}

	if (removed > 0) {
		log("muted", `Trimmed ${removed} old URL${removed === 1 ? "" : "s"} from master list`);
	}
}

function addToMasterList(urls: string[]) {
	let changed = false;
	for (const url of urls) {
		if (typeof url !== "string" || !url) {
			continue;
		}
		if (!state.masterUrls.has(url)) {
			state.masterUrls.add(url);
			changed = true;
		}
	}

	if (!changed) {
		return;
	}

	enforceMasterListLimit();
	scheduleMasterUrlsSave();
}

function removeFromPendingList(urls: string[]): number {
	let removed = 0;
	for (const url of urls) {
		if (state.pendingUrls.delete(url)) {
			removed += 1;
		}
	}
	if (removed > 0) {
		schedulePendingUrlsSave();
	}
	return removed;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

interface SubmitResult {
	parsed: any;
	message: string;
	total: number;
	success: number | null;
	duplicate: number;
	blocked: number;
	invalid: number;
	accounted: number | null;
	fullyAccounted: boolean;
}

function parseSubmitResult(responseText: string, fallbackTotal: number): SubmitResult | null {
	const parsed = parseJson(responseText);
	if (!parsed || typeof parsed !== "object") {
		return null;
	}

	const details = (parsed as any).details && typeof (parsed as any).details === "object" ? (parsed as any).details : parsed;
	if (!details || typeof details !== "object") {
		return null;
	}

	const total = typeof details.total === "number" ? details.total : fallbackTotal;
	const success = typeof details.success === "number" ? details.success : null;
	const duplicate = typeof details.duplicate === "number" ? details.duplicate : 0;
	const blocked = typeof details.blocked === "number" ? details.blocked : 0;
	const invalid = typeof details.invalid === "number" ? details.invalid : 0;
	const accounted = typeof success === "number" ? success + duplicate + blocked + invalid : null;
	const message = typeof (parsed as any).message === "string" ? (parsed as any).message : "Submit response received";

	return {
		parsed,
		message,
		total,
		success,
		duplicate,
		blocked,
		invalid,
		accounted,
		fullyAccounted: typeof success === "number" && accounted === total,
	};
}

function extractResponseErrorBody(response: Tampermonkey.Response<any>): string {
	const parsed = parseJson(response.responseText);
	if (parsed && typeof parsed === "object") {
		if (typeof (parsed as any).error === "string") {
			return (parsed as any).error;
		}
		if (typeof (parsed as any).message === "string") {
			return (parsed as any).message;
		}
		return JSON.stringify(parsed);
	}
	return response.responseText || "";
}

function finishSubmit() {
	state.submitInFlight = false;
}

function submitUrls() {
	if (state.submitInFlight) {
		return;
	}
	if (state.pendingUrls.size === 0) {
		return;
	}

	const apiKey = getApiKey();
	if (!apiKey) {
		log("warn", "Skipping submission; no API key configured");
		return;
	}

	const urlsToSubmit = [...state.pendingUrls];
	if (urlsToSubmit.length === 0) {
		return;
	}

	state.submitInFlight = true;
	logGroup(`Submitting ${urlsToSubmit.length} URLs...`, urlsToSubmit);

	try {
		GM_xmlhttpRequest({
			method: "POST",
			url: CONFIG.SUBMIT_URL,
			timeout: CONFIG.REQUEST_TIMEOUT_MS,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			data: JSON.stringify(urlsToSubmit),
			onload: (response) => {
				try {
					const is2xx = response.status >= 200 && response.status < 300;
					const parsedResult = parseSubmitResult(response.responseText, urlsToSubmit.length);

					if (!is2xx) {
						const errorBody = extractResponseErrorBody(response);
						log(
							"error",
							`Server error: ${response.status} ${response.statusText}${errorBody ? ` | ${errorBody}` : ""}`,
						);
						if (response.status === 401) {
							log("warn", "Authorization failed. Run window.plarzaResetApiKey() to update the userscript API key.");
						}
						return;
					}

					if (!parsedResult || !parsedResult.fullyAccounted) {
						log(
							"error",
							`Server returned ${response.status} but did not fully account for the batch; keeping ${urlsToSubmit.length} URLs queued for retry`,
						);
						if (parsedResult) {
							log("muted", "Response summary", {
								total: parsedResult.total,
								success: parsedResult.success,
								duplicate: parsedResult.duplicate,
								blocked: parsedResult.blocked,
								invalid: parsedResult.invalid,
								accounted: parsedResult.accounted,
								body: parsedResult.parsed,
							});
						} else if (response.responseText) {
							log("muted", "Unparseable response body", response.responseText);
						}
						return;
					}

					addToMasterList(urlsToSubmit);
					const removed = removeFromPendingList(urlsToSubmit);
					log(
						"success",
						`${parsedResult.message} | success: ${parsedResult.success} | duplicate: ${parsedResult.duplicate} | invalid: ${parsedResult.invalid} | blocked: ${parsedResult.blocked} | removed: ${removed}`,
					);
				} catch (error) {
					log("error", "Unexpected error while handling submit response", error);
				} finally {
					finishSubmit();
				}
			},
			onerror: (error) => {
				log("error", "Request failed (network error)", error);
				finishSubmit();
			},
			ontimeout: () => {
				log("error", `Request timed out after ${CONFIG.REQUEST_TIMEOUT_MS}ms`);
				finishSubmit();
			},
			onabort: () => {
				log("error", "Request aborted");
				finishSubmit();
			},
		});
	} catch (error) {
		finishSubmit();
		log("error", "Failed to start request", error);
	}
}

function observePageChanges() {
	if (state.observer || !document.documentElement) {
		return;
	}

	state.observer = new MutationObserver((mutations) => {
		try {
			for (const mutation of mutations) {
				if (mutation.type === "childList") {
					if (mutation.addedNodes && mutation.addedNodes.length > 0) {
						scheduleScan("mutation:childList", CONFIG.SCAN_DEBOUNCE_MS);
						return;
					}
				}
				if (mutation.type === "attributes") {
					scheduleScan(`mutation:${mutation.attributeName || "attribute"}`, CONFIG.SCAN_DEBOUNCE_MS);
					return;
				}
			}
		} catch (error) {
			log("error", "Mutation observer callback failed", error);
		}
	});

	try {
		state.observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["href", "src", "srcset", "style", "content", "data-src", "data-href"],
		});
	} catch (error) {
		state.observer = null;
		log("error", "Failed to start mutation observer", error);
	}
}

function flushAllStorageWrites() {
	flushPendingUrls();
	flushMasterUrls();
}

function getStatus() {
	return {
		pendingCount: state.pendingUrls.size,
		masterCount: state.masterUrls.size,
		submitInFlight: state.submitInFlight,
		submitUrl: CONFIG.SUBMIT_URL,
		hasApiKey: Boolean(getStoredApiKey()),
	};
}

function initState() {
	state.pendingUrls = readStringSet(CONFIG.STORAGE_KEYS.pending);
	state.masterUrls = readStringSet(CONFIG.STORAGE_KEYS.master);
	enforceMasterListLimit();
	if (state.masterUrls.size > 0) {
		scheduleMasterUrlsSave();
	}
}

function init() {
	initState();

	(window as any).plarzaResetApiKey = resetApiKey;
	(window as any).plarzaSetApiKey = setApiKey;
	(window as any).plarzaScanNow = () => runFullScan("manual");
	(window as any).plarzaSubmitNow = submitUrls;
	(window as any).plarzaStatus = getStatus;

	if (document.readyState === "loading") {
		document.addEventListener(
			"DOMContentLoaded",
			() => {
				observePageChanges();
				scheduleScan("domcontentloaded", 0);
			},
			{ once: true },
		);
	} else {
		observePageChanges();
		scheduleScan("init", 0);
	}

	window.addEventListener(
		"load",
		() => {
			scheduleScan("load", 0);
		},
		{ once: true },
	);

	window.addEventListener("beforeunload", flushAllStorageWrites);

	state.submitIntervalId = window.setInterval(submitUrls, CONFIG.BATCH_INTERVAL_MS);

	log("success", "Initialized");
}

init();
