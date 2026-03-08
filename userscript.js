// ==UserScript==
// @name         Plarza Extension
// @namespace    https://plarza.com
// @version      1.1.0
// @description  Scans web pages for URLs and uploads them to Plarza
// @author       Plarza
// @icon         https://plarza.com/favicon.svg
// @match        *://*/*
// @exclude      *://*.plarza.com/*
// @exclude      *://plarza.com/*
// @exclude      *://localhost/*
// @exclude      *://localhost:*/*
// @exclude      *://127.0.0.1/*
// @exclude      *://127.0.0.1:*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

(() => {
	"use strict";

	try {
		if (window.self !== window.top) {
			return;
		}
	} catch {
		return;
	}

	if (window.__plarzaScraperInitialized) {
		return;
	}
	window.__plarzaScraperInitialized = true;

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

	const STYLE = Object.freeze({
		brand: "color: #343a40; font-weight: bold",
		success: "color: #28a745",
		error: "color: #dc3545",
		warn: "color: #fd7e14",
		muted: "color: #6c757d",
	});

	function log(kind, message, ...extra) {
		const method = kind === "error" ? console.error : kind === "warn" ? console.warn : console.log;
		const tone = STYLE[kind] || STYLE.muted;
		method(`%c[Plarza] %c${message}`, STYLE.brand, tone, ...extra);
	}

	function logGroup(title, values) {
		try {
			console.groupCollapsed(`%c[Plarza] %c${title}`, STYLE.brand, STYLE.muted);
			console.log(values);
			console.groupEnd();
		} catch {
			log("muted", title, values);
		}
	}

	const state = {
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

	function safeGetValue(key, fallbackValue) {
		try {
			return GM_getValue(key, fallbackValue);
		} catch (error) {
			log("error", `Storage read failed for ${key}`, error);
			return fallbackValue;
		}
	}

	function safeSetValue(key, value) {
		try {
			GM_setValue(key, value);
			return true;
		} catch (error) {
			log("error", `Storage write failed for ${key}`, error);
			return false;
		}
	}

	function readStringSet(key) {
		const raw = safeGetValue(key, "[]");
		let parsed;
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

		const result = new Set();
		for (const item of parsed) {
			if (typeof item === "string" && item) {
				result.add(item);
			}
		}
		return result;
	}

	function writeSet(key, set) {
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

	function normalizeApiKey(apiKey) {
		return String(apiKey ?? "")
			.replace(/^Bearer\s+/i, "")
			.trim();
	}

	function setApiKey(apiKey) {
		const normalized = normalizeApiKey(apiKey);
		if (!normalized) {
			return null;
		}
		safeSetValue(CONFIG.STORAGE_KEYS.apiKey, normalized);
		log("success", "API key saved successfully");
		return normalized;
	}

	function getStoredApiKey() {
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

	function promptForApiKey(options = {}) {
		const { force = false } = options;
		const now = Date.now();
		if (!force && now - state.lastApiKeyPromptAt < CONFIG.API_KEY_PROMPT_COOLDOWN_MS) {
			return null;
		}
		state.lastApiKeyPromptAt = now;

		let apiKeyInput = null;
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

	function getApiKey() {
		return getStoredApiKey() || promptForApiKey();
	}

	function resetApiKey() {
		safeSetValue(CONFIG.STORAGE_KEYS.apiKey, null);
		log("muted", "API key has been reset");
		return promptForApiKey({ force: true });
	}

	function isHttpUrlString(value) {
		return typeof value === "string" && /^(https?:)\/\//i.test(value.trim());
	}

	function isValidUrl(url) {
		if (typeof url !== "string") {
			return false;
		}

		const candidate = url.trim();
		if (!candidate) {
			return false;
		}
		if (candidate.includes("...") || candidate.includes("…")) {
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

	function addUrl(url) {
		const candidate = typeof url === "string" ? url.trim() : "";
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

	function addUrlsFromText(text) {
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

	function addDirectHttpUrl(url) {
		if (!isHttpUrlString(url)) {
			return 0;
		}
		return addUrl(url) ? 1 : 0;
	}

	function scanSrcset(srcsetValue) {
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

	function safeQueryAll(selector) {
		try {
			return document.querySelectorAll(selector);
		} catch (error) {
			log("error", `Selector failed: ${selector}`, error);
			return [];
		}
	}

	function scanPropertyUrls(selector, propertyName) {
		let added = 0;
		for (const element of safeQueryAll(selector)) {
			try {
				added += addDirectHttpUrl(element[propertyName]);
			} catch (error) {
				log("warn", `Failed reading ${propertyName} on ${selector}`, error);
			}
		}
		return added;
	}

	function scanAttributeText(selector, attributeName) {
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

	function scanScripts() {
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

	function scanDataAttributes() {
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

	function scanBodyText() {
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

	function scheduleScan(reason = "mutation", delayMs = CONFIG.SCAN_DEBOUNCE_MS) {
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

	function addToMasterList(urls) {
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

	function removeFromPendingList(urls) {
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

	function parseJson(text) {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	function parseSubmitResult(responseText, fallbackTotal) {
		const parsed = parseJson(responseText);
		if (!parsed || typeof parsed !== "object") {
			return null;
		}

		const details = parsed && typeof parsed.details === "object" ? parsed.details : parsed;
		if (!details || typeof details !== "object") {
			return null;
		}

		const total = typeof details.total === "number" ? details.total : fallbackTotal;
		const success = typeof details.success === "number" ? details.success : null;
		const duplicate = typeof details.duplicate === "number" ? details.duplicate : 0;
		const blocked = typeof details.blocked === "number" ? details.blocked : 0;
		const invalid = typeof details.invalid === "number" ? details.invalid : 0;
		const accounted = typeof success === "number" ? success + duplicate + blocked + invalid : null;
		const message = typeof parsed.message === "string" ? parsed.message : "Submit response received";

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

	function extractResponseErrorBody(response) {
		const parsed = parseJson(response.responseText);
		if (parsed && typeof parsed === "object") {
			if (typeof parsed.error === "string") {
				return parsed.error;
			}
			if (typeof parsed.message === "string") {
				return parsed.message;
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

		window.plarzaResetApiKey = resetApiKey;
		window.plarzaSetApiKey = setApiKey;
		window.plarzaScanNow = () => runFullScan("manual");
		window.plarzaSubmitNow = submitUrls;
		window.plarzaStatus = getStatus;

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
})();
