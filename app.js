/* Local Invoice — 100% in-browser invoice maker. No network at runtime.
 * pdf-lib (window.PDFLib) builds the exported PDF. All data lives in
 * localStorage on this device only.
 *
 * SECURITY: client names, notes, and every other user-entered string are
 * attacker-controlled, so they are ALWAYS written via textContent — never
 * interpolated into innerHTML. A strict CSP (see index.html) enforces the
 * no-upload promise at the browser level. */
"use strict";

// pdf-lib (~200KB) is lazy-loaded on the first PDF export — most visitors never
// export, so it stays out of the initial page load. The service worker caches it
// after first use (offline export works once you've exported online once). These
// are populated by ensurePdfLib() before any export runs.
let PDFDocument, rgb, StandardFonts;
let _pdfLibPromise = null;
function ensurePdfLib() {
  if (window.PDFLib) {
    if (!PDFDocument) ({ PDFDocument, rgb, StandardFonts } = window.PDFLib);
    return Promise.resolve();
  }
  if (!_pdfLibPromise) {
    _pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "lib/pdf-lib.min.js"; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { _pdfLibPromise = null; reject(new Error("pdf-lib failed to load")); };
      document.head.appendChild(s);
    });
  }
  return _pdfLibPromise.then(() => { ({ PDFDocument, rgb, StandardFonts } = window.PDFLib); });
}
const STORAGE_KEY = "localinvoice.v1";
const CODE_ACK_KEY = "localinvoice.code_ack"; // "1" once the user confirms they saved their license card
const CELEBRATED_KEY = "localinvoice.celebrated"; // "1" once the one-time ownership moment has fired (never again)
const WAS_PRO_KEY = "localinvoice.was_pro"; // "1" while this browser is a VERIFIED Pro owner — the seed for graceful, non-destructive access-stop detection on a later refund/expiry
const SUPPORT_EMAIL = "support@localinvoiceapp.com";
const VAULT_APP_ID = "localinvoice"; // identifies this app's backups in the data-vault JSON

// True only inside the Capacitor iOS/Android shell. On iOS, Pro is bought via Apple
// In-App Purchase (Guideline 3.1.1) — so the paywall/success/restore UI must NOT
// reference Stripe checkout, email receipts, "your statement", or the web-only
// restore-CODE mechanism (Apple syncs entitlements across a person's own devices via
// their Apple ID + "Restore Purchases"). Every use is `if (IS_NATIVE) {…} else {…exact
// existing web copy…}` so the live web build is byte-for-byte unchanged.
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// ── DOM helpers (textContent-only for anything not a developer constant) ──
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const txt = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

// ── Safe number / currency / date helpers ──────────────────────────────
// No real invoice needs a value near a JS number's exponential-notation
// threshold (~1e21) — capping here keeps totals sane and PDF columns from
// ever colliding, and is far beyond any legitimate invoice amount.
const MAX_INVOICE_VALUE = 99999999.99;
const safeNumber = (v) => {
  // Already a number (e.g. a computed total) — trust it directly. Re-stringifying
  // a number that large produces exponential notation ("1e+21"), which the
  // string-cleaning branch below would corrupt by stripping the "e"/"+".
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_INVOICE_VALUE);
};

// ── Multi-currency ────────────────────────────────────────────────────────
// A small, sensible set of currencies. `locale` drives Intl grouping/decimal
// conventions; `symbol` is a plain fallback for environments/edge cases where
// Intl currency formatting is unavailable. USD/en-US is the default so existing
// invoices (which had no currency field) format EXACTLY as they did before.
const CURRENCIES = [
  { code: "USD", symbol: "$",  locale: "en-US" },
  { code: "EUR", symbol: "€",  locale: "de-DE" },
  { code: "GBP", symbol: "£",  locale: "en-GB" },
  { code: "CAD", symbol: "$",  locale: "en-CA" },
  { code: "AUD", symbol: "$",  locale: "en-AU" },
  { code: "JPY", symbol: "¥",  locale: "ja-JP" },
  { code: "INR", symbol: "₹",  locale: "en-IN" },
];
const DEFAULT_CURRENCY = { ...CURRENCIES[0] };
const currencyByCode = (code) => CURRENCIES.find((c) => c.code === code) || null;
// Coerce any stored/loaded currency value into a known-good shape. Falls back to
// USD so a corrupt or foreign field can never reach Intl.NumberFormat and throw.
function sanitizeCurrency(raw) {
  if (raw && typeof raw === "object" && typeof raw.code === "string") {
    const known = currencyByCode(raw.code);
    if (known) return { ...known };
    // Unknown-but-plausible code hand-edited into the JSON: keep its code but
    // carry sane symbol/locale so formatting still works.
    return { code: raw.code, symbol: typeof raw.symbol === "string" ? raw.symbol : "", locale: typeof raw.locale === "string" ? raw.locale : "en-US" };
  }
  return { ...DEFAULT_CURRENCY };
}
// JPY has no minor unit; everything else in our set uses 2. Intl already knows
// this, but we mirror it for the plain-symbol fallback path.
const currencyFractionDigits = (code) => (code === "JPY" ? 0 : 2);
const money = (n, currency) => {
  const cur = sanitizeCurrency(currency);
  const val = safeNumber(n);
  try {
    return new Intl.NumberFormat(cur.locale, { style: "currency", currency: cur.code }).format(val);
  } catch {
    // Intl unavailable or an exotic code slipped through — plain symbol fallback.
    const digits = currencyFractionDigits(cur.code);
    return (cur.symbol || "") + val.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
};
// pdf-lib's standard Helvetica is WinAnsi-only: it renders $, £, ¥ (all within
// \xA0-\xFF) but NOT € (U+20AC) or ₹ (U+20B9), and drawText THROWS on an
// unsupported glyph. So for the PDF we format the number with grouping/decimals
// via Intl, then prefix a WinAnsi-safe symbol — using the currency CODE (e.g.
// "EUR 1,234.00") whenever the symbol isn't representable. pdfSafe() is still
// applied by callers as a final guard.
const WINANSI_SAFE_SYMBOL = /^[\x20-\x7E\xA0-\xFF]+$/;
const moneyPdf = (n, currency) => {
  const cur = sanitizeCurrency(currency);
  const val = safeNumber(n);
  const digits = currencyFractionDigits(cur.code);
  let num;
  try {
    num = new Intl.NumberFormat(cur.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(val);
  } catch {
    num = val.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  const sym = cur.symbol && WINANSI_SAFE_SYMBOL.test(cur.symbol) ? cur.symbol : (cur.code + " ");
  return sym + num;
};

// ── Tax-label heuristic (a local guess the user can always edit) ───────────
// No network, no geo-IP — purely reads navigator.language. VAT for most of
// Europe, GST for AU/IN/NZ/CA, else "Sales tax".
const VAT_REGIONS = new Set(["GB","IE","FR","DE","ES","IT","NL","BE","AT","PT","SE","DK","FI","NO","PL","CZ","GR","HU","RO","SK","SI","HR","BG","EE","LV","LT","LU","MT","CY"]);
const GST_REGIONS = new Set(["AU","IN","NZ","CA","SG","MY"]);
function guessTaxLabel() {
  try {
    const lang = (navigator.language || "en-US");
    const parts = lang.split("-");
    const region = (parts[1] || "").toUpperCase();
    if (GST_REGIONS.has(region)) return "GST";
    if (VAT_REGIONS.has(region)) return "VAT";
    // Some European locales carry no region tag (e.g. "de", "fr") — treat the
    // bare language as a VAT hint.
    const baseLang = (parts[0] || "").toLowerCase();
    if (["de","fr","es","it","nl","sv","da","fi","pl","cs","el","hu","pt"].includes(baseLang)) return "VAT";
    return "Sales tax";
  } catch { return "Sales tax"; }
}
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
// ── Recurring-invoice date math (all local, no timezone traps) ─────────────
// Parse "YYYY-MM-DD" into y/m/d ints; returns null on anything malformed so
// callers can bail safely (a corrupt anchor never generates a bogus schedule).
function parseISO(iso) {
  if (typeof iso !== "string") return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}
// Add N intervals ("weekly" = 7 days, "monthly" = N calendar months) to an ISO
// date, returning a new ISO date. Month math clamps the day to the target
// month's length (e.g. Jan 31 + 1 month → Feb 28/29) so it never rolls over.
function addInterval(iso, interval, n) {
  const p = parseISO(iso);
  if (!p) return "";
  if (interval === "weekly") {
    const dt = new Date(p.y, p.m - 1, p.d + 7 * n);
    return dt.toISOString().slice(0, 10);
  }
  // monthly
  const totalMonths = (p.m - 1) + n;
  const ty = p.y + Math.floor(totalMonths / 12);
  const tm = ((totalMonths % 12) + 12) % 12; // 0-based month
  const daysInTarget = new Date(ty, tm + 1, 0).getDate();
  const td = Math.min(p.d, daysInTarget);
  const dt = new Date(ty, tm, td);
  return dt.toISOString().slice(0, 10);
}
// The next occurrence ON OR AFTER the day after `lastGenerated` (or the anchor
// itself if nothing generated yet). Walks forward from the anchor one interval
// at a time until it passes lastGenerated. Returns "" on bad input. Bounded to
// avoid any pathological loop on a far-past anchor.
function nextOccurrenceISO(anchorISO, interval, lastGeneratedISO) {
  if (!parseISO(anchorISO)) return "";
  if (!lastGeneratedISO || !parseISO(lastGeneratedISO)) return anchorISO;
  let cur = anchorISO;
  let guard = 0;
  while (cur <= lastGeneratedISO && guard < 1000) { cur = addInterval(anchorISO, interval, ++guard); }
  return cur;
}
// pdf-lib's standard fonts only support WinAnsi — strip anything outside it
// so drawText never throws on emoji/exotic unicode a user pastes in. This also
// strips newlines, so callers with multi-line text must split on "\n" BEFORE
// calling pdfSafe on each resulting line, never after.
const pdfSafe = (s) => String(s || "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
// Truncates text to fit maxWidth at the given font/size, using real glyph
// widths (not a flat character count, which over- or under-fits depending
// on the actual characters) so PDF columns never visually collide.
function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function fitText(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid) + "…", size) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

// ── Storage (all state lives on-device; corrupt/missing data never crashes the app) ──
const emptyParty = () => ({ name: "", email: "", address: "" });
// Business-level defaults that prefill each NEW invoice's totals/tax/currency
// (see blankInvoice). taxLabel is a local navigator.language guess the user can
// edit; currency defaults to USD so nothing changes for existing users.
const emptyBusiness = () => ({
  ...emptyParty(),
  logo: "", // logo: Pro-gated data-URL string
  taxRate: 0,
  taxLabel: guessTaxLabel(),
  discount: { value: 0, isPercent: true },
  shipping: 0,
  currency: { ...DEFAULT_CURRENCY },
  paymentDetails: "", // "How to pay" free text (bank / PayPal.me / Venmo…). Renders into the PDF only for Pro; free users can type + preview it.
});
// Guards every read site against corrupt/garbage localStorage data (wrong type,
// tampered value) before it ever reaches an <img src> or pdf-lib's embedPng/embedJpg.
const validLogo = (logo) => typeof logo === "string" && /^data:image\/(png|jpeg);base64,/.test(logo);
// Every downstream consumer (renderHub, invoiceTotal, buildPreview, doExport)
// trusts this shape — sanitizing once here means they never need their own
// defensive checks, and one corrupt invoice can't take down the whole hub.
// Discount is {value, isPercent}. Defaults to a 0% discount so an OLD invoice
// (no discount field) contributes nothing to the total and renders no line.
function sanitizeDiscount(raw) {
  if (!raw || typeof raw !== "object") return { value: 0, isPercent: true };
  return { value: safeNumber(raw.value), isPercent: raw.isPercent !== false };
}
// Recurring config lives per-invoice. Defaults to disabled so an OLD invoice
// (no recurring field) never triggers a billing prompt. `interval` is a small
// closed set; `anchorDate` is the ISO date the schedule counts from (advanced
// each time a period is generated); `lastGenerated` is the last ISO anchor we
// already produced an invoice for (so a period is never double-prompted).
const RECUR_INTERVALS = ["weekly", "monthly"];
function sanitizeRecurring(raw) {
  if (!raw || typeof raw !== "object") return { enabled: false, interval: "monthly", anchorDate: "", lastGenerated: "" };
  return {
    enabled: raw.enabled === true,
    interval: RECUR_INTERVALS.includes(raw.interval) ? raw.interval : "monthly",
    anchorDate: typeof raw.anchorDate === "string" ? raw.anchorDate : "",
    lastGenerated: typeof raw.lastGenerated === "string" ? raw.lastGenerated : "",
  };
}
// Partial payments / deposits (Pro). An ADDITIVE per-invoice array so OLD
// invoices (no payments field) load with an empty list and render exactly as
// before. Each entry is money-sanitized the same way as any other amount, with
// a stable id, an ISO date, and optional method/note/isDeposit. Anything
// malformed collapses to a safe shape instead of ever reaching render/PDF code.
function sanitizePayment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const amount = safeNumber(raw.amount);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : "pay_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    amount,
    date: typeof raw.date === "string" && raw.date ? raw.date : todayISO(),
    method: typeof raw.method === "string" ? raw.method : "",
    note: typeof raw.note === "string" ? raw.note : "",
    isDeposit: raw.isDeposit === true,
  };
}
function sanitizePayments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizePayment).filter(Boolean);
}
function sanitizeInvoice(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : "inv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    // Document kind: "invoice" (default) or "estimate". Defaults to "invoice"
    // so EVERY old saved invoice loads and renders exactly as before.
    docKind: raw.docKind === "estimate" ? "estimate" : "invoice",
    number: Number.isFinite(raw.number) ? raw.number : 1,
    date: typeof raw.date === "string" ? raw.date : todayISO(),
    dueDate: typeof raw.dueDate === "string" ? raw.dueDate : "",
    status: ["draft", "sent", "paid"].includes(raw.status) ? raw.status : "draft",
    from: raw.from && typeof raw.from === "object" ? { ...emptyParty(), ...raw.from } : emptyParty(),
    billTo: raw.billTo && typeof raw.billTo === "object" ? { ...emptyParty(), ...raw.billTo } : emptyParty(),
    items: Array.isArray(raw.items) && raw.items.length
      ? raw.items.map((it) => ({ description: typeof it?.description === "string" ? it.description : "", qty: it?.qty ?? 1, rate: it?.rate ?? 0 }))
      : [{ description: "", qty: 1, rate: 0 }],
    notes: typeof raw.notes === "string" ? raw.notes : "",
    // "How to pay" free text. Defaults to "" so OLD invoices load unchanged and
    // render no payment block. Only exported into the PDF when the user is Pro.
    paymentDetails: typeof raw.paymentDetails === "string" ? raw.paymentDetails : "",
    // ── Totals & tax (all default so OLD invoices load & render unchanged) ──
    taxRate: safeNumber(raw.taxRate),
    taxLabel: typeof raw.taxLabel === "string" && raw.taxLabel.trim() ? raw.taxLabel : guessTaxLabel(),
    discount: sanitizeDiscount(raw.discount),
    shipping: safeNumber(raw.shipping),
    currency: sanitizeCurrency(raw.currency),
    recurring: sanitizeRecurring(raw.recurring),
    // Partial payments / deposits (Pro). Defaults to [] so OLD invoices load and
    // render unchanged (no "Paid / Balance due" line, no "Partially paid" badge).
    payments: sanitizePayments(raw.payments),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}
// One shared guard for BOTH boot-time loads and data-vault imports (see
// importVault) — corrupt, foreign, or hand-edited JSON always collapses to a
// safe shape instead of ever reaching render code.
function sanitizeState(parsed) {
  const fallback = { business: emptyBusiness(), clients: [], invoices: [], nextNumber: 1 };
  if (!parsed || typeof parsed !== "object") return fallback;
  return {
    business: parsed.business && typeof parsed.business === "object" ? { ...emptyBusiness(), ...parsed.business } : fallback.business,
    clients: Array.isArray(parsed.clients) ? parsed.clients.filter((c) => c && typeof c === "object") : [],
    invoices: Array.isArray(parsed.invoices) ? parsed.invoices.map(sanitizeInvoice).filter(Boolean) : [],
    nextNumber: Number.isFinite(parsed.nextNumber) ? parsed.nextNumber : 1,
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizeState(raw ? JSON.parse(raw) : null);
  } catch { return sanitizeState(null); }
}
let state = loadState();
let lastSaveError = null;
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
  catch (e) { lastSaveError = e; return false; } // quota exceeded or private-browsing lockout — caller shows a message
}
// Defensive retry for a genuinely transient storage hiccup — retry once
// after a short delay before surfacing an error the user can't act on.
function saveStateWithRetry(onDone) {
  if (saveState()) return onDone(true);
  setTimeout(() => onDone(saveState()), 400);
}

function friendly(e) {
  if (e && e.name === "QuotaExceededError") return "Couldn't save — your browser's local storage is full. Try removing an old invoice.";
  if (e && e.name) return "Couldn't save — local storage is blocked (this can happen in private browsing). Try a normal browsing window.";
  return "Something went wrong saving that. Your data on this device is unaffected.";
}
// doExport()'s failures are a different domain entirely (PDF generation, or
// the native Filesystem/Share plugins) — reusing friendly() there previously
// mislabeled ANY export failure as "local storage is blocked" purely because
// most thrown errors happen to have a `.name` property, regardless of cause.
function friendlyExportError() {
  return "Couldn't export that — try again. Your data on this device is unaffected.";
}

// ── Invoice model helpers ───────────────────────────────────────────────
function blankInvoice() {
  const b = state.business || {};
  return {
    id: "inv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    docKind: "invoice",
    number: state.nextNumber,
    date: todayISO(),
    dueDate: "",
    status: "draft",
    from: { ...state.business },
    billTo: { name: "", email: "", address: "" },
    items: [{ description: "", qty: 1, rate: 0 }],
    notes: "",
    paymentDetails: typeof b.paymentDetails === "string" ? b.paymentDetails : "",
    // Prefill totals/tax/currency from the business-level defaults.
    taxRate: safeNumber(b.taxRate),
    taxLabel: typeof b.taxLabel === "string" && b.taxLabel.trim() ? b.taxLabel : guessTaxLabel(),
    discount: sanitizeDiscount(b.discount),
    shipping: safeNumber(b.shipping),
    currency: sanitizeCurrency(b.currency),
    recurring: { enabled: false, interval: "monthly", anchorDate: "", lastGenerated: "" },
    createdAt: Date.now(),
  };
}
// Full breakdown for an invoice. subtotal = Σ(qty·rate); discount is a % of the
// subtotal or a flat amount; tax is taxRate% of (subtotal − discount); the total
// adds shipping last. Defensive throughout via safeNumber so garbage never NaNs.
function invoiceBreakdown(inv) {
  const subtotal = (inv.items || []).reduce((sum, it) => sum + safeNumber(it.qty) * safeNumber(it.rate), 0);
  const disc = inv.discount || { value: 0, isPercent: true };
  let discountAmount = disc.isPercent
    ? subtotal * (safeNumber(disc.value) / 100)
    : safeNumber(disc.value);
  // A flat discount can't exceed the subtotal (that would make a negative base).
  if (discountAmount > subtotal) discountAmount = subtotal;
  const taxedBase = subtotal - discountAmount;
  const taxAmount = taxedBase * (safeNumber(inv.taxRate) / 100);
  const shipping = safeNumber(inv.shipping);
  const total = subtotal - discountAmount + taxAmount + shipping;
  return { subtotal, discountAmount, taxAmount, shipping, total };
}
// Kept for any legacy caller: the grand total only.
function invoiceTotal(inv) { return invoiceBreakdown(inv).total; }
// Payment summary (Pro feature: partial payments & deposits). paidToDate is the
// sum of every recorded payment, CLAMPED to the invoice total so an over-payment
// can never drive the balance negative or the paid-ratio past 100%. balanceDue is
// what's still owed. `hasPayments` distinguishes a truly-unpaid invoice from one
// that's been marked fully-paid via payments. All derived — nothing new persisted
// beyond the payments array itself. Defensive via safeNumber throughout.
function paymentSummary(inv) {
  const total = invoiceBreakdown(inv).total;
  const list = Array.isArray(inv.payments) ? inv.payments : [];
  const raw = list.reduce((sum, p) => sum + safeNumber(p && p.amount), 0);
  const paidToDate = Math.min(raw, total);
  const balanceDue = Math.max(0, total - paidToDate);
  return { total, rawPaid: raw, paidToDate, balanceDue, hasPayments: list.length > 0, count: list.length };
}
// True when payments exist but there's still a balance owed — the "Partially
// paid" state surfaced on the list, preview, and PDF.
function isPartiallyPaid(inv) {
  const s = paymentSummary(inv);
  return s.hasPayments && s.balanceDue > 0;
}
// True when payments cover the whole total (fully settled via recorded payments).
function isFullyPaidByPayments(inv) {
  const s = paymentSummary(inv);
  return s.hasPayments && s.balanceDue <= 0 && s.total > 0;
}
function invoiceNumberLabel(n) { return "#" + String(n).padStart(4, "0"); }

// ── Document kind (invoice | estimate) ─────────────────────────────────────
// One source of truth for the invoice/estimate wording so the editor, live
// preview, PDF, and hub all agree. isEstimate() tolerates missing docKind on
// old data (sanitizeInvoice already defaults it, but drafts pass through here
// too). The NUMBER is prefixed for display only — the underlying counter is
// unchanged, so an estimate and an invoice can share the same numbering line.
function isEstimate(inv) { return !!inv && inv.docKind === "estimate"; }
function docTitle(inv) { return isEstimate(inv) ? "Estimate" : "Invoice"; }
function docTitleUpper(inv) { return isEstimate(inv) ? "ESTIMATE" : "INVOICE"; }
// "#0001" for invoices, "EST-#0001" for estimates (same padded counter).
function docNumberLabel(inv) { return (isEstimate(inv) ? "EST-" : "") + invoiceNumberLabel(inv.number); }
// The date-below label: invoices show a "Due date", estimates a "Valid until".
function dueDateLabel(inv) { return isEstimate(inv) ? "Valid until" : "Due date"; }
function dueDatePrefix(inv) { return isEstimate(inv) ? "Valid until" : "Due"; }

// Collision-safe next customer-facing number. Prefers the running nextNumber,
// but never reuses a number already present on a saved invoice (two tabs open,
// a duplicate, a hand-edited nextNumber) — always ≥ max(existing)+1.
function nextInvoiceNumber() {
  const maxExisting = state.invoices.reduce((max, i) => Math.max(max, safeNumber(i.number)), 0);
  return Math.max(safeNumber(state.nextNumber), maxExisting + 1);
}

// Deep-copy an invoice into a fresh draft: new id, next collision-safe number,
// date reset to today, status back to draft. Same line items, parties, totals,
// tax, discount, shipping, currency, notes. Does NOT save — the caller opens it
// in the editor so the user can review before committing (doSave persists +
// re-runs the collision guard, so the number is still safe if state changed).
function duplicateInvoiceModel(src) {
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = "inv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  copy.number = nextInvoiceNumber();
  copy.date = todayISO();
  copy.status = "draft";
  copy.createdAt = Date.now();
  return sanitizeInvoice(copy);
}
// Duplicate then open the copy in the editor (used from the hub row + editor).
function duplicateAndEdit(sourceId) {
  const src = state.invoices.find((i) => i.id === sourceId);
  if (!src) return;
  const copy = duplicateInvoiceModel(src);
  draft = copy;
  markClean();
  buildEditor();
  enterEditorView();
}

// Clone an ESTIMATE into a fresh, next-numbered INVOICE: new id, next
// collision-safe number, today's date, draft status, docKind flipped to
// "invoice". Same parties, line items, totals, tax, discount, shipping,
// currency, notes. Recurring config is intentionally NOT carried over — the
// generated invoice is a one-off. Returns a sanitized invoice model (unsaved).
function convertEstimateModel(src) {
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = "inv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  copy.docKind = "invoice";
  copy.number = nextInvoiceNumber();
  copy.date = todayISO();
  copy.status = "draft";
  copy.recurring = { enabled: false, interval: "monthly", anchorDate: "", lastGenerated: "" };
  copy.createdAt = Date.now();
  return sanitizeInvoice(copy);
}
// Convert an estimate to a new invoice, SAVE it immediately (the estimate stays
// untouched on disk), then open the new invoice in the editor. Saving here — vs.
// the duplicate flow which opens an unsaved draft — means "Convert to invoice"
// always yields a real, persisted invoice even if the user navigates away.
function convertEstimateAndEdit(sourceId) {
  const src = state.invoices.find((i) => i.id === sourceId);
  if (!src) return;
  const newInv = convertEstimateModel(src);
  // Guard the customer-facing number against a stale nextNumber before pushing.
  if (state.invoices.some((i) => i.number === newInv.number)) newInv.number = nextInvoiceNumber();
  state.invoices.push(newInv);
  state.nextNumber = Math.max(state.nextNumber, newInv.number + 1);
  saveState();
  draft = JSON.parse(JSON.stringify(newInv));
  markClean();
  buildEditor();
  enterEditorView();
}

// ── Hub ──────────────────────────────────────────────────────────────────
// Pure client-side view state for the hub search + status filter. Never
// persisted — resets to "show everything" each load. Filtering only ever hides
// rows; it never touches state.invoices, so nothing here can lose data.
let hubSearch = "";
let hubStatusFilter = "all"; // "all" | "draft" | "sent" | "paid"
const HUB_STATUS_CHIPS = [["all", "All"], ["draft", "Draft"], ["sent", "Sent"], ["paid", "Paid"]];

// An invoice is overdue only when it has been SENT and its due date has passed.
// A draft you never sent isn't "overdue" — it just hasn't gone out yet.
function isOverdue(inv) {
  return !!inv.dueDate && inv.dueDate < todayISO() && inv.status === "sent";
}
// True when the invoice matches the current search text (client name OR the
// invoice number, with or without the # / zero-padding).
function matchesHubSearch(inv, q) {
  if (!q) return true;
  const name = (inv.billTo && inv.billTo.name || "").toLowerCase();
  const numLabel = invoiceNumberLabel(inv.number).toLowerCase(); // "#0001"
  const docLabel = docNumberLabel(inv).toLowerCase(); // "est-#0001" for estimates
  const numPlain = String(safeNumber(inv.number)); // "1"
  return name.includes(q) || numLabel.includes(q) || docLabel.includes(q) || numPlain.includes(q);
}

// renderHub() is called throughout the app after any state change (delete, save,
// Pro change, vault restore). It keeps the legacy #hub internals valid AND — via
// the wrapper below — re-renders whichever routed list view is currently on
// screen, so those callers keep working without being touched.
function renderHub() {
  renderHubInternal();
  // Re-render the active routed view so post-mutation callers (delete a row, save,
  // Pro change) reflect immediately. Guarded: only when the router is up and the
  // editor overlay isn't the thing on screen.
  try {
    if (typeof currentRoute === "string" && currentRoute &&
        $("#editor") && $("#editor").classList.contains("hidden")) {
      renderRoute(currentRoute);
    }
  } catch (e) { console.error("Local Invoice: route re-render failed", e); }
}
function renderHubInternal() {
  renderHubControls();
  renderHubSummary();
  // The Insights entry only appears once there's at least one invoice to
  // analyze — a brand-new user with an empty hub sees the clean zero-state.
  const insightsBtn = $("#insightsBtn");
  if (insightsBtn) insightsBtn.classList.toggle("hidden", state.invoices.length === 0);
  const list = $("#invoiceList"); list.innerHTML = "";
  const q = hubSearch.trim().toLowerCase();
  const filtered = state.invoices
    .filter((inv) => (hubStatusFilter === "all" || inv.status === hubStatusFilter) && matchesHubSearch(inv, q))
    .sort((a, b) => b.createdAt - a.createdAt);

  // The zero-state message: distinct copy for "no invoices at all" vs. "none
  // match this search/filter" so a filtered-empty list never reads as data loss.
  const emptyEl = $("#emptyState");
  const hasAny = state.invoices.length > 0;
  emptyEl.classList.toggle("hidden", filtered.length > 0);
  if (filtered.length === 0) {
    emptyEl.innerHTML = "";
    if (hasAny) {
      emptyEl.appendChild(txt("p", null, "No invoices match your search."));
      emptyEl.appendChild(txt("p", "muted", "Try a different name, number, or status."));
    } else {
      emptyEl.appendChild(txt("p", null, "No invoices yet."));
      emptyEl.appendChild(txt("p", "muted", "Create your first one — it's saved right here on this device."));
    }
  }

  filtered.forEach((inv) => {
    const row = el("div", "invoice-row");
    row.addEventListener("click", (e) => { if (!e.target.closest(".row-action")) openEditor(inv.id); });
    const left = el("div", "left");
    const numRow = el("div", "num-row");
    numRow.appendChild(txt("span", "num", docNumberLabel(inv)));
    // A small "Estimate" tag distinguishes estimates from invoices at a glance.
    if (isEstimate(inv)) numRow.appendChild(txt("span", "kind-tag", "Estimate"));
    left.appendChild(numRow);
    left.appendChild(txt("div", "client", inv.billTo.name || "No client name yet"));
    row.appendChild(left);
    const right = el("div", "right");
    right.appendChild(txt("div", "amount", money(invoiceTotal(inv), inv.currency)));
    right.appendChild(txt("div", `status ${inv.status}`, inv.status));

    const dup = el("button", "row-action dup", '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>');
    dup.title = "Duplicate";
    dup.type = "button";
    dup.setAttribute("aria-label", `Duplicate ${docTitle(inv).toLowerCase()} ${docNumberLabel(inv)}`);
    dup.addEventListener("click", () => duplicateAndEdit(inv.id));
    right.appendChild(dup);

    const del = el("button", "row-action del", '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>');
    del.title = "Delete";
    del.type = "button";
    del.setAttribute("aria-label", `Delete ${docTitle(inv).toLowerCase()} ${docNumberLabel(inv)}`);
    del.addEventListener("click", () => {
      if (!confirm(`Delete ${docTitle(inv).toLowerCase()} ${docNumberLabel(inv)}? This can't be undone.`)) return;
      state.invoices = state.invoices.filter((i) => i.id !== inv.id);
      saveState(); renderHub();
    });
    right.appendChild(del);
    row.appendChild(right);
    list.appendChild(row);
  });
}

// Search box + status filter chips, rebuilt each renderHub so chip highlight and
// input value always reflect current filter state. Focus is preserved across the
// rebuild triggered by typing (see the input handler).
function renderHubControls() {
  const host = $("#hubControls");
  if (!host) return;
  host.innerHTML = "";
  // Hide the whole controls bar when there's nothing to filter — a brand-new
  // user with zero invoices sees the clean empty state, unchanged.
  if (state.invoices.length === 0) { host.classList.add("hidden"); return; }
  host.classList.remove("hidden");

  const searchWrap = el("div", "hub-search");
  const searchInput = el("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search client or invoice number…";
  searchInput.value = hubSearch;
  searchInput.setAttribute("aria-label", "Search invoices by client name or number");
  searchInput.addEventListener("input", () => {
    hubSearch = searchInput.value;
    renderHub();
    // Re-focus the freshly-rebuilt input and restore the caret to the end.
    const again = host.querySelector(".hub-search input");
    if (again) { again.focus(); const v = again.value; again.value = ""; again.value = v; }
  });
  searchWrap.appendChild(searchInput);
  host.appendChild(searchWrap);

  const chips = el("div", "hub-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Filter by status");
  HUB_STATUS_CHIPS.forEach(([val, label]) => {
    const chip = txt("button", "hub-chip" + (hubStatusFilter === val ? " active" : ""), label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(hubStatusFilter === val));
    chip.onclick = () => { hubStatusFilter = val; renderHub(); };
    chips.appendChild(chip);
  });
  host.appendChild(chips);
}

// Summary bar: total outstanding (sum of every non-paid invoice's grand total,
// tax/discount/shipping included via invoiceBreakdown) + a count of overdue
// invoices. Uses the FULL invoice set, not the filtered view — it's an at-a-
// glance picture of the whole book, independent of the current search/filter.
function renderHubSummary() {
  const host = $("#hubSummary");
  if (!host) return;
  host.innerHTML = "";
  if (state.invoices.length === 0) { host.classList.add("hidden"); return; }
  host.classList.remove("hidden");

  let outstanding = 0;
  let overdue = 0;
  // Outstanding is summed per-currency so mixed-currency books don't add apples
  // to oranges; the bar shows each currency's outstanding total.
  const byCurrency = new Map();
  state.invoices.forEach((inv) => {
    // Estimates are non-binding quotes, not money owed — they never count toward
    // outstanding, per-currency totals, or the overdue tally. They only appear in
    // the invoice LIST above. (See isEstimate; mirrored in Insights math.)
    if (isEstimate(inv)) return;
    // Outstanding = the real balance still owed. A status==="paid" invoice owes
    // nothing; an invoice with recorded payments owes only its balance due (which
    // is 0 once payments cover the total). Old invoices with no payments behave
    // exactly as before (balance = full total).
    const ps = paymentSummary(inv);
    if (inv.status !== "paid") {
      const owed = ps.hasPayments ? ps.balanceDue : invoiceBreakdown(inv).total;
      if (owed > 0) {
        outstanding += owed;
        const code = (inv.currency && inv.currency.code) || DEFAULT_CURRENCY.code;
        byCurrency.set(code, (byCurrency.get(code) || 0) + owed);
      }
    }
    if (isOverdue(inv) && !isFullyPaidByPayments(inv)) overdue += 1;
  });

  const amounts = [...byCurrency.entries()].map(([code, sum]) => money(sum, currencyByCode(code) || DEFAULT_CURRENCY));
  const outLabel = amounts.length ? amounts.join(" · ") : money(0, DEFAULT_CURRENCY);

  const outEl = el("div", "hub-summary-item");
  outEl.appendChild(txt("span", "hub-summary-label", "Outstanding"));
  outEl.appendChild(txt("span", "hub-summary-value", outLabel));
  host.appendChild(outEl);

  const overdueEl = el("div", "hub-summary-item" + (overdue > 0 ? " overdue" : ""));
  overdueEl.appendChild(txt("span", "hub-summary-value", String(overdue)));
  overdueEl.appendChild(txt("span", "hub-summary-label", "overdue"));
  host.appendChild(overdueEl);
}

// showHub() is called from many flows (leave editor, save, vault restore,
// convert). It now means "close the editor overlay and return to a list route"
// — the invoices/estimates list the editor came from, or the dashboard. The
// legacy #hub container is still rendered by renderHub() (reused by the list
// views), so nothing that reads #invoiceList / #hubSummary / #emptyState breaks.
function showHub() {
  const back = (editorReturnRoute && ROUTES.includes(editorReturnRoute)) ? editorReturnRoute : "invoices";
  editorReturnRoute = null;
  goRoute(back);
}

// ── Insights (income dashboard) ────────────────────────────────────────────
// A read-only, live dashboard computed entirely from state.invoices. Every
// money figure runs through invoiceBreakdown().total, so tax/discount/shipping
// are already baked in — exactly like the hub summary bar. Nothing here mutates
// state; it's a pure view, so it can never corrupt saved data.
//
// MULTI-CURRENCY: we NEVER sum across currencies (that would add apples to
// oranges). Invoices are grouped by their currency code; each headline, chart,
// and top-client list is computed within ONE currency at a time. When a book
// spans multiple currencies a small segmented switcher lets the user pick which
// currency to view, and a hint says so plainly. `insightsCurrency` holds the
// currently-selected code (session-only, never persisted).
let insightsCurrency = null;

// ── Local date-window helpers (all local time, no UTC traps) ──────────────
// An invoice's own `date` (ISO "YYYY-MM-DD") drives every time bucket. We parse
// it via parseISO (shared with the recurring engine) so a malformed date can
// never throw or land in the wrong month.
function invoiceMonthKey(inv) {
  const p = parseISO(inv && inv.date);
  if (!p) return null;
  return p.y * 12 + (p.m - 1); // a monotonically increasing month index
}
function currentMonthKey() {
  const now = new Date();
  return now.getFullYear() * 12 + now.getMonth();
}
// Quarter index (0-based) from a 0-based month.
function quarterOfMonth(m0) { return Math.floor(m0 / 3); }

// Group invoices by currency code, preserving a stable order (most invoices
// first, ties broken by first-seen). Returns [{code, currency, invoices}, …].
function invoicesByCurrency() {
  const groups = new Map();
  state.invoices.forEach((inv) => {
    // Estimates are non-binding quotes — excluded from ALL income math (headline
    // totals, chart, top clients, average). They only affect the invoice LIST.
    if (isEstimate(inv)) return;
    const code = (inv.currency && inv.currency.code) || DEFAULT_CURRENCY.code;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(inv);
  });
  return [...groups.entries()]
    .map(([code, invoices]) => ({ code, currency: currencyByCode(code) || DEFAULT_CURRENCY, invoices }))
    .sort((a, b) => b.invoices.length - a.invoices.length);
}

// Everything the dashboard shows for ONE currency's slice of invoices.
function computeInsights(invoices) {
  const nowKey = currentMonthKey();
  const now = new Date();
  const curYear = now.getFullYear();
  const curQuarter = quarterOfMonth(now.getMonth());
  const today = todayISO();

  let monthTotal = 0, quarterTotal = 0, yearTotal = 0;
  let paidTotal = 0, outstandingTotal = 0;
  let overdueCount = 0;
  let grandTotal = 0;
  const clientTotals = new Map(); // name → revenue
  // 12 monthly buckets, index 0 = 11 months ago, index 11 = this month.
  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const key = nowKey - i;
    const y = Math.floor(key / 12);
    const m0 = key % 12;
    monthly.push({ key, y, m0, total: 0 });
  }
  const monthlyByKey = new Map(monthly.map((b) => [b.key, b]));

  invoices.forEach((inv) => {
    // Estimates are non-binding quotes — never counted as income. invoicesByCurrency
    // already filters them out before grouping, so this is a defensive guard in case
    // computeInsights is ever handed a raw (unfiltered) list. Every downstream figure
    // (month/quarter/year, paid/outstanding, top clients, average, monthly chart)
    // therefore excludes estimates.
    if (isEstimate(inv)) return;
    const total = invoiceBreakdown(inv).total;
    grandTotal += total;

    const p = parseISO(inv.date);
    if (p) {
      if (p.y === curYear) {
        yearTotal += total;
        if (quarterOfMonth(p.m - 1) === curQuarter) quarterTotal += total;
        if ((p.m - 1) === now.getMonth()) monthTotal += total;
      }
      const mk = invoiceMonthKey(inv);
      if (mk != null && monthlyByKey.has(mk)) monthlyByKey.get(mk).total += total;
    }

    if (inv.status === "paid") paidTotal += total;
    else outstandingTotal += total; // unpaid = status !== "paid"

    // Overdue: has a past due date and isn't paid (mirrors isOverdue()).
    if (isOverdue(inv)) overdueCount += 1;

    const name = (inv.billTo && inv.billTo.name || "").trim() || "No client name";
    clientTotals.set(name, (clientTotals.get(name) || 0) + total);
  });

  const topClients = [...clientTotals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const avgValue = invoices.length ? grandTotal / invoices.length : 0;

  return {
    count: invoices.length,
    monthTotal, quarterTotal, yearTotal,
    paidTotal, outstandingTotal, overdueCount,
    avgValue, topClients, monthly,
  };
}

// Reports/insights now live on the Dashboard route (no separate route). Kept as
// a thin alias so any legacy caller (the hidden #insightsBtn) still works.
function showInsights() { goRoute("dashboard"); }

// Short month label ("Jan", "Feb '25" when the year differs from now) for a
// bucket. Uses a fixed local Date so it never drifts across a DST boundary.
function monthShortLabel(bucket) {
  const dt = new Date(bucket.y, bucket.m0, 1);
  return dt.toLocaleDateString("en-US", { month: "short" });
}
function monthFullLabel(bucket) {
  const dt = new Date(bucket.y, bucket.m0, 1);
  return dt.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function buildInsights() {
  const root = $("#insights"); root.innerHTML = "";

  // Header: back link + title.
  const head = el("div", "insights-head");
  const back = txt("button", "back", "← All invoices"); back.type = "button"; back.onclick = showHub;
  head.appendChild(back);
  head.appendChild(el("div", "spacer"));
  root.appendChild(head);

  const title = el("div", "insights-title");
  title.appendChild(txt("h1", null, "Income insights"));
  title.appendChild(txt("p", "insights-sub", "A live look at your invoicing — computed on this device from your invoices. Nothing is uploaded."));
  root.appendChild(title);

  // Empty state: no invoices at all.
  if (state.invoices.length === 0) {
    const empty = el("div", "insights-empty");
    empty.appendChild(txt("p", null, "Create a few invoices to see insights."));
    empty.appendChild(txt("p", "muted", "Totals, top clients, and a monthly income chart appear here once you've added some."));
    root.appendChild(empty);
    return;
  }

  const groups = invoicesByCurrency();
  // Estimates are excluded from income math (invoicesByCurrency filters them out),
  // so a book with ONLY estimates yields no billable groups. Show a tailored
  // empty state instead of the zero-invoice one — the estimates are real, they
  // just aren't income yet.
  if (groups.length === 0) {
    const empty = el("div", "insights-empty");
    empty.appendChild(txt("p", null, "No billed income yet."));
    empty.appendChild(txt("p", "muted", "Estimates are quotes, not income — convert one to an invoice (or create an invoice) to see totals here."));
    root.appendChild(empty);
    return;
  }
  // Default the selected currency to the biggest group; keep the user's choice
  // if it's still valid after invoices changed.
  if (!insightsCurrency || !groups.some((g) => g.code === insightsCurrency)) {
    insightsCurrency = groups[0].code;
  }
  const multi = groups.length > 1;

  if (multi) {
    // Currency switcher — one chip per currency, showing the invoice count.
    const hint = txt("p", "insights-hint", "Your invoices span multiple currencies. To keep the math honest, amounts are never mixed — pick a currency to view its totals.");
    root.appendChild(hint);
    const switcher = el("div", "insights-cur-switch");
    switcher.setAttribute("role", "group");
    switcher.setAttribute("aria-label", "Choose currency to view");
    groups.forEach((g) => {
      const active = g.code === insightsCurrency;
      const chip = txt("button", "insights-cur-chip" + (active ? " active" : ""),
        `${g.code} (${g.invoices.length})`);
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(active));
      chip.onclick = () => { insightsCurrency = g.code; buildInsights(); };
      switcher.appendChild(chip);
    });
    root.appendChild(switcher);
  }

  const group = groups.find((g) => g.code === insightsCurrency) || groups[0];
  const cur = group.currency;
  const data = computeInsights(group.invoices);

  // ── Headline stat cards ──
  const stats = el("div", "insights-stats");
  const addStat = (label, value, opts) => {
    const card = el("div", "insight-card" + (opts && opts.cls ? " " + opts.cls : ""));
    card.appendChild(txt("div", "insight-card-label", label));
    card.appendChild(txt("div", "insight-card-value", value));
    if (opts && opts.sub) card.appendChild(txt("div", "insight-card-sub", opts.sub));
    stats.appendChild(card);
  };
  addStat("Billed this month", money(data.monthTotal, cur));
  addStat("Billed this quarter", money(data.quarterTotal, cur));
  addStat("Billed this year", money(data.yearTotal, cur));
  addStat("Paid", money(data.paidTotal, cur), { cls: "paid" });
  addStat("Outstanding", money(data.outstandingTotal, cur), { cls: "outstanding" });
  addStat("Overdue", String(data.overdueCount),
    { cls: data.overdueCount > 0 ? "overdue" : "", sub: data.overdueCount === 1 ? "invoice past due" : "invoices past due" });
  addStat("Average invoice", money(data.avgValue, cur), { sub: `across ${data.count} ${data.count === 1 ? "invoice" : "invoices"}` });
  root.appendChild(stats);

  // ── Monthly income chart (inline SVG) ──
  const chartPanel = el("div", "insight-panel");
  chartPanel.appendChild(txt("h3", null, "Monthly income"));
  chartPanel.appendChild(txt("p", "insight-panel-sub", `Last 12 months · ${cur.code}`));
  chartPanel.appendChild(buildMonthlyChart(data.monthly, cur));
  root.appendChild(chartPanel);

  // ── Top clients by revenue ──
  const clientsPanel = el("div", "insight-panel");
  clientsPanel.appendChild(txt("h3", null, "Top clients by revenue"));
  if (!data.topClients.length || data.topClients.every((c) => c.total <= 0)) {
    clientsPanel.appendChild(txt("p", "muted", "No billed revenue yet in this currency."));
  } else {
    const maxClient = data.topClients[0].total || 1;
    const list = el("div", "top-clients");
    data.topClients.forEach((c, i) => {
      const rowEl = el("div", "top-client-row");
      const rank = txt("div", "top-client-rank", String(i + 1));
      const body = el("div", "top-client-body");
      const nameRow = el("div", "top-client-name-row");
      nameRow.appendChild(txt("span", "top-client-name", c.name)); // textContent — user-derived
      nameRow.appendChild(txt("span", "top-client-total", money(c.total, cur)));
      body.appendChild(nameRow);
      const barTrack = el("div", "top-client-bar-track");
      const bar = el("div", "top-client-bar");
      const pct = maxClient > 0 ? Math.max(2, Math.round((c.total / maxClient) * 100)) : 0;
      bar.style.width = pct + "%";
      barTrack.appendChild(bar);
      body.appendChild(barTrack);
      rowEl.append(rank, body);
      list.appendChild(rowEl);
    });
    clientsPanel.appendChild(list);
  }
  root.appendChild(clientsPanel);
}

// Inline SVG bar chart of monthly income — no chart library. Bars are scaled to
// the tallest month; each bar carries a <title> so hovering shows the exact
// amount, and an aria-label makes the whole chart legible to screen readers.
// Colors come from CSS variables (var(--brand) etc.), so it themes in dark mode
// automatically. Returns a wrapper div (horizontally scrollable on narrow
// screens so the page body never scrolls sideways).
function buildMonthlyChart(monthly, cur) {
  const wrap = el("div", "chart-wrap");
  const NS = "http://www.w3.org/2000/svg";
  const n = monthly.length;
  const W = 720, H = 240;
  const padL = 8, padR = 8, padTop = 16, padBottom = 34;
  const plotW = W - padL - padR;
  const plotH = H - padTop - padBottom;
  const slot = plotW / n;
  const barW = Math.min(38, slot * 0.6);
  const maxTotal = monthly.reduce((m, b) => Math.max(m, b.total), 0);

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "monthly-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const totalBilled = monthly.reduce((s, b) => s + b.total, 0);
  svg.setAttribute("aria-label",
    `Monthly income for the last ${n} months, ${cur.code}. Total ${money(totalBilled, cur)}.`);

  // Baseline.
  const baseY = padTop + plotH;
  const axis = document.createElementNS(NS, "line");
  axis.setAttribute("x1", padL); axis.setAttribute("y1", baseY);
  axis.setAttribute("x2", W - padR); axis.setAttribute("y2", baseY);
  axis.setAttribute("class", "chart-axis");
  svg.appendChild(axis);

  monthly.forEach((b, i) => {
    const x = padL + slot * i + (slot - barW) / 2;
    const h = maxTotal > 0 ? (b.total / maxTotal) * plotH : 0;
    const y = baseY - h;

    // The bar (min visible height of 2px when there's any income so a tiny
    // month isn't invisible; zero months draw nothing).
    if (b.total > 0) {
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", x.toFixed(1));
      rect.setAttribute("y", (baseY - Math.max(2, h)).toFixed(1));
      rect.setAttribute("width", barW.toFixed(1));
      rect.setAttribute("height", Math.max(2, h).toFixed(1));
      rect.setAttribute("rx", "3");
      // The most-recent month + the tallest month get the solid brand fill; the
      // rest a softer tint, so "this month" and the peak read at a glance.
      const isMax = b.total === maxTotal;
      rect.setAttribute("class", "chart-bar" + (isMax ? " peak" : ""));
      const title = document.createElementNS(NS, "title");
      title.textContent = `${monthFullLabel(b)}: ${money(b.total, cur)}`;
      rect.appendChild(title);
      svg.appendChild(rect);
    }

    // Month label under each slot.
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", (padL + slot * i + slot / 2).toFixed(1));
    label.setAttribute("y", (baseY + 20).toFixed(1));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "chart-label");
    label.textContent = monthShortLabel(b);
    svg.appendChild(label);
  });

  wrap.appendChild(svg);
  return wrap;
}


// ── Recurring invoices: boot-time "time to bill again" prompts ─────────────
// NO background process. On boot / hub-show, scan for recurring invoices whose
// next occurrence (anchor + N intervals, past whatever's already been
// generated) is on or before today. Each such invoice yields ONE prompt banner
// offering to generate the next occurrence. Session-dismissed ids are held in
// memory only (a fresh reload re-surfaces them, by design — the reminder isn't
// "done" until the invoice is actually generated).
const recurringDismissed = new Set();
// A recurring invoice is "due" when it's enabled, has a valid anchor, and its
// next un-generated occurrence is on or before today. Returns the due ISO date
// (the period to generate) or null.
function recurringDueDate(inv) {
  const r = inv && inv.recurring;
  if (!r || r.enabled !== true) return null;
  if (!parseISO(r.anchorDate)) return null;
  const next = nextOccurrenceISO(r.anchorDate, r.interval, r.lastGenerated);
  if (!next) return null;
  return next <= todayISO() ? next : null;
}
function dueRecurringInvoices() {
  return state.invoices.filter((inv) => !recurringDismissed.has(inv.id) && recurringDueDate(inv));
}
// Human "Month" (or week-of) label for the banner copy, derived from the due
// period date.
function recurringPeriodLabel(inv, dueISO) {
  const p = parseISO(dueISO);
  if (!p) return "";
  const dt = new Date(p.y, p.m - 1, p.d);
  if (inv.recurring.interval === "weekly") {
    return "week of " + dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return dt.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
// Generate the next occurrence of a recurring invoice: a fresh, next-numbered
// DRAFT invoice dated today, cloned from the source (same client/items/totals),
// itself NOT recurring. Advances the SOURCE's recurring.lastGenerated to the
// period we just produced so that period never prompts again. Saves both.
function generateRecurringInvoice(sourceId) {
  const src = state.invoices.find((i) => i.id === sourceId);
  if (!src) return;
  const dueISO = recurringDueDate(src);
  if (!dueISO) { renderRecurringBanner(); return; }
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = "inv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  copy.docKind = "invoice";
  copy.number = nextInvoiceNumber();
  copy.date = todayISO();
  copy.status = "draft";
  copy.recurring = { enabled: false, interval: "monthly", anchorDate: "", lastGenerated: "" };
  copy.createdAt = Date.now();
  const newInv = sanitizeInvoice(copy);
  if (state.invoices.some((i) => i.number === newInv.number)) newInv.number = nextInvoiceNumber();
  state.invoices.push(newInv);
  state.nextNumber = Math.max(state.nextNumber, newInv.number + 1);
  // Advance the source's schedule so this period is marked done.
  src.recurring.lastGenerated = dueISO;
  saveState();
  renderHub();
  renderRecurringBanner();
  showVaultToast(`New invoice ${invoiceNumberLabel(newInv.number)} created for ${src.billTo.name || "your client"}.`);
}
// Build (or clear) the stack of prompt banners at the top of the hub.
function maybeShowRecurringPrompts() { renderRecurringBanner(); }
function renderRecurringBanner() {
  const host = $("#recurringPrompts");
  if (!host) return;
  host.innerHTML = "";
  // The prompts belong on the Dashboard route. Only render them when the
  // dashboard is the active route and no editor overlay is open.
  const editorOpen = $("#editor") && !$("#editor").classList.contains("hidden");
  if (editorOpen || currentRoute !== "dashboard") { host.classList.add("hidden"); return; }
  const due = dueRecurringInvoices();
  if (!due.length) { host.classList.add("hidden"); return; }
  host.classList.remove("hidden");
  due.forEach((inv) => {
    const dueISO = recurringDueDate(inv);
    const bar = el("div", "recurring-prompt");
    bar.setAttribute("role", "status");
    const msg = el("div", "recurring-prompt-msg");
    const client = inv.billTo.name || "your client";
    const period = recurringPeriodLabel(inv, dueISO);
    // textContent-only (client name is user-derived).
    msg.appendChild(txt("span", null, `Time to bill ${client} again`));
    if (period) msg.appendChild(txt("span", "recurring-prompt-period", ` — generate the ${period} invoice?`));
    bar.appendChild(msg);
    const btns = el("div", "recurring-prompt-actions");
    const gen = txt("button", "btn sm", "Generate invoice"); gen.type = "button";
    gen.onclick = () => generateRecurringInvoice(inv.id);
    const dismiss = txt("button", "recurring-prompt-x", "×"); dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss reminder");
    dismiss.onclick = () => { recurringDismissed.add(inv.id); renderRecurringBanner(); };
    btns.append(gen, dismiss);
    bar.appendChild(btns);
    host.appendChild(bar);
  });
}

// ── Editor ───────────────────────────────────────────────────────────────
let draft = null; // the invoice currently being edited (not yet saved)
let draftSnapshot = null; // JSON of draft at last open/save, for dirty-checking on exit

function markClean() { draftSnapshot = JSON.stringify(draft); }
function isDirty() { return draftSnapshot !== null && JSON.stringify(draft) !== draftSnapshot; }
function leaveEditor() {
  if (isDirty() && !confirm("You have unsaved changes. Leave without saving?")) return;
  showHub();
}

function openEditor(invoiceId) {
  const existing = invoiceId ? state.invoices.find((i) => i.id === invoiceId) : null;
  draft = existing ? JSON.parse(JSON.stringify(existing)) : blankInvoice();
  markClean();
  buildEditor();
  enterEditorView();
}

function buildEditor() {
  const root = $("#editor"); root.innerHTML = "";

  const head = el("div", "editor-head");
  const back = txt("button", "back", "← All invoices"); back.onclick = leaveEditor;
  head.appendChild(back);
  head.appendChild(el("div", "spacer"));
  // Invoice / Estimate toggle — two segmented buttons. Flipping updates the
  // draft's docKind and rebuilds so the title, number prefix, and the "Valid
  // until" label all follow immediately in the editor + live preview.
  const kindToggle = el("div", "kind-toggle");
  kindToggle.setAttribute("role", "group");
  kindToggle.setAttribute("aria-label", "Document type");
  [["invoice", "Invoice"], ["estimate", "Estimate"]].forEach(([val, label]) => {
    const active = (draft.docKind === "estimate") === (val === "estimate");
    const b = txt("button", "kind-toggle-btn" + (active ? " active" : ""), label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(active));
    b.onclick = () => { if (draft.docKind === val) return; draft.docKind = val; buildEditor(); };
    kindToggle.appendChild(b);
  });
  head.appendChild(kindToggle);
  head.appendChild(txt("div", `status-badge ${draft.status}`, draft.status));
  root.appendChild(head);

  const grid = el("div", "editor-grid");
  const formCol = el("div");
  const previewCol = el("div");
  grid.append(formCol, previewCol);
  root.appendChild(grid);

  // ── From ──
  const fromPanel = el("div", "panel");
  fromPanel.appendChild(txt("h3", null, "From"));
  fromPanel.appendChild(field("Your name / business", draft.from.name, (v) => { draft.from.name = v; state.business.name = v; refresh(); }));
  fromPanel.appendChild(field("Email", draft.from.email, (v) => { draft.from.email = v; state.business.email = v; refresh(); }));
  fromPanel.appendChild(field("Address", draft.from.address, (v) => { draft.from.address = v; state.business.address = v; refresh(); }, true));
  fromPanel.appendChild(buildLogoField());
  fromPanel.appendChild(buildPaymentDetailsField());
  formCol.appendChild(fromPanel);

  // ── Bill to ──
  const toPanel = el("div", "panel");
  toPanel.appendChild(txt("h3", null, "Bill to"));
  if (state.clients.length) {
    const pickRow = el("div", "field");
    pickRow.appendChild(txt("span", "field-label", "Saved clients"));
    const select = el("select"); select.style.cssText = "width:100%;border:1.5px solid var(--line);border-radius:9px;padding:9px 11px;background:var(--input-bg);color:var(--ink);";
    select.setAttribute("aria-label", "Saved clients");
    select.appendChild(txt("option", null, "Choose a saved client…"));
    state.clients.forEach((c, i) => { const o = txt("option", null, c.name || "Unnamed client"); o.value = String(i); select.appendChild(o); });
    select.onchange = () => {
      const c = state.clients[+select.value]; if (!c) return;
      draft.billTo = { ...c }; buildEditor();
    };
    pickRow.appendChild(select);
    toPanel.appendChild(pickRow);
  }
  toPanel.appendChild(field("Client name", draft.billTo.name, (v) => { draft.billTo.name = v; refresh(); }));
  toPanel.appendChild(field("Email", draft.billTo.email, (v) => { draft.billTo.email = v; refresh(); }));
  toPanel.appendChild(field("Address", draft.billTo.address, (v) => { draft.billTo.address = v; refresh(); }, true));
  formCol.appendChild(toPanel);

  // ── Details ──
  const detailPanel = el("div", "panel");
  detailPanel.appendChild(txt("h3", null, "Details"));
  const dateRow = el("div", "field-row");
  const dateLabel = isEstimate(draft) ? "Estimate date" : "Invoice date";
  dateRow.appendChild(field(dateLabel, draft.date, (v) => { draft.date = v; refresh(); }, false, "date"));
  dateRow.appendChild(field(dueDateLabel(draft), draft.dueDate, (v) => { draft.dueDate = v; refresh(); }, false, "date"));
  detailPanel.appendChild(dateRow);
  const statusField = el("div", "field");
  statusField.appendChild(txt("span", "field-label", "Status"));
  const statusSelect = el("select"); statusSelect.style.cssText = "width:100%;border:1.5px solid var(--line);border-radius:9px;padding:9px 11px;background:var(--input-bg);color:var(--ink);";
  statusSelect.setAttribute("aria-label", "Status");
  ["draft", "sent", "paid"].forEach((s) => { const o = txt("option", null, s[0].toUpperCase() + s.slice(1)); o.value = s; if (s === draft.status) o.selected = true; statusSelect.appendChild(o); });
  statusSelect.onchange = () => { draft.status = statusSelect.value; refresh(); };
  statusField.appendChild(statusSelect);
  detailPanel.appendChild(statusField);
  formCol.appendChild(detailPanel);

  // ── Line items ──
  const itemsPanel = el("div", "panel");
  itemsPanel.appendChild(txt("h3", null, "Line items"));
  const itemsWrap = el("div", "lineitems");
  itemsPanel.appendChild(itemsWrap);
  const addBtn = txt("button", "btn ghost sm", "+ Add line");
  addBtn.type = "button";
  addBtn.onclick = () => { draft.items.push({ description: "", qty: 1, rate: 0 }); buildEditor(); };
  itemsPanel.appendChild(addBtn);
  formCol.appendChild(itemsPanel);
  renderLineItems(itemsWrap);

  // ── Totals & tax ──
  formCol.appendChild(buildTotalsPanel(refresh));

  // ── Payments & deposits (Pro; invoices only — estimates aren't billed) ──
  if (!isEstimate(draft)) formCol.appendChild(buildPaymentsPanel(refresh));

  // ── Repeat / recurring (invoices only) ──
  // Estimates are one-off quotes, so the recurring control is hidden for them.
  if (!isEstimate(draft)) formCol.appendChild(buildRecurringPanel());

  // ── Notes ──
  const notesPanel = el("div", "panel");
  notesPanel.appendChild(txt("h3", null, "Notes / terms"));
  const notesField = el("div", "field");
  const notesArea = el("textarea"); notesArea.value = draft.notes; notesArea.placeholder = "e.g. Thank you for your business. Payment due within 15 days.";
  notesArea.setAttribute("aria-label", "Notes / terms");
  notesArea.oninput = () => { draft.notes = notesArea.value; refresh(); };
  notesField.appendChild(notesArea);
  notesPanel.appendChild(notesField);
  formCol.appendChild(notesPanel);

  // ── Actions ──
  const actions = el("div", "panel");
  actions.style.cssText = "display:flex; gap:10px; flex-wrap:wrap;";
  const saveBtn = txt("button", "btn", "Save invoice"); saveBtn.onclick = doSave;
  const pdfBtn = txt("button", "btn ghost", "Download PDF");
  // Busy state while the PDF builds (first export also lazy-loads pdf-lib).
  pdfBtn.onclick = async () => {
    if (pdfBtn.disabled) return;
    const orig = pdfBtn.textContent; pdfBtn.disabled = true; pdfBtn.textContent = "Generating…";
    try { await doExport(); } finally { pdfBtn.disabled = false; pdfBtn.textContent = orig; }
  };
  actions.append(saveBtn, pdfBtn);
  // Duplicate is only meaningful for an already-saved invoice (a brand-new draft
  // has nothing on disk yet). Deep-copies the SAVED version, so unsaved edits to
  // this draft are intentionally not carried into the copy.
  const isSaved = state.invoices.some((i) => i.id === draft.id);
  if (isSaved) {
    const dupBtn = txt("button", "btn ghost", "Duplicate");
    dupBtn.type = "button";
    dupBtn.onclick = () => {
      if (isDirty() && !confirm("Duplicate the last saved version? Unsaved changes here won't be copied.")) return;
      duplicateAndEdit(draft.id);
    };
    actions.append(dupBtn);
    // Convert to invoice — only for a SAVED estimate. Clones the saved version
    // into a fresh next-numbered invoice (the estimate stays intact).
    if (isEstimate(draft)) {
      const convBtn = txt("button", "btn ghost", "Convert to invoice");
      convBtn.type = "button";
      convBtn.onclick = () => {
        if (isDirty() && !confirm("Convert the last saved version to an invoice? Unsaved changes here won't be copied.")) return;
        convertEstimateAndEdit(draft.id);
      };
      actions.append(convBtn);
    }
  }
  formCol.appendChild(actions);
  const msgHost = el("div"); msgHost.id = "editorMsg"; formCol.appendChild(msgHost);

  // ── Live preview ──
  previewCol.appendChild(buildPreview());

  function refresh() { const p = buildPreview(); previewCol.innerHTML = ""; previewCol.appendChild(p); }
}

// ── Totals & tax (currency, tax, discount, shipping) ──────────────────────
// Compact editor block. Every change writes back to `draft` AND updates the
// matching business-level default (so the next new invoice prefills the same
// way), then calls refresh() to re-render the live preview.
const SELECT_CSS = "width:100%;border:1.5px solid var(--line);border-radius:9px;padding:9px 11px;background:var(--input-bg);color:var(--ink);";
function buildTotalsPanel(refresh) {
  // Ensure a well-formed shape even if a hand-edited draft slipped through.
  if (!draft.currency || typeof draft.currency !== "object") draft.currency = { ...DEFAULT_CURRENCY };
  if (!draft.discount || typeof draft.discount !== "object") draft.discount = { value: 0, isPercent: true };

  const panel = el("div", "panel");
  panel.appendChild(txt("h3", null, "Totals & tax"));

  // ── Currency ──
  const curField = el("div", "field");
  curField.appendChild(txt("span", "field-label", "Currency"));
  const curSelect = el("select"); curSelect.style.cssText = SELECT_CSS;
  curSelect.setAttribute("aria-label", "Currency");
  CURRENCIES.forEach((c) => {
    const o = txt("option", null, `${c.code} (${c.symbol})`); o.value = c.code;
    if (c.code === draft.currency.code) o.selected = true;
    curSelect.appendChild(o);
  });
  curSelect.onchange = () => {
    draft.currency = { ...(currencyByCode(curSelect.value) || DEFAULT_CURRENCY) };
    state.business.currency = { ...draft.currency };
    refresh();
  };
  curField.appendChild(curSelect);
  panel.appendChild(curField);

  // ── Tax rate + editable label (side by side) ──
  const taxRow = el("div", "field-row");
  const rateField = el("div", "field");
  rateField.appendChild(txt("span", "field-label", "Tax rate (%)"));
  const rateInput = el("input"); rateInput.inputMode = "decimal"; rateInput.value = draft.taxRate;
  rateInput.setAttribute("aria-label", "Tax rate (%)");
  rateInput.oninput = () => { draft.taxRate = rateInput.value; state.business.taxRate = safeNumber(rateInput.value); refresh(); };
  rateField.appendChild(rateInput);
  const labelField = el("div", "field");
  labelField.appendChild(txt("span", "field-label", "Tax label"));
  const labelInput = el("input"); labelInput.value = draft.taxLabel || ""; labelInput.placeholder = "VAT / GST / Sales tax";
  labelInput.setAttribute("aria-label", "Tax label");
  labelInput.oninput = () => { draft.taxLabel = labelInput.value; state.business.taxLabel = labelInput.value; refresh(); };
  labelField.appendChild(labelInput);
  taxRow.append(rateField, labelField);
  panel.appendChild(taxRow);

  // ── Discount (value + %/flat toggle) ──
  const discRow = el("div", "field-row");
  const discValField = el("div", "field");
  discValField.appendChild(txt("span", "field-label", "Discount"));
  const discInput = el("input"); discInput.inputMode = "decimal"; discInput.value = draft.discount.value;
  discInput.setAttribute("aria-label", "Discount");
  discInput.oninput = () => { draft.discount.value = discInput.value; state.business.discount = { ...draft.discount, value: safeNumber(discInput.value) }; refresh(); };
  discValField.appendChild(discInput);
  const discTypeField = el("div", "field");
  discTypeField.appendChild(txt("span", "field-label", "Discount type"));
  const discSelect = el("select"); discSelect.style.cssText = SELECT_CSS;
  discSelect.setAttribute("aria-label", "Discount type");
  [["percent", "% of subtotal"], ["flat", "Flat amount"]].forEach(([val, lbl]) => {
    const o = txt("option", null, lbl); o.value = val;
    if ((val === "percent") === (draft.discount.isPercent !== false)) o.selected = true;
    discSelect.appendChild(o);
  });
  discSelect.onchange = () => { draft.discount.isPercent = discSelect.value === "percent"; state.business.discount = { ...draft.discount }; refresh(); };
  discTypeField.appendChild(discSelect);
  discRow.append(discValField, discTypeField);
  panel.appendChild(discRow);

  // ── Shipping ──
  const shipField = el("div", "field");
  shipField.appendChild(txt("span", "field-label", "Shipping"));
  const shipInput = el("input"); shipInput.inputMode = "decimal"; shipInput.value = draft.shipping;
  shipInput.setAttribute("aria-label", "Shipping");
  shipInput.oninput = () => { draft.shipping = shipInput.value; state.business.shipping = safeNumber(shipInput.value); refresh(); };
  shipField.appendChild(shipInput);
  panel.appendChild(shipField);

  return panel;
}

// ── Payments & deposits (Pro) ──────────────────────────────────────────────
// Record partial payments / deposits against an invoice and always see the exact
// balance due. The full section (running summary, list, add form) is visible to
// everyone so free users see exactly what Pro unlocks — but the "Record payment"
// action is GATED behind the app's existing Pro mechanism (fresh
// Billing.refreshProStatus() → reconcileProAccess() → Billing.isPro(), else
// remember the intent + showProModal), mirroring the logo-upload gate. All writes
// go to draft.payments; saving persists them like any other field.
function buildPaymentsPanel(refresh) {
  if (!Array.isArray(draft.payments)) draft.payments = [];
  const panel = el("div", "panel payments-panel");
  const headRow = el("div", "field-label-row");
  headRow.appendChild(txt("h3", null, "Payments & deposits"));
  headRow.appendChild(txt("span", "pro-tag", "Pro"));
  headRow.style.cssText = "margin-bottom:14px;";
  panel.appendChild(headRow);

  const cur = draft.currency;
  const sum = paymentSummary(draft);

  // Running summary: Total / Paid to date / Balance due.
  const summary = el("div", "payments-summary");
  const addSumRow = (label, value, cls) => {
    const r = el("div", "payments-summary-row" + (cls ? " " + cls : ""));
    r.appendChild(txt("span", "payments-summary-label", label));
    r.appendChild(txt("span", "payments-summary-value", value));
    summary.appendChild(r);
  };
  addSumRow("Invoice total", money(sum.total, cur));
  addSumRow("Paid to date", money(sum.paidToDate, cur));
  addSumRow(sum.balanceDue <= 0 && sum.hasPayments ? "Balance due — paid in full" : "Balance due",
            money(sum.balanceDue, cur),
            sum.hasPayments ? (sum.balanceDue <= 0 ? "settled" : "outstanding") : "");
  panel.appendChild(summary);

  // Existing payments list (each row removable). textContent-only for the
  // user-entered method/note strings.
  const list = el("div", "payments-list");
  if (draft.payments.length) {
    draft.payments.forEach((p, i) => {
      const row = el("div", "payment-row");
      const info = el("div", "payment-row-info");
      const top = el("div", "payment-row-top");
      top.appendChild(txt("span", "payment-row-amount", money(safeNumber(p.amount), cur)));
      if (p.isDeposit) top.appendChild(txt("span", "payment-badge", "Deposit"));
      info.appendChild(top);
      const metaBits = [fmtDate(p.date) || "", (p.method || "").trim(), (p.note || "").trim()].filter(Boolean);
      if (metaBits.length) info.appendChild(txt("div", "payment-row-meta", metaBits.join(" · ")));
      row.appendChild(info);
      const rm = el("button", "rm payment-rm", '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>');
      rm.type = "button";
      rm.setAttribute("aria-label", `Remove payment of ${money(safeNumber(p.amount), cur)}`);
      rm.onclick = () => { draft.payments.splice(i, 1); buildEditor(); };
      row.appendChild(rm);
      list.appendChild(row);
    });
  } else {
    list.appendChild(txt("p", "field-hint payments-empty", "No payments recorded yet. Log a deposit or a partial payment and the balance due updates instantly."));
  }
  panel.appendChild(list);

  // ── Add-payment form ──
  const form = el("div", "payment-add");
  const amtRow = el("div", "field-row");
  const amtField = el("div", "field");
  amtField.appendChild(txt("span", "field-label", "Amount"));
  const amtInput = el("input"); amtInput.inputMode = "decimal"; amtInput.placeholder = "0.00";
  amtInput.id = "paymentAmountInput";
  amtInput.setAttribute("aria-label", "Payment amount");
  amtField.appendChild(amtInput);
  const dateField = field("Date", todayISO(), () => {}, false, "date");
  const dateInput = dateField.querySelector("input");
  amtRow.append(amtField, dateField);
  form.appendChild(amtRow);

  const metaRow = el("div", "field-row");
  const methodField = el("div", "field");
  methodField.appendChild(txt("span", "field-label", "Method (optional)"));
  const methodInput = el("input"); methodInput.placeholder = "Bank transfer, card, cash…";
  methodInput.setAttribute("aria-label", "Payment method");
  methodField.appendChild(methodInput);
  const noteField = el("div", "field");
  noteField.appendChild(txt("span", "field-label", "Note (optional)"));
  const noteInput = el("input"); noteInput.placeholder = "e.g. 50% deposit";
  noteInput.setAttribute("aria-label", "Payment note");
  noteField.appendChild(noteInput);
  metaRow.append(methodField, noteField);
  form.appendChild(metaRow);

  const depRow = el("div", "payment-deposit-row");
  const depCb = el("input"); depCb.type = "checkbox"; depCb.id = "paymentIsDeposit";
  const depLabel = txt("label", "payment-deposit-label", "This is a deposit");
  depLabel.setAttribute("for", "paymentIsDeposit");
  depRow.append(depCb, depLabel);
  form.appendChild(depRow);

  const msgHost = el("div", "payment-msg");

  const addBtn = txt("button", "btn sm", "Record payment");
  addBtn.type = "button";
  addBtn.onclick = async () => {
    if (addBtn.disabled) return;
    const amount = safeNumber(amtInput.value);
    if (amount <= 0) {
      paymentFormMsg(msgHost, "Enter a payment amount greater than zero.", "err");
      amtInput.focus();
      return;
    }
    // Pro gate — a FRESH verified check (not cached isPro()) so a returning Pro
    // customer isn't wrongly paywalled by a not-yet-landed boot refresh. Mirrors
    // the logo-upload flow exactly.
    addBtn.disabled = true;
    const label = addBtn.textContent;
    addBtn.textContent = "Checking…";
    let pro = false;
    try { pro = await Billing.refreshProStatus(); }
    catch (e) { console.error("Local Invoice: refreshProStatus threw", e); pro = false; }
    // A verified refresh just ran — reconcile access. On a real revocation this
    // fires the access-stop notice + rebuilds the editor, so bail out of this
    // stale click rather than stacking the paywall on top of that notice.
    if (reconcileProAccess()) return;
    addBtn.disabled = false; addBtn.textContent = label;
    if (!pro) {
      // Remember the intent so a successful unlock/restore records this payment.
      const captured = { amount, date: dateInput.value, method: methodInput.value, note: noteInput.value, isDeposit: depCb.checked };
      setPendingProIntent(() => { if (Billing.isPro()) commitPayment(captured); });
      showProModal();
      return;
    }
    commitPayment({ amount, date: dateInput.value, method: methodInput.value, note: noteInput.value, isDeposit: depCb.checked });
  };
  form.appendChild(addBtn);
  form.appendChild(msgHost);
  panel.appendChild(form);

  return panel;
}
// Append a sanitized payment to the draft and rebuild the editor so the summary,
// list, live preview, and status all reflect it. Shared by the direct add path
// and the post-unlock resume intent.
function commitPayment(raw) {
  if (!Array.isArray(draft.payments)) draft.payments = [];
  const p = sanitizePayment(raw);
  if (!p || p.amount <= 0) return;
  draft.payments.push(p);
  buildEditor();
}
// Inline status line for the add-payment form (mirrors status() styling but
// scoped so it never collides with the editor-level save/export messages).
function paymentFormMsg(host, msg, kind) {
  host.innerHTML = "";
  const s = el("div", "payment-msg-line " + (kind === "err" ? "err" : "ok"));
  s.setAttribute("role", kind === "err" ? "alert" : "status");
  s.textContent = msg;
  host.appendChild(s);
}

// ── Repeat this invoice (recurring) ────────────────────────────────────────
// A per-invoice recurring toggle. There is NO background process — when
// enabled, the app checks at boot (see maybeShowRecurringPrompts) whether the
// invoice's next occurrence is due and, if so, shows a dismissible banner on
// the hub offering to generate the next one. Toggling on defaults the anchor to
// the invoice's own date (or today) so the first period counts from a sensible
// point. All writes go to draft.recurring; saving persists them like any field.
function buildRecurringPanel() {
  if (!draft.recurring || typeof draft.recurring !== "object") draft.recurring = { enabled: false, interval: "monthly", anchorDate: "", lastGenerated: "" };
  const panel = el("div", "panel");
  panel.appendChild(txt("h3", null, "Repeat this invoice"));

  const toggleRow = el("div", "recur-toggle-row");
  const cb = el("input"); cb.type = "checkbox"; cb.id = "recurEnabled"; cb.checked = draft.recurring.enabled === true;
  const cbLabel = txt("label", "recur-toggle-label", "Bill this client on a repeating schedule");
  cbLabel.setAttribute("for", "recurEnabled");
  cb.onchange = () => {
    draft.recurring.enabled = cb.checked;
    // Seed a sensible anchor the first time it's switched on.
    if (cb.checked && !draft.recurring.anchorDate) draft.recurring.anchorDate = draft.date || todayISO();
    buildEditor();
  };
  toggleRow.append(cb, cbLabel);
  panel.appendChild(toggleRow);

  if (draft.recurring.enabled) {
    const cfgRow = el("div", "field-row");
    // Interval
    const intField = el("div", "field");
    intField.appendChild(txt("span", "field-label", "Repeat every"));
    const intSelect = el("select"); intSelect.style.cssText = SELECT_CSS;
    intSelect.setAttribute("aria-label", "Repeat every");
    [["weekly", "Week"], ["monthly", "Month"]].forEach(([val, lbl]) => {
      const o = txt("option", null, lbl); o.value = val;
      if (val === draft.recurring.interval) o.selected = true;
      intSelect.appendChild(o);
    });
    intSelect.onchange = () => { draft.recurring.interval = RECUR_INTERVALS.includes(intSelect.value) ? intSelect.value : "monthly"; refreshRecurringHint(); };
    intField.appendChild(intSelect);
    // Anchor (first bill date)
    const anchorField = field("First bill date", draft.recurring.anchorDate || draft.date || todayISO(), (v) => { draft.recurring.anchorDate = v; refreshRecurringHint(); }, false, "date");
    cfgRow.append(intField, anchorField);
    panel.appendChild(cfgRow);

    const hint = txt("p", "field-hint recur-hint", recurringHintText(draft.recurring));
    panel.appendChild(hint);
    function refreshRecurringHint() { hint.textContent = recurringHintText(draft.recurring); }
  } else {
    panel.appendChild(txt("p", "field-hint", "When on, Local Invoice reminds you here to generate the next one — no emails, no background sending. You stay in control."));
  }
  return panel;
}
// Plain-language description of the next scheduled bill for the hint line.
function recurringHintText(recur) {
  const anchor = recur.anchorDate;
  if (!anchor) return "Pick a first bill date to start the schedule.";
  const next = nextOccurrenceISO(anchor, recur.interval, recur.lastGenerated);
  if (!next) return "Reminders will appear here when the next one is due.";
  const every = recur.interval === "weekly" ? "week" : "month";
  return `Repeats every ${every}. Next reminder on or after ${fmtDate(next)}.`;
}

// ── Logo (Pro) ──────────────────────────────────────────────────────────
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB — plenty for a logo, keeps localStorage/PDF size sane
function buildLogoField() {
  const wrap = el("div", "field logo-field");
  wrap.appendChild(txt("span", "field-label", "Logo (Pro)"));
  const row = el("div", "logo-row");
  if (validLogo(draft.from.logo)) {
    const img = el("img", "logo-thumb"); img.src = draft.from.logo; img.alt = "Business logo";
    row.appendChild(img);
    const remove = txt("button", "btn ghost sm", "Remove"); remove.type = "button";
    remove.onclick = () => { draft.from.logo = ""; state.business.logo = ""; buildEditor(); };
    row.appendChild(remove);
  } else {
    const upload = txt("button", "btn ghost sm", "Upload logo"); upload.type = "button";
    // A fresh check here (not the cached isPro()) so a returning Pro customer is never
    // wrongly shown the paywall just because the background boot-time refresh hadn't landed yet.
    // Item 8: disable + "Checking…" while the entitlement check runs; guard double-clicks.
    upload.onclick = async () => {
      if (upload.disabled) return;
      upload.disabled = true;
      const label = upload.textContent;
      upload.textContent = "Checking…";
      let pro = false;
      try { pro = await Billing.refreshProStatus(); }
      catch (e) { console.error("Local Invoice: refreshProStatus threw", e); pro = false; }
      // Verified refresh just ran — reconcile access. On a real revocation this
      // fires the one-time access-stop notice + re-locks gated UI (via
      // refreshAfterProChange, which rebuilds the editor), so we bail out of this
      // stale click rather than re-showing the paywall on top of the notice.
      if (reconcileProAccess()) return;
      upload.disabled = false; upload.textContent = label;
      if (pro) { pickLogoFile(); }
      else {
        // Item 5: remember the intent so a successful unlock/restore resumes it.
        setPendingProIntent(() => { if (Billing.isPro()) pickLogoFile(); });
        showProModal();
      }
    };
    row.appendChild(upload);
  }
  wrap.appendChild(row);
  return wrap;
}
// ── Payment instructions (Pro on the PDF; free to type + preview) ─────────
// A multiline "How to pay" free-text field on state.business. FREE users can
// enter and preview it (with a "Pro" tag) — it only renders into the EXPORTED
// PDF when Billing.isPro() (see doExport). Dual-writes draft + business so the
// next new invoice prefills the same instructions, mirroring the tax/currency
// fields above.
function buildPaymentDetailsField() {
  const wrap = el("div", "field");
  const labelRow = el("div", "field-label-row");
  labelRow.appendChild(txt("span", "field-label", "Payment details"));
  labelRow.appendChild(txt("span", "pro-tag", "Pro"));
  wrap.appendChild(labelRow);
  const area = el("textarea");
  area.setAttribute("aria-label", "Payment details");
  area.value = draft.paymentDetails || "";
  area.placeholder = "How clients pay you — bank details, PayPal.me link, Venmo handle…";
  // livePreviewUpdate() (used by the line-item inputs) rebuilds the preview column
  // in place — it's a module-level helper, so unlike the buildEditor-scoped
  // refresh() it's safely in scope from this standalone builder.
  area.oninput = () => { draft.paymentDetails = area.value; state.business.paymentDetails = area.value; livePreviewUpdate(); };
  wrap.appendChild(area);
  wrap.appendChild(txt("p", "field-hint", "Shown on your invoice PDF with Pro. You can type and preview it free."));
  return wrap;
}
function pickLogoFile() {
  const input = el("input"); input.type = "file"; input.accept = "image/png,image/jpeg";
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) { alert("That image is too large — please use one under 2MB."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      draft.from.logo = String(reader.result);
      state.business.logo = draft.from.logo;
      buildEditor();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

// ── Pro experience plumbing (intent resume, refresh, celebration, confetti) ──
// A remembered "what the user was about to do" when a gate opened the paywall.
// Runs once after a successful unlock OR restore, then clears itself.
let pendingProIntent = null;
function setPendingProIntent(fn) { pendingProIntent = typeof fn === "function" ? fn : null; }
function runPendingProIntent() {
  const fn = pendingProIntent;
  pendingProIntent = null;
  if (!fn) return;
  try { fn(); } catch (e) { console.error("Local Invoice: pending Pro action failed", e); }
}

// Called after ANY change to Pro status (unlock, restore, self-heal mint) so all
// gated UI reflects the new truth. Real implementation (not a no-op): refresh the
// footer license link + self-heal nag, and rebuild whichever view is on screen so
// gated controls (logo upload, payment block, upsell notes) re-render unlocked.
function refreshAfterProChange() {
  try { updateFooterProLinks(); } catch (e) { console.error(e); }
  try { updateSelfHealNag(); } catch (e) { console.error(e); }
  try { maybeShowLicenseNag(); } catch (e) { console.error(e); } // re-run post-check so a verified owner sees the save-card nag (isPro-gated)
  try { renderUnlockProCard(); } catch (e) { console.error(e); } // hide the sidebar upsell for new owners
  try {
    const editorOpen = $("#editor") && !$("#editor").classList.contains("hidden");
    if (editorOpen && typeof draft !== "undefined" && draft) buildEditor();
    else if (typeof renderHub === "function") renderHub();
  } catch (e) { console.error("Local Invoice: refreshAfterProChange render failed", e); }
}

// ── Refund request (customer-initiated, request-only) ──────────────────────
// Money movement is NEVER executed by the app — this only makes ASKING effortless.
// Builds a mailto: link that pre-fills a warm, short email to support with the
// person's restore code auto-inserted (or a clear "no code" note if null). A real
// person reviews and processes the refund back to the original payment method.
const REFUND_EXPECTATION = "30-day money-back guarantee. Email us and a real person reviews it — no forms, no runaround. Once approved, your refund goes back to your original payment method and takes about 5–10 business days to appear on your statement.";
function buildRefundMailto() {
  let code = null;
  try { code = Billing.getRestoreCode(); } catch (e) { console.error("Local Invoice: getRestoreCode threw", e); }
  const codeLine = code ? `My restore code: ${code}` : "My restore code: (no code on this device)";
  const subject = "Refund request — Local Invoice Pro";
  const body =
    "Hi,\n\n" +
    "I'd like to request a refund for Local Invoice Pro.\n\n" +
    codeLine + "\n" +
    "Reason (optional): \n\n" +
    "Thanks — I understand a real person will review this and reply.\n";
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
// A quiet, guilt-free "Need a refund?" block: one calm expectations line + a
// mailto link that opens the person's own mail client, pre-filled. Reused in the
// license-card modal and the footer Pro area. No retention trap, no "are you sure".
function buildRefundEntry() {
  const wrap = el("div", "refund-entry");
  const link = el("a", "restore-link refund-link");
  link.href = buildRefundMailto();
  link.textContent = "Need a refund?";
  wrap.appendChild(link);
  wrap.appendChild(txt("p", "refund-note", REFUND_EXPECTATION));
  return wrap;
}

// ── Graceful, non-destructive access-stop (Pro revoked / refunded) ─────────
// Billing.refreshProStatus() fails OPEN for known owners offline, and returns a
// genuine false only after a VERIFIED server check said "not active". So a flip
// from was_pro="1" to isPro()===false is a real revocation (refund/expiry), never
// a mere network blip. On that transition we kindly re-gate — WITHOUT ever
// touching the user's data: every invoice, client, logo, and setting stays put;
// only Pro OUTPUT (logo/payment block on new exports) stops applying, exactly as
// for a never-Pro user. Call after EVERY verified refresh (boot + gate checks).
function wasPro() {
  try { return localStorage.getItem(WAS_PRO_KEY) === "1"; } catch { return false; }
}
function setWasPro(on) {
  try { localStorage.setItem(WAS_PRO_KEY, on ? "1" : "0"); } catch { /* private-browsing — harmless; re-derives next verified refresh */ }
}
function resetCelebratedForRebuy() {
  // So a future re-purchase celebrates fresh. (markCelebrated re-sets it then.)
  try { localStorage.setItem(CELEBRATED_KEY, "0"); } catch { /* private-browsing — harmless */ }
}
// Reconcile our was_pro flag against the CURRENT verified Pro status. Only ever
// called right after a real refreshProStatus() so isPro() reflects a server
// answer (or the fail-open owner path). Returns true iff it handled a revocation.
function reconcileProAccess() {
  let isPro = false;
  try { isPro = !!Billing.isPro(); } catch (e) { console.error("Local Invoice: isPro threw", e); return false; }
  if (isPro) {
    // Verified owner — remember it so a later refund can be detected.
    if (!wasPro()) setWasPro(true);
    return false;
  }
  // isPro() is false. Only a PRIOR verified owner flipping to false is a real
  // revocation; a never-Pro browser (was_pro unset) is just... not Pro.
  if (!wasPro()) return false;
  handleAccessStop();
  return true;
}
// The one-time, calm, non-destructive access-stop transition.
function handleAccessStop() {
  setWasPro(false);           // (2) so the notice never repeats
  resetCelebratedForRebuy();  // (3) a future re-buy celebrates fresh
  showAccessStopNotice();     // (1) one-time, dismissible, no guilt
  try { refreshAfterProChange(); } catch (e) { console.error("Local Invoice: access-stop refresh failed", e); } // (4) re-lock gated UI, hide license link + self-heal nag
}
// A single dismissible banner in the app's slim banner slot (parity with the
// license/self-heal nags). Warm, non-destructive, no hard re-sell. Guarded so it
// can never stack even if two verified refreshes race.
function showAccessStopNotice() {
  if ($("#accessStopNotice")) return;
  const bar = el("div", "license-nag accessstop-nag"); bar.id = "accessStopNotice";
  bar.setAttribute("role", "status");
  // The "why" + escape hatch live IN the banner: a verified revocation is in practice a
  // refund, and someone who didn't ask for one needs the support path right here.
  bar.appendChild(txt("span", null, "Your Local Invoice Pro access has ended — this usually follows a refund. If it's unexpected, email " + SUPPORT_EMAIL + " and we'll sort it out. Everything you made is safe and still here, and every free feature keeps working — you're always welcome back."));
  const close = txt("button", "license-nag-x", "×"); close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => bar.remove();
  bar.appendChild(close);
  document.body.insertBefore(bar, document.body.firstChild);
}

// Honest, calm status tone helper — status() only styles "err" (red) vs. anything
// else (green/ok). For neutral/offline/amber copy we add a class + role so the
// message reads right (grey info, amber warn) and never as a red error.
function proStatus(host, msg, tone) {
  if (!host) return;
  status(host, msg, tone === "err" ? "err" : "ok");
  const s = host.querySelector(".status");
  if (!s) return;
  s.classList.remove("info", "warn");
  if (tone === "info") { s.classList.add("info"); s.setAttribute("role", "status"); }
  else if (tone === "warn") { s.classList.add("warn"); s.setAttribute("role", "status"); }
}

// Polished, on-brand error STATE for a GENUINE purchase failure (not cancelled,
// not offline). Replaces the old plain-text status line. Pure DOM + inline SVG,
// no remote assets. Keeps the substance of the proven reassurance copy. The
// "Try again" button re-runs the SAME purchase flow via the onRetry callback
// (which re-invokes Billing.purchasePro() — billing is NOT reimplemented here).
function renderPurchaseError(host, onRetry) {
  if (!host) return;
  host.innerHTML = "";
  const box = el("div", "pro-error");
  // Assertive live region so AT announces the failure (mirrors status(...,"err")).
  box.setAttribute("role", "alert");
  box.setAttribute("aria-live", "assertive");
  box.setAttribute("aria-atomic", "true");

  // Tasteful danger mark: soft circle + X, uses --danger, gentle glow. Decorative.
  const mark = el("div", "pro-error-mark", '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" aria-hidden="true" focusable="false"><circle cx="24" cy="24" r="21" fill="var(--danger-soft-bg)"/><circle cx="24" cy="24" r="21" stroke="var(--danger)" stroke-width="2" stroke-opacity="0.35"/><path d="M18 18 L30 30 M30 18 L18 30" stroke="var(--danger)" stroke-width="3" stroke-linecap="round"/></svg>');
  mark.setAttribute("aria-hidden", "true");
  box.appendChild(mark);

  box.appendChild(txt("h4", "pro-error-title", "Something went wrong"));
  box.appendChild(txt("p", "pro-error-body",
    // "no charge was made just now" scopes the claim to THIS attempt — a person investigating
    // an earlier charge must never read it as "you were never charged".
    "If your card was charged, your Pro will unlock automatically on your next visit — otherwise no charge was made just now."));
  box.appendChild(txt("p", "pro-error-secure", IS_NATIVE ? "Your App Store receipt is the record of what was charged, if anything." : "Your Stripe receipt is the record of what was charged, if anything."));

  // Support line with a mailto: (allowed) — email also renders as plain text.
  const support = el("p", "pro-error-support");
  support.appendChild(document.createTextNode("Still stuck? Email "));
  const mail = txt("a", "pro-error-mail", SUPPORT_EMAIL);
  mail.href = "mailto:" + SUPPORT_EMAIL;
  support.appendChild(mail);
  support.appendChild(document.createTextNode(IS_NATIVE ? " with your App Store receipt and we'll sort it out." : " with your Stripe receipt and we'll sort it out."));
  box.appendChild(support);

  const retry = txt("button", "btn big pro-error-retry", "Try again");
  retry.type = "button";
  retry.onclick = () => { if (typeof onRetry === "function") onRetry(); };
  box.appendChild(retry);

  host.appendChild(box);
  // Move focus to the retry control so keyboard/AT users land on the recovery action.
  try { retry.focus(); } catch { /* focus best-effort */ }
}

// One-time ownership flag — set the moment the celebration fires, so it never
// shows again (not on later visits, not on restores).
function hasCelebrated() {
  try { return localStorage.getItem(CELEBRATED_KEY) === "1"; } catch { return false; }
}
function markCelebrated() {
  try { localStorage.setItem(CELEBRATED_KEY, "1"); } catch { /* private-browsing — may re-fire, harmless */ }
}

// Tasteful, brief confetti — pure DOM/CSS, no libs (strict CSP). Reduced motion is
// handled in CSS (.confetti-layer is display:none under prefers-reduced-motion), and
// we double-guard here so we don't even build nodes when motion is unwanted.
function launchConfetti() {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const layer = el("div", "confetti-layer");
    layer.setAttribute("aria-hidden", "true");
    const colors = ["#4338ca", "#818cf8", "#34d399", "#fbbf24", "#f472b6", "#22d3ee"];
    const N = 70;
    for (let i = 0; i < N; i++) {
      const p = el("div", "confetti-piece");
      const dur = 2.2 + Math.random() * 1.6;
      const delay = Math.random() * 0.5;
      const spin = 360 + Math.random() * 540;
      p.style.left = (Math.random() * 100) + "vw";
      p.style.background = colors[i % colors.length];
      p.style.setProperty("--dur", dur.toFixed(2) + "s");
      p.style.setProperty("--delay", delay.toFixed(2) + "s");
      p.style.setProperty("--spin", spin.toFixed(0) + "deg");
      if (i % 3 === 0) p.style.borderRadius = "50%";
      layer.appendChild(p);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 4600);
  } catch (e) { console.error("Local Invoice: confetti failed", e); }
}

// A brief bottom toast + a screen-reader announcement. Reuses the vault-toast
// styling. The polite live-region node is created once and reused so AT reliably
// re-announces each message.
function proToast(msg) {
  try {
    const t = el("div", "vault-toast"); t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  } catch (e) { console.error("Local Invoice: toast failed", e); }
}

// Called when the charge SUCCEEDED but the entitlement is still attaching (billing
// returned { pending:true }). The customer HAS paid — so this must never read as a
// failure. Reassure, give them their restore code now, and quietly promote to a full
// unlock the moment the entitlement lands (no manual reload needed).
function handlePurchasePending(restoreCode, message) {
  const msg = message || "Your payment went through — your Pro is unlocking now. If it doesn't appear in a moment, reload this page.";
  proToast(msg);
  if (restoreCode) showRestoreCodeModal(restoreCode); // they paid; hand over their key straight away
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    let pro = false;
    try { pro = await Billing.refreshProStatus(); } catch (e) { pro = false; }
    if (pro || tries >= 4) {
      clearInterval(timer);
      if (pro) {
        try { if (!wasPro()) setWasPro(true); } catch (e) {}
        refreshAfterProChange();
      }
    }
  }, 2500);
}

// Restore-code input auto-format (item 9): uppercase, strip anything outside the
// code alphabet, and regroup as PREFIX-XXXX-XXXX-XXXX to match how billing
// normalizes it. Billing does the authoritative normalize on its side; this just
// keeps the field looking right as the user types or pastes.
const RESTORE_PREFIX = "LINV";
function formatRestoreCode(raw) {
  const val = String(raw || "");
  // Leave a raw account id ($RCAnonymousID:… or a legacy custom id — the Fix C
  // fallback restore code) untouched; those are case-sensitive, and their marker
  // chars never appear in a real minted code.
  if (/[_$]/.test(val)) return val.trim();
  let s = val.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return ""; // empty stays empty — don't auto-inject the prefix into a cleared field
  // A valid code body can NEVER contain "LINV" (the I isn't in the code alphabet), so any
  // "LINV" is a prefix marker — take everything after the LAST one. Strips a doubled
  // "LINV-LINV-…" AND a leading label like "Code: LINV-…" that survived char-stripping.
  const pi = s.lastIndexOf(RESTORE_PREFIX);
  if (pi >= 0) s = s.slice(pi + RESTORE_PREFIX.length);
  // Body chars come only from billing's unambiguous CODE_ALPHABET (no 0/O/1/I/L).
  const body = s.replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g, "").slice(0, 12);
  const groups = body.match(/.{1,4}/g) || [];
  return groups.length ? RESTORE_PREFIX + "-" + groups.join("-") : "";
}
// Live handler: ONLY uppercase in place (non-destructive, caret kept), and
// normalize once at submit. A live regrouper that injects the prefix creates a
// feedback loop that absorbs a hand-typed L-I-N-V into the code body
// ("LINV-LINV-…", truncating the real tail) — the exact owner-lockout Local PDF
// already hit and fixed; this mirrors its proven normalize-at-submit pattern.
function wireRestoreInputFormatting(input) {
  input.addEventListener("input", () => {
    const val = input.value;
    if (/[_$]/.test(val)) return; // case-sensitive raw ids stay exactly as pasted
    const up = val.toUpperCase();
    if (up !== val) {
      const pos = input.selectionStart;
      input.value = up;
      try { input.setSelectionRange(pos, pos); } catch {}
    }
  });
}

// Accessible-dialog wiring for the paywall (item 7): role/aria-modal, move focus
// into the modal, trap Tab within it, and let Escape close it. Returns a cleanup
// function. `onEscape` runs the modal's own close path so state stays consistent.
function makeDialog(backdrop, modal, onEscape) {
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const prevFocus = document.activeElement;
  const focusables = () => Array.from(modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter((n) => !n.disabled && n.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onEscape(); return; }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  backdrop.addEventListener("keydown", onKey);
  // Move focus in after the node is in the DOM.
  setTimeout(() => { const f = focusables(); if (f.length) f[0].focus(); }, 0);
  return function cleanup() {
    backdrop.removeEventListener("keydown", onKey);
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch {}
  };
}

// The warm one-time ownership moment. Built once per lifetime (CELEBRATED_KEY);
// appended to the top of the given modal. Headline + thank-you + "what you
// unlocked" list + brief confetti (reduced-motion-aware). Returns nothing.
function appendCelebration(modal) {
  const head = el("div", "celebrate-head");
  head.appendChild(txt("div", "celebrate-emoji", "🎉"));
  head.appendChild(txt("div", "celebrate-title", "It's yours — forever."));
  head.appendChild(txt("p", "celebrate-thanks", IS_NATIVE
    ? "Thank you for supporting Local Invoice. Pro is unlocked on this device — here's what you just turned on:"
    : "Thank you for supporting Local Invoice. Pro is unlocked on this browser — here's what you just turned on:"));
  modal.appendChild(head);
  const ul = el("ul", "celebrate-unlocked");
  [
    "Your custom logo & branding on every invoice and estimate PDF",
    "A “how to pay” block (bank / PayPal / Venmo) on every PDF",
    "Payments & deposits — record partial payments and see the exact balance due on every invoice",
  ].forEach((t) => ul.appendChild(txt("li", null, t)));
  modal.appendChild(ul);
  launchConfetti();
}

// After a successful purchase WITH a code. If this is the first-ever unlock,
// prepend the celebration moment; either way, show the save-your-code / license
// card section (existing machinery, reused verbatim below).
function showRestoreCodeModal(code) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");
  const firstTime = !hasCelebrated();
  if (firstTime) { appendCelebration(modal); markCelebrated(); }
  modal.appendChild(txt("h3", null, firstTime ? "Save your restore code" : "You're Pro — save your restore code"));
  modal.appendChild(txt("p", "hint", "Save this code and it'll unlock Pro again on any other device or browser — since Local Invoice has no accounts, it's your key to Pro."));
  modal.appendChild(txt("p", "hint", "Keep your receipt email too — it's your proof of purchase. Questions? " + SUPPORT_EMAIL + "."));
  const codeBox = el("div", "restore-code-box");
  const codeText = txt("code", "restore-code-value", code || "—");
  codeBox.appendChild(codeText);
  const copyBtn = txt("button", "btn ghost sm", "Copy"); copyBtn.type = "button";
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; }
    catch { copyBtn.textContent = "Couldn't copy — select and copy manually"; }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  };
  codeBox.appendChild(copyBtn);
  modal.appendChild(codeBox);
  const canvas = licenseCardCanvas(code);
  if (canvas) modal.appendChild(canvas);
  const dlBtn = txt("button", "btn ghost", "Download card (PNG)"); dlBtn.type = "button";
  dlBtn.onclick = () => { if (canvas) downloadCanvasPng(canvas); };
  if (!canvas) dlBtn.disabled = true;
  const doneBtn = txt("button", "btn big", "I've saved it"); doneBtn.type = "button";
  doneBtn.onclick = () => { markCodeAck(); backdrop.remove(); refreshAfterProChange(); runPendingProIntent(); };
  const actions = el("div", "pro-actions"); actions.append(dlBtn, doneBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  updateFooterProLinks(); // a code exists now — surface the permanent footer entry
}

// Purchase succeeded but the restore code couldn't be minted yet ({ok:true,
// restoreCode:null}). Celebrate anyway, then — in place of the code box — offer
// an amber, honest "create your code" action wired to Billing.mintRestoreCode().
function showPaidNoCodeModal() {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");
  const firstTime = !hasCelebrated();
  if (firstTime) { appendCelebration(modal); markCelebrated(); }
  if (IS_NATIVE) {
    // Apple IAP has no restore CODE to mint — cross-device restore is handled by the
    // Apple ID + "Restore Purchases", so skip the mint section entirely.
    modal.appendChild(txt("h3", null, "You're Pro"));
    modal.appendChild(txt("p", "hint", "Pro is unlocked on this device — and it restores free on your other Apple devices. Just tap “Restore Purchases” there, signed in with the same Apple Account."));
    const doneBtn = txt("button", "btn big", "Done"); doneBtn.type = "button";
    doneBtn.onclick = () => { backdrop.remove(); refreshAfterProChange(); runPendingProIntent(); };
    const actions = el("div", "pro-actions"); actions.append(doneBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    return;
  }
  modal.appendChild(txt("h3", null, "You're Pro on this browser"));
  const note = el("div", "mint-note");
  note.appendChild(txt("p", null, "One thing — we couldn't create your restore code just now. Pro already works on this browser. Tap to create your code for other devices."));
  const msgHost = el("div", "pro-msg");
  const mintBtn = txt("button", "btn big", "Create my restore code"); mintBtn.type = "button";
  mintBtn.onclick = async () => {
    mintBtn.disabled = true; mintBtn.textContent = "Creating…";
    let res;
    try { res = await Billing.mintRestoreCode(); }
    catch (e) { console.error("Local Invoice: mintRestoreCode threw", e); res = { ok: false }; }
    if (res && res.ok && res.restoreCode) {
      backdrop.remove();
      showRestoreCodeModal(res.restoreCode); // normal save-code modal
    } else {
      mintBtn.disabled = false; mintBtn.textContent = "Try again";
      proStatus(msgHost, "No luck yet — Pro still works here; we'll offer again next visit, and " + SUPPORT_EMAIL + " + your receipt always work.", "warn");
    }
  };
  note.appendChild(mintBtn);
  modal.appendChild(note);
  const laterBtn = txt("button", "btn ghost", "Maybe later"); laterBtn.type = "button";
  laterBtn.onclick = () => { backdrop.remove(); refreshAfterProChange(); runPendingProIntent(); };
  const actions = el("div", "pro-actions"); actions.append(laterBtn);
  modal.append(actions, msgHost);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

// ── Pro license card (loss-proofing the restore code) ──────────────────
function markCodeAck() {
  try { localStorage.setItem(CODE_ACK_KEY, "1"); }
  catch { /* private-browsing lockout — the nag simply reappears next load */ }
  const nag = $("#licenseNag");
  if (nag) nag.remove();
}
function downloadCanvasPng(canvas) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = el("a"); a.href = url; a.download = "local-invoice-pro-license.png";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
}
// Renders via Billing.renderLicenseCard, and never lets a drawing hiccup take
// down the modal that hosts it — callers fall back to the plain code text.
function licenseCardCanvas(code) {
  try {
    const canvas = Billing.renderLicenseCard(code, "Local Invoice");
    canvas.className = "license-card-canvas";
    return canvas;
  } catch (e) {
    console.error("Local Invoice: license card render failed", e);
    return null;
  }
}
function showLicenseCardModal() {
  const code = Billing.getRestoreCode();
  if (!code) return;
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");
  modal.appendChild(txt("h3", null, "Your Pro license card"));
  modal.appendChild(txt("p", "hint", "Download it, print it, or keep it with your records — it's the only way to unlock Pro again on another device."));
  const canvas = licenseCardCanvas(code);
  if (canvas) {
    modal.appendChild(canvas);
  } else {
    // Drawing failed — the raw code is still the thing that matters.
    const codeBox = el("div", "restore-code-box");
    codeBox.appendChild(txt("code", "restore-code-value", code));
    modal.appendChild(codeBox);
  }
  const dlBtn = txt("button", "btn ghost", "Download card (PNG)"); dlBtn.type = "button";
  dlBtn.onclick = () => { if (canvas) downloadCanvasPng(canvas); };
  if (!canvas) dlBtn.disabled = true;
  const copyBtn = txt("button", "btn ghost", "Copy code"); copyBtn.type = "button";
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; }
    catch { copyBtn.textContent = "Couldn't copy"; }
    setTimeout(() => { copyBtn.textContent = "Copy code"; }, 2000);
  };
  const savedBtn = txt("button", "btn big", "I've saved it"); savedBtn.type = "button";
  savedBtn.onclick = () => { markCodeAck(); backdrop.remove(); };
  const secondary = el("div", "pro-actions"); secondary.append(dlBtn, copyBtn);
  const primary = el("div", "pro-actions"); primary.append(savedBtn);
  modal.append(secondary, primary);
  // Quiet, guilt-free refund path (owners only reach this modal, since it needs a
  // restore code). Request-only — opens their mail client pre-filled; a human reviews.
  modal.appendChild(buildRefundEntry());
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}
// Footer "View your Pro license card" — only meaningful once a code exists.
// Also maintains the quiet owner-only "Need a refund?" entry in the footer:
// created lazily (kept out of the frozen index.html markup) and shown only to Pro
// owners, with its mailto refreshed to carry the current restore code. Request-only.
function updateFooterProLinks() {
  const link = $("#footerLicenseLink");
  // Gate on BOTH a stored code AND a verified Pro status: a refunded/expired/hollow-code
  // browser still has a stale code in localStorage, and offering "your key back into Pro"
  // for a dead code reads as broken. Re-evaluated on every Pro-status change (this runs from
  // refreshAfterProChange, which the boot check + access-stop paths both call).
  let isPro = false;
  try { isPro = !!Billing.isPro(); } catch (e) { console.error("Local Invoice: isPro threw", e); isPro = false; }
  if (link) link.classList.toggle("hidden", !(Billing.getRestoreCode() && isPro));
  updateFooterRefundEntry();
}
function updateFooterRefundEntry() {
  if (IS_NATIVE) return; // Apple owns refunds for IAP (Report a Problem) — don't offer a self-run money-back entry
  let isPro = false;
  try { isPro = !!Billing.isPro(); } catch (e) { console.error("Local Invoice: isPro threw", e); }
  let node = $("#footerRefund");
  if (!isPro) { if (node) node.remove(); return; }
  // Owner — ensure the entry exists (built once, appended after the license link
  // inside the footer) and its mailto reflects the current restore code.
  if (!node) {
    const link = $("#footerLicenseLink");
    const footer = (link && link.parentNode) || document.querySelector("footer");
    if (!footer) return;
    node = buildRefundEntry();
    node.id = "footerRefund";
    node.classList.add("footer-refund");
    if (link && link.nextSibling) footer.insertBefore(node, link.nextSibling);
    else footer.appendChild(node);
  } else {
    const rlink = node.querySelector(".refund-link");
    if (rlink) rlink.href = buildRefundMailto();
  }
}
// Boot-time nag: a restore code exists but the user never confirmed saving it.
// The × dismisses for this page load only; "I've saved it" in the card modal
// is what silences it permanently (markCodeAck).
function maybeShowLicenseNag() {
  if (IS_NATIVE) return; // iOS has no restore CODE / license card — Apple restore covers it
  if (!Billing.getRestoreCode()) return;
  // Only nag to save the license card when this browser is ACTUALLY Pro — a stored
  // code alone isn't enough (a refunded/expired/hollow code leaves a stale code in
  // localStorage, and "Keep Pro safe" next to the Unlock-Pro paywall reads as broken).
  // isPro() is the last verified check; re-run from refreshAfterProChange() so a real
  // owner still sees it after the boot check (offline owners fail OPEN and keep it).
  let isPro = false; try { isPro = !!Billing.isPro(); } catch (e) { isPro = false; }
  // Mirror updateSelfHealNag's self-removal: the boot pro_seen seed can paint this nag
  // before the server check lands, and when that check says not-Pro (a refund) the
  // refresh re-runs us — a bare early-return would leave a stale "Keep Pro safe" bar
  // sitting beside the access-ended notice for the rest of the page load.
  if (!isPro) { const stale = $("#licenseNag"); if (stale) stale.remove(); return; }
  let ack = null;
  try { ack = localStorage.getItem(CODE_ACK_KEY); } catch { /* treat as un-acked */ }
  if (ack === "1" || $("#licenseNag")) return;
  const bar = el("div", "license-nag"); bar.id = "licenseNag";
  bar.appendChild(txt("span", null, "Keep Pro safe — save your license card so you can restore it anytime."));
  const view = txt("button", "license-nag-view", "View card"); view.type = "button";
  view.onclick = () => showLicenseCardModal();
  const close = txt("button", "license-nag-x", "×"); close.type = "button";
  close.setAttribute("aria-label", "Dismiss for now");
  close.onclick = () => bar.remove();
  bar.append(view, close);
  document.body.insertBefore(bar, document.body.firstChild);
}

// Self-heal nag (item 6): Pro is active on THIS browser but there's no restore
// code (mint failed, or an old install). Offer to create one so other devices can
// unlock too. Reuses the slim banner slot; removed automatically once a code exists.
function updateSelfHealNag() {
  if (IS_NATIVE) return; // iOS mints no restore code — cross-device restore is via the Apple ID
  let isPro = false, hasCode = true;
  try { isPro = !!Billing.isPro(); } catch (e) { console.error(e); }
  try { hasCode = !!Billing.getRestoreCode(); } catch (e) { console.error(e); }
  const existing = $("#selfHealNag");
  if (!isPro || hasCode) { if (existing) existing.remove(); return; }
  if (existing) return; // already showing
  const bar = el("div", "license-nag selfheal-nag"); bar.id = "selfHealNag";
  bar.appendChild(txt("span", null, "You're Pro on this browser — create your restore code so you can unlock other devices too."));
  const btn = txt("button", "selfheal-nag-view", "Create code"); btn.type = "button";
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "Creating…";
    let res;
    try { res = await Billing.mintRestoreCode(); }
    catch (e) { console.error("Local Invoice: mintRestoreCode threw", e); res = { ok: false }; }
    if (res && res.ok && res.restoreCode) {
      bar.remove();
      updateFooterProLinks();
      showRestoreCodeModal(res.restoreCode); // opens the save-code modal
    } else {
      btn.disabled = false; btn.textContent = "Try again";
    }
  };
  bar.appendChild(btn);
  document.body.insertBefore(bar, document.body.firstChild);
}

// ── Apple-localized price labels (iOS only) ────────────────────────────────
// Apple charges the App Store's localized storefront price, which on non-US
// storefronts differs from the hardcoded "$12.99" (currency AND amount). Fetch
// Apple's real priceString once per session (Billing caps it at 2.5s and never
// throws) and swap it into the visible price labels when it arrives — the
// hardcoded string stays as the instant placeholder/fallback so nothing ever
// waits on the network, and Apple's own payment sheet remains the final word
// on the charge. On the web this is a no-op; web genuinely charges USD $12.99.
let nativePriceString = null;
let nativePriceFetch = null;
function applyNativePrice(apply) {
  // Function-guard: an older billing.js bundle without the helper simply keeps the placeholder.
  if (!IS_NATIVE || !window.Billing || typeof Billing.getNativeLocalizedPrice !== "function") return;
  if (nativePriceString) { try { apply(nativePriceString); } catch (e) { console.error(e); } return; }
  if (!nativePriceFetch) nativePriceFetch = Billing.getNativeLocalizedPrice().catch(() => null);
  nativePriceFetch.then((p) => {
    if (!p || typeof p !== "string") return;
    nativePriceString = p;
    try { apply(p); } catch (e) { console.error("Local Invoice: price label update failed", e); }
  });
}

// ── Sidebar "Unlock Pro" front door ────────────────────────────────────────
// A quiet, honest entry point to the EXISTING $12.99 one-time offer, mounted in
// the sidebar footer above the "Private by design" card. It only OPENS showProModal()
// (the real paywall) — no billing/price logic lives here. Owners never see it:
// re-rendered on every Pro-status change (via refreshAfterProChange) and at boot,
// it removes itself whenever Billing.isPro() is true. isPro() throwing is treated
// as not-Pro (fail-open to showing the card) so the door is never wrongly hidden.
function renderUnlockProCard() {
  let isPro = false;
  try { isPro = !!Billing.isPro(); } catch (e) { console.error("Local Invoice: isPro threw", e); isPro = false; }
  // Mobile-only header "Unlock Pro" button mirrors this card's owner-gating: shown
  // only to non-owners (CSS reveals it just on the off-canvas breakpoint) and hidden
  // the moment Pro is owned. Kept in sync here so it updates on every Pro change.
  const topBtn = $("#unlockProTopbar");
  if (topBtn) topBtn.classList.toggle("pro-owned", isPro);
  const slot = $("#unlockProSlot");
  if (!slot) return;
  // Owner state: never show a sale/upsell surface to someone who already owns Pro.
  if (isPro) { slot.textContent = ""; return; }
  if (slot.firstChild) return; // already rendered for a non-owner — leave it be

  const card = el("button", "unlock-pro-card");
  card.type = "button";
  card.setAttribute("aria-label", "Unlock Local Invoice Pro — $12.99 one-time");

  const head = el("div", "unlock-pro-head");
  // Crown glyph, tinted with the shared amber ramp (light + dark tokens).
  const crown = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  crown.setAttribute("viewBox", "0 0 24 24");
  crown.setAttribute("aria-hidden", "true");
  crown.setAttribute("fill", "currentColor");
  const crownPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  crownPath.setAttribute("d", "M3 7l4.5 3.5L12 4l4.5 6.5L21 7l-1.8 11H4.8L3 7zm2 13h14v1.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5V20z");
  crown.appendChild(crownPath);
  head.appendChild(crown);
  head.appendChild(txt("b", null, "Unlock Pro"));
  card.appendChild(head);

  card.appendChild(txt("p", "unlock-pro-benefit", "Your logo & a “how to pay” block on every invoice PDF"));
  const priceLine = txt("span", "unlock-pro-price", "$12.99 · one-time");
  card.appendChild(priceLine);
  // Prominent call-to-action beneath the price. The whole card is the button;
  // this is a styled span (not a nested <button>) that reads as the CTA. Copy
  // stays honest to the one-time offer — "Unlock Pro", never "Upgrade"/recurring.
  card.appendChild(txt("span", "unlock-pro-cta", "Unlock Pro"));

  card.addEventListener("click", () => { try { showProModal(); } catch (e) { console.error("Local Invoice: showProModal threw", e); } });

  // iOS: swap the USD placeholder for Apple's localized price — on the card, its
  // aria-label, and the mobile topbar button's label (its price is aria-only).
  applyNativePrice((p) => {
    priceLine.textContent = p + " · one-time";
    card.setAttribute("aria-label", "Unlock Local Invoice Pro — " + p + " one-time");
    const tb = $("#unlockProTopbar");
    if (tb) tb.setAttribute("aria-label", "Unlock Local Invoice Pro — " + p + " one-time");
  });

  slot.appendChild(card);
}

function showRestoreEntryModal() {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  let cleanup = () => {};
  const close = () => { cleanup(); backdrop.remove(); };
  modal.appendChild(txt("h3", null, "Restore Pro"));
  modal.appendChild(txt("p", "hint", "Enter the restore code you saved when you unlocked Pro."));
  const input = el("input");
  input.type = "text"; input.placeholder = "LINV-XXXX-XXXX-XXXX"; input.className = "restore-code-input";
  input.setAttribute("aria-label", "Restore code");
  input.autocapitalize = "characters"; input.spellcheck = false; input.autocomplete = "off";
  wireRestoreInputFormatting(input);
  modal.appendChild(input);
  const msgHost = el("div", "pro-msg");
  const goBtn = txt("button", "btn big", "Restore"); goBtn.type = "button";
  goBtn.onclick = async () => {
    goBtn.disabled = true; goBtn.textContent = "Checking…";
    let res;
    try { res = await Billing.restoreWithCode(formatRestoreCode(input.value)); }
    catch (e) { console.error("Local Invoice: restoreWithCode threw", e); res = { ok: false, error: "Couldn't check that code — try again." }; }
    if (res && res.ok) {
      close();
      updateFooterProLinks(); // the entered code is now stored — surface the license-card link
      updateSelfHealNag();
      proToast("Welcome back — Pro is unlocked on this device.");
      refreshAfterProChange();
      runPendingProIntent(); // resume whatever gate sent them here (item 5)
    } else if (res && res.offline) {
      goBtn.disabled = false; goBtn.textContent = "Restore";
      proStatus(msgHost, "You're offline — restoring Pro needs a connection to check your code. Everything else works offline.", "info");
    } else {
      goBtn.disabled = false; goBtn.textContent = "Restore";
      status(msgHost, (res && res.error) || "Couldn't restore — try again.", "err");
    }
  };
  const closeBtn = txt("button", "btn ghost", "Cancel"); closeBtn.type = "button";
  closeBtn.onclick = close;
  const actions = el("div", "pro-actions"); actions.append(goBtn, closeBtn);
  modal.append(actions, msgHost);
  // Lost-code fallback: the answer exists on support.html, but the person stuck at
  // this input needs it right here — one muted line, no new machinery.
  modal.appendChild(txt("p", "hint", "Lost your code? Email " + SUPPORT_EMAIL + " and we'll help."));
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  cleanup = makeDialog(backdrop, modal, close); // role/aria-modal, focus-in, Tab-trap, Esc, focus restore
}

// True when localStorage genuinely persists (a hard private-browsing window can block it
// entirely). Probed at paywall-open so a buyer in such a browser gets one clear heads-up —
// their restore code would be the ONLY key, since nothing can be remembered here.
function storageProbeOk() {
  try {
    const k = "localinvoice.storage_probe";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

function showProModal() {
  // Guard against two paywall backdrops stacking (double-click on a gated button
  // while the entitlement check is in flight, or two gates firing at once).
  if (document.querySelector(".modal-backdrop.pro-paywall")) return;
  const backdrop = el("div", "modal-backdrop pro-paywall");
  const modal = el("div", "modal pro-modal");
  const titleId = "proModalTitle";
  const title = txt("h3", null, "Local Invoice Pro"); title.id = titleId;
  modal.appendChild(title);
  modal.setAttribute("aria-labelledby", titleId);
  const price = el("div", "pro-price");
  const priceAmt = txt("span", "pro-price-amt", "$12.99"); // display only — actual charge owned by RevenueCat (billing.src.js)
  price.appendChild(priceAmt);
  price.appendChild(txt("span", "pro-price-note", " one-time"));
  modal.appendChild(price);
  // iOS: swap the USD placeholder for Apple's localized storefront price when it
  // arrives, so this number always matches the one on Apple's payment sheet.
  applyNativePrice((p) => { priceAmt.textContent = p; });
  const list = el("ul", "pro-features");
  // Outcome-framed bullets (item 10).
  [
    "Your logo & branding on every invoice and estimate",
    "Get paid faster — bank, PayPal & Venmo details right on every PDF",
    "Record payments & deposits — log partial payments and always see the exact balance due on every invoice.",
  ].forEach((f) => list.appendChild(txt("li", null, f)));
  modal.appendChild(list);
  // Durable one-time reassurance line (item 10).
  modal.appendChild(txt("p", "hint pro-reassure", "One-time unlock — it applies to every invoice and estimate you make from now on. No subscription, ever."));
  if (IS_NATIVE) {
    // Apple IAP: no Stripe, no email receipt, no "your statement" (Apple bills), no
    // self-run money-back (refunds go through Apple's Report a Problem).
    modal.appendChild(txt("p", "hint pro-reassure", "Payment is handled securely by the App Store, with the Apple Account you already use — it restores free on your other Apple devices."));
  } else {
    // "(via RevenueCat)" because the checkout page's own header says "Secure checkout by
    // RevenueCat" — naming both here keeps that header from reading as a third stranger.
    modal.appendChild(txt("p", "hint pro-reassure", "Secure checkout by Stripe (via RevenueCat). You'll enter an email for your receipt only — it's not an account, and we never see your card."));
    {
      const stmtNote = document.createElement("p");
      stmtNote.style.cssText = "margin:12px 0 0; font-size:13.5px; font-weight:500;";
      stmtNote.innerHTML = 'Shows on your statement as <strong>“Eden Apps”</strong>';
      modal.appendChild(stmtNote);
    }
    modal.appendChild(txt("p", "hint pro-reassure", "30-day money-back guarantee — email " + SUPPORT_EMAIL + "."));
    // Cross-store honesty, said BEFORE paying: this web unlock and the App Store app's
    // Pro are separate purchases — an iPhone-intending buyer should know that here.
    modal.appendChild(txt("p", "hint pro-reassure", "The iPhone and iPad app sells Pro separately through the App Store."));
    // Private-browsing safety (web only): when this browser can't save anything, Pro can't be
    // remembered here after purchase — one calm heads-up so the buyer keeps their keys safe.
    if (!storageProbeOk()) modal.appendChild(txt("p", "hint pro-reassure", "Heads up — this browser isn't saving data, so keep your receipt and restore code somewhere safe after you buy."));
  }
  const msgHost = el("div", "pro-msg");

  let cleanup = () => {};
  const close = () => { cleanup(); backdrop.remove(); };

  const buyBtn = txt("button", "btn big", "Unlock Pro"); buyBtn.type = "button";
  // The single purchase flow — shared by the "Unlock Pro" button and the polished
  // error state's "Try again" (so retry re-runs the SAME Billing.purchasePro() path,
  // never a reimplementation).
  const runPurchase = async () => {
    msgHost.innerHTML = ""; // clear any prior error state before a fresh attempt
    buyBtn.disabled = true; buyBtn.textContent = "Processing…";
    let res;
    try { res = await Billing.purchasePro(); }
    catch (e) { console.error("Local Invoice: purchasePro threw", e); res = { ok: false, error: "Something went wrong finishing up." }; }
    if (res && res.ok) {
      close();
      if (res.restoreCode) showRestoreCodeModal(res.restoreCode); // celebrate + save-code
      else showPaidNoCodeModal();                                  // celebrate + offer to mint
      return;
    }
    // Not ok — branch on the specific failure shape, resetting the button each time.
    buyBtn.disabled = false; buyBtn.textContent = "Unlock Pro";
    if (res && res.inFlight) {
      // A purchase from a moment ago is still settling (entitlement attaching). Don't open a
      // second checkout or show an error — reassure, and Pro unlocks itself when it lands.
      proStatus(msgHost, "Your purchase is still going through — give it a moment and Pro will unlock automatically.", "info");
    } else if (res && res.cancelled) {
      proStatus(msgHost, "No charge was made — Pro will be here whenever you're ready.", "info");
    } else if (res && res.offline) {
      // "no charge was made just now" scopes the claim to THIS click — someone who paid in an
      // earlier dead tab must never read this as "you were never charged".
      proStatus(msgHost, "You're offline — buying Pro needs a connection for the secure checkout. Everything else works offline, and no charge was made just now.", "info");
    } else if (res && res.pending) {
      // PAID — the charge SUCCEEDED; the entitlement is only still attaching (a few seconds).
      // Never show the "purchase didn't start / nothing was charged" card or a re-buy button to
      // someone who just paid. Reassure, hand over the code, and auto-unlock when it lands.
      close();
      handlePurchasePending(res.restoreCode || null, res.error);
    } else {
      // Genuine error — polished, on-brand error state. "Try again" re-runs runPurchase.
      renderPurchaseError(msgHost, runPurchase);
    }
  };
  buyBtn.onclick = runPurchase;
  const closeBtn = txt("button", "btn ghost", "Not now"); closeBtn.type = "button";
  closeBtn.onclick = () => close();
  const restoreLink = txt("button", "restore-link", IS_NATIVE ? "Restore Purchases" : "Already Pro? Restore with a code"); restoreLink.type = "button";
  if (IS_NATIVE) {
    // Apple's required "Restore Purchases": re-syncs this Apple ID's receipt with the App Store.
    restoreLink.onclick = async () => {
      const prev = restoreLink.textContent;
      restoreLink.disabled = true; restoreLink.textContent = "Restoring…";
      let res;
      try { res = await Billing.restorePurchases(); }
      catch (e) { console.error("Local Invoice: restore threw", e); res = { ok: false }; }
      if (res && res.ok) { close(); refreshAfterProChange(); runPendingProIntent(); }
      else {
        restoreLink.disabled = false; restoreLink.textContent = prev;
        proStatus(msgHost, "No previous purchase found. Make sure you're signed in with the Apple Account you bought Pro with.", "info");
      }
    };
  } else {
    restoreLink.onclick = () => { close(); showRestoreEntryModal(); };
  }
  const actions = el("div", "pro-actions"); actions.append(buyBtn, closeBtn);
  modal.append(actions, msgHost, restoreLink);
  backdrop.appendChild(modal);
  // Backdrop click closes (parity with existing modals) — but only the paywall itself.
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  // A11y: role=dialog, focus in, focus-trap, Escape closes the PAYWALL (item 7).
  cleanup = makeDialog(backdrop, modal, close);
}

function field(label, value, onChange, isTextarea, type) {
  const wrap = el("div", "field");
  wrap.appendChild(txt("span", "field-label", label));
  const input = isTextarea ? el("textarea") : el("input");
  if (!isTextarea && type) input.type = type;
  input.setAttribute("aria-label", label); // the visible label is a span, not a <label> — name the control for AT
  input.value = value || "";
  input.addEventListener("input", () => onChange(isTextarea ? input.value : input.value));
  wrap.appendChild(input);
  return wrap;
}

function renderLineItems(host) {
  host.innerHTML = "";
  draft.items.forEach((item, i) => {
    const row = el("div", "lineitem-row");
    const desc = el("input"); desc.placeholder = "Description"; desc.value = item.description;
    desc.setAttribute("aria-label", "Item description");
    desc.oninput = () => { item.description = desc.value; livePreviewUpdate(); };
    const qty = el("input", "qty"); qty.value = item.qty; qty.inputMode = "decimal";
    qty.setAttribute("aria-label", "Quantity");
    qty.oninput = () => { item.qty = qty.value; livePreviewUpdate(); };
    const rate = el("input", "rate"); rate.value = item.rate; rate.inputMode = "decimal";
    rate.setAttribute("aria-label", "Rate");
    rate.oninput = () => { item.rate = rate.value; livePreviewUpdate(); };
    const rm = el("button", "rm", '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>');
    rm.type = "button";
    rm.setAttribute("aria-label", "Remove line item");
    rm.onclick = () => { if (draft.items.length <= 1) return; draft.items.splice(i, 1); renderLineItems(host); livePreviewUpdate(); };
    row.append(desc, qty, rate, rm);
    host.appendChild(row);
  });
}

function livePreviewUpdate() {
  const host = $("#editor .editor-grid > div:last-child");
  if (!host) return;
  host.innerHTML = "";
  host.appendChild(buildPreview());
}

function buildPreview() {
  const card = el("div", "preview" + (isEstimate(draft) ? " is-estimate" : ""));
  if (validLogo(draft.from.logo)) {
    // Custom logo is a Pro feature. Free users still SEE it in the live preview
    // (with a small "Pro" tag) so they know exactly what they'd get — mirroring
    // the "How to pay" block below — but it's only embedded into the exported PDF
    // for Pro (see doExport). Pro users get the clean logo with no tag.
    const logoImg = el("img", "preview-logo"); logoImg.src = draft.from.logo; logoImg.alt = "";
    if (Billing.isPro()) {
      card.appendChild(logoImg);
    } else {
      const logoWrap = el("div", "preview-logo-wrap");
      logoWrap.appendChild(logoImg);
      logoWrap.appendChild(txt("span", "pro-tag", "Pro"));
      card.appendChild(logoWrap);
    }
  }
  const head = el("div", "preview-head");
  const left = el("div");
  left.appendChild(txt("h2", null, docTitleUpper(draft)));
  left.appendChild(txt("div", "meta", `${docNumberLabel(draft)} · ${fmtDate(draft.date) || "No date set"}`));
  // Estimates carry an unmistakable "ESTIMATE · NOT AN INVOICE" ribbon so the
  // document can't be confused with a bill.
  if (isEstimate(draft)) left.appendChild(txt("div", "est-ribbon", "Estimate · Not an invoice"));
  head.appendChild(left);
  const bd = invoiceBreakdown(draft);
  const cur = draft.currency;
  head.appendChild(txt("div", "amount", money(bd.total, cur)));
  card.appendChild(head);

  const parties = el("div", "preview-parties");
  const fromCol = el("div");
  fromCol.appendChild(txt("div", "label", "From"));
  fromCol.appendChild(txt("div", "name", draft.from.name || "Your name"));
  fromCol.appendChild(txt("div", "sub", [draft.from.email, draft.from.address].filter(Boolean).join("\n")));
  const toCol = el("div");
  toCol.appendChild(txt("div", "label", "Bill to"));
  toCol.appendChild(txt("div", "name", draft.billTo.name || "Client name"));
  toCol.appendChild(txt("div", "sub", [draft.billTo.email, draft.billTo.address].filter(Boolean).join("\n")));
  parties.append(fromCol, toCol);
  card.appendChild(parties);

  const table = el("table");
  const thead = el("thead"); const htr = el("tr");
  htr.append(txt("td", null, "Item"), txt("td", "qty", "Qty"), txt("td", "num", "Amount"));
  thead.appendChild(htr); table.appendChild(thead);
  const tbody = el("tbody");
  draft.items.forEach((it) => {
    if (!it.description && !safeNumber(it.rate)) return;
    const tr = el("tr");
    tr.append(txt("td", null, it.description || "—"), txt("td", "qty", String(safeNumber(it.qty))), txt("td", "num", money(safeNumber(it.qty) * safeNumber(it.rate), cur)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  card.appendChild(table);

  const totals = el("div", "preview-totals");
  const tTable = el("table");
  // Only show the subtotal/discount/tax/shipping breakdown rows when at least
  // one of them is non-zero — a plain invoice renders exactly as before (just
  // the Total row).
  const hasBreakdown = bd.discountAmount > 0 || bd.taxAmount > 0 || bd.shipping > 0;
  if (hasBreakdown) {
    const addRow = (label, value) => {
      const tr = el("tr");
      tr.append(txt("td", null, label), txt("td", "num", value));
      tTable.appendChild(tr);
    };
    addRow("Subtotal", money(bd.subtotal, cur));
    if (bd.discountAmount > 0) addRow("Discount", "−" + money(bd.discountAmount, cur));
    if (bd.taxAmount > 0) {
      const rate = safeNumber(draft.taxRate);
      const taxName = (draft.taxLabel || "Tax") + (rate ? ` (${rate}%)` : "");
      addRow(taxName, money(bd.taxAmount, cur));
    }
    if (bd.shipping > 0) addRow("Shipping", money(bd.shipping, cur));
  }
  const grand = el("tr", "grand");
  grand.append(txt("td", null, "Total"), txt("td", "num", money(bd.total, cur)));
  tTable.appendChild(grand);
  // Paid / Balance due rows — only when payments exist (an unpaid invoice renders
  // exactly as before). Estimates never carry payments.
  const ps = paymentSummary(draft);
  if (!isEstimate(draft) && ps.hasPayments) {
    const paidTr = el("tr", "paid-row");
    paidTr.append(txt("td", null, "Paid"), txt("td", "num", "−" + money(ps.paidToDate, cur)));
    tTable.appendChild(paidTr);
    const balTr = el("tr", "balance-row" + (ps.balanceDue <= 0 ? " settled" : ""));
    balTr.append(txt("td", null, ps.balanceDue <= 0 ? "Balance due — paid in full" : "Balance due"), txt("td", "num", money(ps.balanceDue, cur)));
    tTable.appendChild(balTr);
  }
  totals.appendChild(tTable);
  card.appendChild(totals);

  if (draft.dueDate) card.appendChild(txt("div", "preview-due", `${dueDatePrefix(draft)} ${fmtDate(draft.dueDate)}`));
  if (draft.notes) card.appendChild(txt("div", "preview-footer", draft.notes));

  // "How to pay" block — always shown in the live preview (with a small Pro tag)
  // so free users can see exactly what they'd get; the tag signals it only makes
  // it into the exported PDF for Pro. textContent-only (user-derived string).
  if ((draft.paymentDetails || "").trim()) {
    const pay = el("div", "preview-payment");
    const payHead = el("div", "preview-payment-head");
    payHead.appendChild(txt("span", "label", "How to pay"));
    payHead.appendChild(txt("span", "pro-tag", "Pro"));
    pay.appendChild(payHead);
    pay.appendChild(txt("div", "preview-payment-body", draft.paymentDetails));
    card.appendChild(pay);
  }

  return card;
}

// ── Save / export ────────────────────────────────────────────────────────
// Announces save/export/restore results to screen readers. The live-region
// node is created ONCE per host and only its text is updated afterwards, so
// assistive tech reliably announces each new message (replacing the whole node
// each time can make AT miss the change). Success → role="status" (polite);
// errors → role="alert" (assertive). Colors are tokenized so they read in dark
// mode (paper/preview surfaces stay light via their own scoped tokens).
function status(host, msg, kind) {
  const isErr = kind === "err";
  let s = host.querySelector(".status");
  // Recreate the node if the severity (and therefore the required ARIA role)
  // changed — role can't be swapped reliably on a live node for all AT.
  if (s && s.dataset.kind !== kind) { s.remove(); s = null; }
  if (!s) {
    s = el("div");
    s.dataset.kind = kind;
    s.setAttribute("role", isErr ? "alert" : "status");
    s.setAttribute("aria-live", isErr ? "assertive" : "polite");
    s.setAttribute("aria-atomic", "true");
    host.appendChild(s);
  }
  s.className = "status " + kind;
  s.style.cssText = "margin-top:12px;padding:10px 14px;border-radius:10px;font-size:13.5px;" +
    (isErr ? "background:var(--err-bg);color:var(--err);" : "background:var(--ok-bg);color:var(--ok);");
  s.textContent = msg;
}

function doSave() {
  const msgHost = $("#editorMsg");
  const idx = state.invoices.findIndex((i) => i.id === draft.id);
  if (idx >= 0) {
    state.invoices[idx] = draft;
  } else {
    // Guard against a stale in-memory nextNumber (e.g. two tabs/sessions open
    // at once, or a duplicate created before another save landed) ever producing
    // two invoices with the same customer-facing number.
    if (state.invoices.some((i) => i.number === draft.number)) {
      draft.number = nextInvoiceNumber();
    }
    state.invoices.push(draft);
    state.nextNumber = Math.max(state.nextNumber, draft.number + 1);
  }
  const name = (draft.billTo.name || "").trim();
  const email = (draft.billTo.email || "").trim();
  if (name) {
    const alreadySaved = state.clients.some((c) => (c.name || "").trim().toLowerCase() === name.toLowerCase() && (c.email || "").trim().toLowerCase() === email.toLowerCase());
    if (!alreadySaved) state.clients.push({ ...draft.billTo, name, email });
  }
  saveStateWithRetry((ok) => {
    if (!ok) return status(msgHost, friendly(lastSaveError), "err");
    markClean();
    // Rebuild so a just-saved NEW invoice now shows the Duplicate action (which
    // only appears for invoices that exist on disk). Re-show the confirmation
    // after the rebuild, since buildEditor clears the message host.
    buildEditor();
    status($("#editorMsg"), "Saved — this invoice lives only on this device.", "ok");
  });
}

// Gentle inline note shown after a free user exports with payment text — the
// PDF already downloaded; this only nudges toward Pro. Idempotent per host (an
// existing note is replaced so repeated exports don't stack copies).
function showPaymentUpsellNote(host) {
  const existing = host.querySelector(".payment-upsell");
  if (existing) existing.remove();
  const note = el("div", "payment-upsell");
  note.setAttribute("role", "status");
  note.appendChild(txt("span", null, "Your payment instructions weren't included — they're a Pro feature. "));
  const link = txt("button", "restore-link payment-upsell-link", "Unlock Pro");
  link.type = "button";
  link.onclick = () => {
    // Item 5: after unlock/restore, re-run the export so they get the PDF WITH the
    // payment block (this note appears right after a free export that dropped it).
    setPendingProIntent(() => { if (Billing.isPro()) doExport(); });
    showProModal();
  };
  note.appendChild(link);
  host.appendChild(note);
}

async function doExport() {
  const msgHost = $("#editorMsg");
  try {
    await ensurePdfLib(); // loads pdf-lib on demand (first export)
    const pdf = await PDFDocument.create();
    let page = pdf.addPage([612, 792]);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const reg = await pdf.embedFont(StandardFonts.Helvetica);
    const brand = rgb(0.263, 0.220, 0.792);
    const ink = rgb(0.10, 0.10, 0.18);
    const muted = rgb(0.42, 0.45, 0.5);
    // Estimates print in amber (matches the on-screen estimate identity); invoices
    // stay indigo. `accent` colors the doc title + head total for the current kind.
    const estAccent = rgb(0.706, 0.325, 0.035); // #b45309
    const accent = isEstimate(draft) ? estAccent : brand;
    let y = 740;
    // ── Pagination ──────────────────────────────────────────────────────────
    // Previously the whole invoice drew on a single fixed 792pt page: a long
    // itemized invoice pushed later items — and the grand Total — off the bottom
    // with no warning. These helpers carry drawing onto fresh pages so nothing is
    // ever silently lost. (Layout on a short, single-page invoice is unchanged.)
    const PAGE_H = 792, TOP_Y = 740, BOTTOM_Y = 56;
    const newPage = () => { page = pdf.addPage([612, PAGE_H]); y = TOP_Y; };
    // Start a fresh page when drawing `need` pts down would cross the bottom margin.
    const ensureRoom = (need) => { if (y - need < BOTTOM_Y) { newPage(); return true; } return false; };
    // The item-table column header — drawn under the parties on page 1 and again
    // atop every continuation page so a multi-page invoice stays readable.
    const drawItemsHeader = () => {
      page.drawText("Item", { x: 48, y, size: 9, font: bold, color: muted });
      page.drawText("Qty", { x: 420, y, size: 9, font: bold, color: muted });
      page.drawText("Amount", { x: 500, y, size: 9, font: bold, color: muted });
      y -= 18;
    };

    // Custom logo is a Pro feature — mirror the "How to pay" block below, which
    // gates on Billing.isPro(). validLogo() alone is not enough: a logo can reach
    // from.logo via a restored Data Vault backup or hand-edited state, so a NON-Pro
    // user must never get it embedded in the exported PDF.
    if (validLogo(draft.from.logo) && Billing.isPro()) {
      try {
        const logoBytes = dataUrlToBytes(draft.from.logo);
        const isPng = draft.from.logo.startsWith("data:image/png");
        const logoImage = isPng ? await pdf.embedPng(logoBytes) : await pdf.embedJpg(logoBytes);
        const maxH = 44, maxW = 160;
        const scale = Math.min(maxW / logoImage.width, maxH / logoImage.height, 1);
        const w = logoImage.width * scale, h = logoImage.height * scale;
        page.drawImage(logoImage, { x: 48, y: y - h + 26, width: w, height: h });
        y -= (h + 14); // push the rest of the header down to clear the logo; untouched when there's no logo
      } catch (e) { console.error("Logo embed failed, continuing without it:", e); }
    }

    const bd = invoiceBreakdown(draft);
    const cur = draft.currency;
    const headTotal = pdfSafe(moneyPdf(bd.total, cur));
    page.drawText(docTitle(draft), { x: 48, y, size: 26, font: bold, color: isEstimate(draft) ? accent : ink });
    page.drawText(headTotal, { x: 612 - 48 - bold.widthOfTextAtSize(headTotal, 20), y: y + 4, size: 20, font: bold, color: accent });
    y -= 22;
    page.drawText(pdfSafe(`${docNumberLabel(draft)}  ·  ${fmtDate(draft.date) || ""}`), { x: 48, y, size: 11, font: reg, color: muted });
    // Estimate-only marker line so a printed estimate is never mistaken for a bill.
    if (isEstimate(draft)) {
      y -= 15;
      page.drawText("ESTIMATE — NOT AN INVOICE", { x: 48, y, size: 9, font: bold, color: accent });
    }
    y -= 40;

    const colX = [48, 320];
    const partyTop = y;
    [["From", draft.from], ["Bill to", draft.billTo]].forEach(([label, party], i) => {
      let py = partyTop;
      page.drawText(label, { x: colX[i], y: py, size: 9, font: bold, color: muted }); py -= 16;
      page.drawText(pdfSafe(party.name || ""), { x: colX[i], y: py, size: 12, font: bold, color: ink }); py -= 15;
      [party.email, party.address].filter(Boolean).forEach((line) => {
        String(line).split("\n").forEach((sub) => { page.drawText(pdfSafe(sub), { x: colX[i], y: py, size: 10, font: reg, color: muted }); py -= 13; });
      });
    });
    y = partyTop - 90;
    page.drawLine({ start: { x: 48, y: y + 12 }, end: { x: 564, y: y + 12 }, thickness: 1, color: rgb(0.9, 0.9, 0.93) });
    y -= 6;

    drawItemsHeader();

    draft.items.forEach((it) => {
      if (!it.description && !safeNumber(it.rate)) return;
      if (ensureRoom(20)) drawItemsHeader(); // carry the item table onto a fresh page
      // 360pt keeps even the widest realistic descriptions clear of the Qty column at x=420.
      const desc = fitText(reg, pdfSafe(it.description || "—"), 11, 360);
      page.drawText(desc, { x: 48, y, size: 11, font: reg, color: ink });
      page.drawText(String(safeNumber(it.qty)), { x: 420, y, size: 11, font: reg, color: ink });
      const amt = pdfSafe(moneyPdf(safeNumber(it.qty) * safeNumber(it.rate), cur));
      page.drawText(amt, { x: 564 - reg.widthOfTextAtSize(amt, 11), y, size: 11, font: reg, color: ink });
      y -= 20;
    });

    y -= 6;
    // Breakdown rows above the Total — only when there's something to break down
    // (a plain invoice draws exactly the divider + Total, same as before).
    const hasBreakdown = bd.discountAmount > 0 || bd.taxAmount > 0 || bd.shipping > 0;
    // Keep the whole totals stack (breakdown rows + Total + any Paid/Balance)
    // together: if it wouldn't fit under the last line item, carry the entire block
    // to a fresh page so the grand Total is never pushed off the bottom.
    {
      const psRoom = (!isEstimate(draft) && Billing.isPro()) ? paymentSummary(draft) : { hasPayments: false };
      let totalsRoom = 44; // divider + Total row + trailing gap
      if (hasBreakdown) totalsRoom += 16 * (1 + (bd.discountAmount > 0 ? 1 : 0) + (bd.taxAmount > 0 ? 1 : 0) + (bd.shipping > 0 ? 1 : 0)) + 2;
      if (psRoom.hasPayments) totalsRoom += 48;
      ensureRoom(totalsRoom);
    }
    if (hasBreakdown) {
      const drawTotalRow = (label, valueStr, isBold) => {
        const font = isBold ? bold : reg;
        page.drawText(pdfSafe(label), { x: 300, y, size: 10.5, font, color: isBold ? ink : muted });
        const v = pdfSafe(valueStr);
        page.drawText(v, { x: 564 - font.widthOfTextAtSize(v, 10.5), y, size: 10.5, font, color: isBold ? ink : muted });
        y -= 16;
      };
      drawTotalRow("Subtotal", moneyPdf(bd.subtotal, cur));
      if (bd.discountAmount > 0) drawTotalRow("Discount", "-" + moneyPdf(bd.discountAmount, cur));
      if (bd.taxAmount > 0) {
        const rate = safeNumber(draft.taxRate);
        const taxName = (draft.taxLabel || "Tax") + (rate ? ` (${rate}%)` : "");
        drawTotalRow(taxName, moneyPdf(bd.taxAmount, cur));
      }
      if (bd.shipping > 0) drawTotalRow("Shipping", moneyPdf(bd.shipping, cur));
      y -= 2;
    }
    page.drawLine({ start: { x: 380, y: y + 14 }, end: { x: 564, y: y + 14 }, thickness: 1, color: rgb(0.85, 0.85, 0.9) });
    page.drawText("Total", { x: 420, y, size: 12, font: bold, color: ink });
    const totalStr = pdfSafe(moneyPdf(bd.total, cur));
    page.drawText(totalStr, { x: 564 - bold.widthOfTextAtSize(totalStr, 12), y, size: 12, font: bold, color: ink });
    y -= 30;

    // ── Paid / Balance due (Pro: partial payments & deposits) ──
    // Only when payments exist (a plain unpaid invoice prints exactly as before).
    // Estimates never carry payments. The balance is the emphasized figure.
    // Gate on Billing.isPro() exactly like the logo + "How to pay" blocks: payment
    // data can reach a NON-Pro draft via a restored/hand-edited backup, and
    // "Record payments & deposits" is a Pro feature — so it must never print for free.
    const ps = paymentSummary(draft);
    if (!isEstimate(draft) && ps.hasPayments && Billing.isPro()) {
      y += 8; // tighten the gap after the Total row
      const paidStr = pdfSafe("-" + moneyPdf(ps.paidToDate, cur));
      page.drawText("Paid", { x: 300, y, size: 10.5, font: reg, color: muted });
      page.drawText(paidStr, { x: 564 - reg.widthOfTextAtSize(paidStr, 10.5), y, size: 10.5, font: reg, color: muted });
      y -= 18;
      const balLabel = ps.balanceDue <= 0 ? "Balance due (paid in full)" : "Balance due";
      const balStr = pdfSafe(moneyPdf(ps.balanceDue, cur));
      page.drawText(balLabel, { x: 300, y, size: 11, font: bold, color: ink });
      page.drawText(balStr, { x: 564 - bold.widthOfTextAtSize(balStr, 11), y, size: 11, font: bold, color: accent });
      y -= 30;
    }

    if (draft.dueDate) { ensureRoom(20); page.drawText(pdfSafe(`${dueDatePrefix(draft)} ${fmtDate(draft.dueDate)}`), { x: 48, y, size: 10, font: reg, color: muted }); y -= 20; }
    if (draft.notes) {
      String(draft.notes).split("\n").forEach((line) => {
        if (y < BOTTOM_Y) newPage(); // paginate long notes instead of silently dropping lines
        page.drawText(fitText(reg, pdfSafe(line), 10, 516), { x: 48, y, size: 10, font: reg, color: muted }); y -= 14;
      });
    }

    // ── "How to pay" block (Pro) ──
    // Renders under the notes/footer only when the user is Pro AND the field is
    // non-empty. A free user who typed payment instructions gets a gentle upsell
    // note AFTER the (still successful) export — the export itself is never
    // blocked. isPro() is the cached status; the logo flow (buildLogoField) also
    // gates on Billing, so both Pro surfaces stay consistent.
    const paymentText = (draft.paymentDetails || "").trim();
    const includePayment = paymentText && Billing.isPro();
    if (includePayment) {
      y -= 8;
      ensureRoom(29); // keep the "How to pay" heading with its first line
      page.drawText("How to pay", { x: 48, y, size: 9, font: bold, color: muted });
      y -= 15;
      String(draft.paymentDetails).split("\n").forEach((line) => {
        if (y < BOTTOM_Y) newPage(); // paginate long payment instructions instead of dropping them
        page.drawText(fitText(reg, pdfSafe(line), 10, 516), { x: 48, y, size: 10, font: reg, color: ink }); y -= 14;
      });
    }

    const bytes = await pdf.save();
    // Safari (desktop and iOS) treats a blob: URL typed "application/pdf" as
    // viewable content and opens its own PDF viewer instead of honoring the
    // <a download> attribute below, so the file never actually reaches
    // Downloads. "application/octet-stream" has no built-in viewer, so every
    // browser treats it as an opaque file and saves it instead — the file's
    // .pdf extension (set on the <a download> filename) is what makes it open
    // correctly afterward. The Capacitor native path below never inspects
    // this MIME type (it re-reads the raw bytes via FileReader), so this is
    // safe there too.
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    // e.g. "invoice-0001.pdf" or "estimate-EST-0001.pdf" (strip only the "#").
    const filename = `${isEstimate(draft) ? "estimate" : "invoice"}-${docNumberLabel(draft).replace("#", "")}.pdf`;

    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      // Directory is a plain JS enum exported from the @capacitor/filesystem
      // *package* (not a "plugin"), so it's never present on
      // window.Capacitor.Plugins in this no-bundler, plain-<script>-tag app —
      // destructuring it from there silently yields undefined, and
      // `directory: undefined.Cache` throws. "CACHE" is that enum's actual
      // underlying string value (confirmed against the vendored package),
      // used directly instead of a reference that doesn't exist here.
      const { Filesystem } = window.Capacitor.Plugins;
      const { Share } = window.Capacitor.Plugins;
      const base64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
      await writeAndShareNative(Filesystem, Share, filename, base64);
    } else {
      const a = el("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
    status(msgHost, "PDF ready — saved to your downloads.", "ok");
    // Free user who typed payment instructions: the export SUCCEEDED (never
    // blocked), but the block was left out. Surface a gentle inline upsell with a
    // one-click path into the Pro modal — shown after the success message so the
    // export result reads first.
    if (paymentText && !includePayment) showPaymentUpsellNote(msgHost);
  } catch (e) {
    console.error("Local Invoice export failed:", e);
    status(msgHost, friendlyExportError(), "err");
  }
}
// Defensive retry for a genuinely transient native-bridge hiccup (disk
// contention, a slow first native call) — retry the whole write+share
// sequence once after a short delay before giving up and showing an error.
async function writeAndShareNative(Filesystem, Share, filename, base64, isRetry) {
  try {
    const { uri } = await Filesystem.writeFile({ path: filename, data: base64, directory: "CACHE" });
    await Share.share({ title: filename, files: [uri] });
  } catch (e) {
    if (isRetry) throw e;
    await new Promise((r) => setTimeout(r, 400));
    return writeAndShareNative(Filesystem, Share, filename, base64, true);
  }
}

// ── Data vault (back up / restore ALL app data, plus the Pro code) ──────
function exportVault() {
  const payload = {
    app: VAULT_APP_ID,
    version: 1,
    exportedAt: new Date().toISOString(),
    state, // the exact object saveState() persists under STORAGE_KEY
    proRestoreCode: Billing.getRestoreCode() || null,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a"); a.href = url; a.download = `${VAULT_APP_ID}-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function importVault(file) {
  const reader = new FileReader();
  reader.onerror = () => showVaultError("Couldn't read that file — try again.");
  reader.onload = () => {
    let payload;
    try { payload = JSON.parse(String(reader.result)); }
    catch { return showVaultError("That file doesn't look like a backup — it isn't valid JSON."); }
    if (!payload || typeof payload !== "object" || payload.app !== VAULT_APP_ID) {
      const other = payload && typeof payload === "object" && typeof payload.app === "string" && payload.app ? payload.app : null;
      return showVaultError(other ? `That backup is from ${other}.` : "That file doesn't look like a Local Invoice backup.");
    }
    // Same guards as a boot-time load — a hand-edited or corrupt backup can
    // never smuggle a bad shape past the render code.
    const incoming = sanitizeState(payload.state);
    const dateLabel = typeof payload.exportedAt === "string" && payload.exportedAt
      ? (fmtDate(payload.exportedAt.slice(0, 10)) || payload.exportedAt.slice(0, 10))
      : "an unknown date";
    showVaultConfirmModal(dateLabel, () => {
      state = incoming;
      saveStateWithRetry((ok) => {
        draft = null; draftSnapshot = null; // any open editor draft belonged to the replaced data
        showHub();
        showVaultToast(ok ? "Backup restored." : "Backup loaded — but it couldn't be saved to this browser (storage blocked or full).");
        if (payload.proRestoreCode && !Billing.isPro()) {
          if (IS_NATIVE) {
            // No codes on iOS — a backup restores DATA only here. Never adopt the backup's
            // WEB restore code (and never open code entry) on iPhone/iPad: web Pro and App
            // Store Pro are separate purchases, and an Apple buyer's Pro comes back through
            // their Apple Account, not a typed code. One gentle pointer, nothing else.
            showVaultToast("Pro comes back with Restore Purchases on iPhone and iPad.");
          } else {
            const proRestoreFailed = () => {
              // The user's invoices ARE imported and saved (above) — only the Pro code in the
              // backup didn't restore (wrong/refunded code, or servers unreachable). Never fail
              // silently and never touch the imported data: say so plainly, and open manual
              // restore-code entry so they can still unlock Pro.
              showVaultToast("Your data imported, but Pro didn't restore from this backup — enter your restore code to unlock Pro.");
              try { showRestoreEntryModal(); } catch (e) { console.error("Local Invoice: restore entry open failed", e); }
            };
            Billing.restoreWithCode(payload.proRestoreCode).then((res) => {
              if (res && res.ok) {
                updateFooterProLinks();
                updateSelfHealNag();
                refreshAfterProChange();
                showVaultToast("Pro restored on this device too.");
              } else {
                proRestoreFailed();
              }
            }).catch((e) => { console.error("Local Invoice: vault Pro restore failed", e); proRestoreFailed(); });
          }
        }
      });
    });
  };
  reader.readAsText(file);
}

function showVaultConfirmModal(dateLabel, onConfirm) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  let cleanup = () => {};
  const close = () => { cleanup(); backdrop.remove(); };
  modal.appendChild(txt("h3", null, "Restore from backup?"));
  modal.appendChild(txt("p", "hint", `Replace everything in this app with the backup from ${dateLabel}? Your current data will be overwritten.`));
  const goBtn = txt("button", "btn big danger", "Replace my data"); goBtn.type = "button";
  goBtn.onclick = () => { close(); onConfirm(); };
  const cancelBtn = txt("button", "btn ghost", "Cancel"); cancelBtn.type = "button";
  cancelBtn.onclick = close;
  const actions = el("div", "pro-actions"); actions.append(goBtn, cancelBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  // Accessible dialog: role/aria-modal, focus-in, Tab-trap, Esc-to-close, focus
  // restore. Especially important here — this is the destructive overwrite confirm.
  cleanup = makeDialog(backdrop, modal, close);
}

function showVaultError(message) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  let cleanup = () => {};
  const close = () => { cleanup(); backdrop.remove(); };
  modal.appendChild(txt("h3", null, "Couldn't restore that backup"));
  modal.appendChild(txt("p", "hint", message));
  const closeBtn = txt("button", "btn big", "OK"); closeBtn.type = "button";
  closeBtn.onclick = close;
  const actions = el("div", "pro-actions"); actions.append(closeBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  cleanup = makeDialog(backdrop, modal, close);
}

function showVaultToast(msg) {
  const n = txt("div", "vault-toast", msg);
  n.setAttribute("role", "status");
  n.setAttribute("aria-live", "polite");
  n.setAttribute("aria-atomic", "true");
  n.style.bottom = 24 + document.querySelectorAll(".vault-toast").length * 54 + "px";
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 4500);
}

// ── Theme (light / dark / system) ─────────────────────────────────────────
// The pre-paint inline script in index.html already applied the correct theme
// on boot; here we wire the toggle and keep "system" live-updating. From
// "system" a tap flips to the opposite of what's rendered (never a no-op),
// then cycles dark → light → system.
const THEME_KEY = "localinvoice.theme";
const THEME_CYCLE = ["light", "dark", "system"];
const prefersDark = () => window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
function getThemePref() {
  try { const v = localStorage.getItem(THEME_KEY); return THEME_CYCLE.includes(v) ? v : "system"; }
  catch { return "system"; }
}
function applyTheme(pref) {
  const dark = pref === "dark" || (pref === "system" && prefersDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const btn = $("#themeToggle");
  if (btn) btn.setAttribute("aria-label", `Switch theme (currently ${pref})`);
}
function setTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* storage blocked — theme still applies for this session */ }
  applyTheme(pref);
}
// Keep "system" choices reacting to OS changes live.
if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => { if (getThemePref() === "system") applyTheme("system"); };
  if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
}
applyTheme(getThemePref());
// Cycle so EVERY click visibly changes the rendered theme (matches LocalResume).
// From "system"/unset, flip to the OPPOSITE of what's currently rendered — this
// avoids a no-op first click (e.g. system-on-a-light-OS → light would look dead);
// once explicit, cycle dark → light → system, keeping "system" reachable.
function nextTheme(cur) {
  if (cur === "system") return renderedDark() ? "light" : "dark";
  if (cur === "dark") return "light";
  if (cur === "light") return "system";
  return "dark";
}
function renderedDark() { return document.documentElement.getAttribute("data-theme") === "dark"; }
$("#themeToggle").onclick = () => {
  setTheme(nextTheme(getThemePref()));
  // keep the Settings appearance control in sync if it's the visible route
  const sv = $("#view-settings");
  if (sv && !sv.classList.contains("hidden")) renderSettingsView(sv);
};

/* ═══════════════════════════════════════════════════════════════════════
   NAV SHELL + HASH ROUTER (re-skin v2)
   A thin view-switch over the EXISTING builders. Routes: dashboard / invoices
   / estimates / clients / settings (default dashboard). The editor stays an
   overlay opened from a list/quick-action and returns to the list it came
   from. Everything below derives from EXISTING state — no schema change, no new
   persisted field, no new network call. All DOM built imperatively (no
   innerHTML of user data); SVG icons via createElementNS. */
const SVG_NS = "http://www.w3.org/2000/svg";
const ROUTES = ["dashboard", "invoices", "estimates", "clients", "settings"];
let currentRoute = "dashboard";
let editorReturnRoute = null;

// Small stroke-icon library (path `d` strings on a 24×24 grid, currentColor).
const ICONS = {
  file: ["M7 3h7l5 5v13H5V5a2 2 0 0 1 2-2z", "M14 3v5h5"],
  fileCheck: ["M7 3h7l5 5v13H5V5a2 2 0 0 1 2-2z", "M14 3v5h5", "M9 15l2 2 4-4"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 8v4l3 2"],
  alert: ["M12 3 2 20h20L12 3z", "M12 10v4", "M12 17.5v.5"],
  draft: ["M7 3h7l5 5v13H5V5a2 2 0 0 1 2-2z", "M14 3v5h5", "M8 13h6M8 17h4"],
  users: ["M9 8a3.2 3.2 0 1 0 0-.01", "M3.5 20a5.5 5.5 0 0 1 11 0", "M16 5.2a3.2 3.2 0 0 1 0 5.6", "M17.5 14.5a5.5 5.5 0 0 1 3 5"],
  userPlus: ["M9 8a3.2 3.2 0 1 0 0-.01", "M3.5 20a5.5 5.5 0 0 1 11 0", "M18 8v6M15 11h6"],
  plus: ["M12 5v14M5 12h14"],
  mail: ["M3 6h18v12H3z", "M3 7l9 6 9-6"],
  phone: ["M6 3h3l2 5-2 1a12 12 0 0 0 5 5l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z"],
  user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M5 20a7 7 0 0 1 14 0"],
  chart: ["M4 20V10M10 20V4M16 20v-7M22 20H2"],
  chevL: ["M15 6l-6 6 6 6"],
  chevR: ["M9 6l6 6-6 6"],
  dots: ["M12 6.5v.01M12 12v.01M12 17.5v.01"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4-4"],
  invoiceArt: ["M6 4h9l4 4v12H6z", "M15 4v4h4", "M9 12h7M9 15h5M9 18h6"],
  doc: ["M7 3h7l5 5v13H5V5a2 2 0 0 1 2-2z", "M14 3v5h5"],
};
function icon(name, size) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (size) { svg.setAttribute("width", size); svg.setAttribute("height", size); }
  (ICONS[name] || []).forEach((d) => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  });
  return svg;
}

// ── Illustrated empty-state art (inline SVG, on-device) ─────────────────────
// A tinted document with sparkles (dashboard "No invoices yet"), matching the
// mockup's warmth. Decorative → aria-hidden.
function sparklyDocArt() {
  const NS = SVG_NS;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 72 72");
  svg.setAttribute("class", "empty-art-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML =
    '<path class="ea-doc-fill" d="M22 12h20l10 10v34a2 2 0 0 1-2 2H22a2 2 0 0 1-2-2V14a2 2 0 0 1 2-2z"/>' +
    '<path class="ea-doc-stroke" d="M22 12h20l10 10v34a2 2 0 0 1-2 2H22a2 2 0 0 1-2-2V14a2 2 0 0 1 2-2z"/>' +
    '<path class="ea-doc-stroke" d="M42 12v10h10"/>' +
    '<path class="ea-doc-line" d="M27 33h18M27 40h18M27 47h11"/>' +
    '<path class="ea-spark ea-spark-1" d="M55 20l1.4 3.6L60 25l-3.6 1.4L55 30l-1.4-3.6L50 25l3.6-1.4z"/>' +
    '<path class="ea-spark ea-spark-2" d="M17 26l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/>' +
    '<circle class="ea-spark ea-spark-3" cx="20" cy="52" r="1.6"/>';
  return svg;
}
// A tinted person + revenue-bars motif for the "No clients yet" mini empty.
function sparklyClientArt() {
  const NS = SVG_NS;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 72 72");
  svg.setAttribute("class", "empty-art-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML =
    '<circle class="ea-doc-fill" cx="36" cy="30" r="24"/>' +
    '<circle class="ea-doc-stroke" cx="36" cy="27" r="7"/>' +
    '<path class="ea-doc-stroke" d="M24 45a12 12 0 0 1 24 0"/>' +
    '<path class="ea-spark ea-spark-1" d="M56 16l1.2 3 3 1.2-3 1.2L56 25l-1.2-3-3-1.2 3-1.2z"/>' +
    '<circle class="ea-spark ea-spark-3" cx="16" cy="24" r="1.6"/>';
  return svg;
}

// ── Derived per-doc status label (invoices only; adds "overdue") ───────────
// Estimates keep their raw draft/sent/paid. Invoices that are sent + past-due
// read as "overdue". Everything is DERIVED live from existing fields — no new
// persisted status is ever introduced.
function displayStatus(inv) {
  if (isEstimate(inv)) return inv.status;
  // Payments fully cover the total → paid, regardless of the stored status flag
  // (recording the final payment settles the invoice). Checked before overdue so
  // a past-due invoice that's since been paid in full reads as paid, not overdue.
  if (isFullyPaidByPayments(inv)) return "paid";
  if (isOverdue(inv)) return "overdue";
  // Some money in, but a balance remains, and it isn't past due → partially paid.
  if (isPartiallyPaid(inv)) return "partial";
  return inv.status;
}
// Human labels for derived status keys. "partial" reads as "Partially paid"; the
// rest capitalize their raw key (draft/sent/paid/overdue).
function statusLabel(statusKey) {
  if (statusKey === "partial") return "Partially paid";
  return statusKey[0].toUpperCase() + statusKey.slice(1);
}
function statusPill(statusKey) {
  const pill = el("span", "pill " + statusKey);
  pill.appendChild(txt("span", "pill-text", statusLabel(statusKey)));
  return pill;
}
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Router core ────────────────────────────────────────────────────────────
function parseHashRoute() {
  const h = (location.hash || "").replace(/^#\/?/, "").split("/")[0].toLowerCase();
  return ROUTES.includes(h) ? h : "dashboard";
}
// Navigate by setting the hash — the hashchange listener does the actual render,
// so deep links + the back button behave identically to a click.
function goRoute(route) {
  const target = ROUTES.includes(route) ? route : "dashboard";
  const want = "#/" + target;
  if (location.hash === want) { renderRoute(target); }
  else { location.hash = want; }
}
function setActiveNav(route) {
  document.querySelectorAll(".nav-item").forEach((a) => {
    const on = a.getAttribute("data-route") === route;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}
// Show the editor overlay above the current route (remembers where to return).
function enterEditorView() {
  if (!editorReturnRoute) {
    editorReturnRoute = (currentRoute === "estimates") ? "estimates" : "invoices";
  }
  ROUTES.forEach((r) => { const v = $("#view-" + r); if (v) v.classList.add("hidden"); });
  const hub = $("#hub"); if (hub) hub.classList.add("hidden");
  const ins = $("#insights"); if (ins) ins.classList.add("hidden");
  $("#editor").classList.remove("hidden");
  closeMobileNav();
  window.scrollTo({ top: 0 });
}
function renderRoute(route) {
  currentRoute = ROUTES.includes(route) ? route : "dashboard";
  // Expose the active route on <html> so CSS can adapt chrome (e.g. drop the
  // redundant top-bar "New invoice" on pages whose hero already carries it).
  document.documentElement.setAttribute("data-route", currentRoute);
  // Editor overlay + legacy containers are hidden while a route view shows.
  $("#editor").classList.add("hidden");
  const ins = $("#insights"); if (ins) ins.classList.add("hidden");
  const hub = $("#hub"); if (hub) hub.classList.add("hidden");
  ROUTES.forEach((r) => {
    const v = $("#view-" + r);
    if (v) v.classList.toggle("hidden", r !== currentRoute);
  });
  setActiveNav(currentRoute);
  const host = $("#view-" + currentRoute);
  if (host) {
    host.innerHTML = "";
    if (currentRoute === "dashboard") renderDashboard(host);
    else if (currentRoute === "invoices") renderListView(host, "invoice");
    else if (currentRoute === "estimates") renderListView(host, "estimate");
    else if (currentRoute === "clients") renderClientsView(host);
    else if (currentRoute === "settings") renderSettingsView(host);
  }
  window.scrollTo({ top: 0 });
}
function initRouter() {
  // Nav links use real hrefs (#/route) so the browser manages history; we render
  // on hashchange. closeMobileNav on click so the drawer dismisses on small screens.
  document.querySelectorAll(".nav-item").forEach((a) => {
    a.addEventListener("click", () => { closeMobileNav(); });
  });
  window.addEventListener("hashchange", () => renderRoute(parseHashRoute()));
  // Mobile drawer toggle.
  const toggle = $("#navToggle");
  const sidebar = $("#sidebar");
  const scrim = $("#sidebarScrim");
  if (toggle && sidebar) {
    toggle.addEventListener("click", () => {
      const open = sidebar.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      if (scrim) scrim.hidden = !open;
    });
  }
  if (scrim) scrim.addEventListener("click", closeMobileNav);
  // Ensure the URL carries a valid route on first load (default dashboard),
  // then render it. Setting the hash here also normalizes "#" / bad routes.
  const initial = parseHashRoute();
  if (location.hash !== "#/" + initial) {
    // Replace so we don't push an extra history entry on boot.
    try { history.replaceState(null, "", "#/" + initial); } catch { location.hash = "#/" + initial; }
  }
  renderRoute(initial);
}
function closeMobileNav() {
  const sidebar = $("#sidebar");
  const toggle = $("#navToggle");
  const scrim = $("#sidebarScrim");
  if (sidebar) sidebar.classList.remove("open");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
  if (scrim) scrim.hidden = true;
}

// ── Shared builders ────────────────────────────────────────────────────────
function pageHead(title, subtitle, actions) {
  const head = el("div", "page-head");
  const titles = el("div", "page-head-titles");
  titles.appendChild(txt("h1", null, title));
  if (subtitle) titles.appendChild(txt("p", null, subtitle));
  head.appendChild(titles);
  if (actions && actions.length) {
    const act = el("div", "page-head-actions");
    actions.forEach((a) => act.appendChild(a));
    head.appendChild(act);
  }
  return head;
}
function primaryBtn(label, onClick) {
  const b = txt("button", "btn sm", label); b.type = "button"; b.onclick = onClick; return b;
}
function ghostBtn(label, onClick) {
  const b = txt("button", "btn ghost sm", label); b.type = "button"; b.onclick = onClick; return b;
}
function statTile(iconName, tone, label, value, sub, sparkSeries, sparkHue) {
  const tile = el("div", "stat-tile");
  const ico = el("div", "stat-icon" + (tone ? " " + tone : ""));
  ico.appendChild(icon(iconName));
  tile.appendChild(ico);
  const body = el("div", "stat-body");
  body.appendChild(txt("div", "stat-label", label));
  body.appendChild(txt("div", "stat-value", value));
  if (sub) body.appendChild(txt("div", "stat-sub", sub));
  tile.appendChild(body);
  // Optional inline-SVG sparkline (trend line + soft fill), hidden gracefully
  // when there's no data to plot.
  if (sparkSeries) {
    const spark = buildSparkline(sparkSeries, sparkHue || "indigo");
    if (spark) { const wrap = el("div", "stat-spark"); wrap.appendChild(spark); tile.appendChild(wrap); }
  }
  return tile;
}

// Aggregate the whole invoice book (invoices only — estimates excluded, mirroring
// the insights math) into the headline figures the stat tiles show, per the
// currently-viewed currency. Everything derives from invoiceBreakdown().
function bookTotals() {
  // Use the dominant currency group for headline display (same convention as
  // insights). Returns totals + the currency used.
  const groups = invoicesByCurrency();
  const group = groups.find((g) => g.code === insightsCurrency) || groups[0] || null;
  const cur = group ? group.currency : DEFAULT_CURRENCY;
  const invs = group ? group.invoices : [];
  let totalInvoiced = 0, paid = 0, outstanding = 0, overdue = 0, drafts = 0, overdueCount = 0;
  invs.forEach((inv) => {
    const t = invoiceBreakdown(inv).total;
    totalInvoiced += t;
    // Recorded partial payments count as real money in, so paid/outstanding
    // reflect the actual balance. A status==="paid" invoice (with no payments)
    // still counts its full total as paid, exactly as before. An invoice fully
    // covered by payments contributes nothing to outstanding.
    const ps = paymentSummary(inv);
    if (inv.status === "paid") { paid += t; }
    else if (ps.hasPayments) { paid += ps.paidToDate; outstanding += ps.balanceDue; }
    else { outstanding += t; }
    if (inv.status === "draft") drafts += 1;
    // Overdue no longer applies once payments settle the invoice in full.
    if (isOverdue(inv) && !isFullyPaidByPayments(inv)) { overdue += ps.balanceDue > 0 ? ps.balanceDue : t; overdueCount += 1; }
  });
  return { cur, count: invs.length, totalInvoiced, paid, outstanding, overdue, overdueCount, drafts,
           paymentRate: totalInvoiced > 0 ? Math.round((paid / totalInvoiced) * 100) : 0 };
}

// ── Monthly series for the stat-card sparklines ─────────────────────────────
// Three parallel 12-bucket arrays (invoiced / paid / outstanding), one number
// per month, derived from the SAME currency group + month-key bucketing the
// income chart uses. Estimates are excluded (they never count as income).
// Returns arrays of plain numbers so buildSparkline can stay purely presentational.
function monthlySeries() {
  const groups = invoicesByCurrency();
  const group = groups.find((g) => g.code === insightsCurrency) || groups[0] || null;
  const invs = group ? group.invoices : [];
  const now = new Date();
  const nowKey = now.getFullYear() * 12 + now.getMonth();
  const buckets = [];
  for (let i = 11; i >= 0; i--) buckets.push({ key: nowKey - i, invoiced: 0, paid: 0, outstanding: 0 });
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  invs.forEach((inv) => {
    if (isEstimate(inv)) return;
    const mk = invoiceMonthKey(inv);
    if (mk == null || !byKey.has(mk)) return;
    const b = byKey.get(mk);
    const total = invoiceBreakdown(inv).total;
    const ps = paymentSummary(inv);
    b.invoiced += total;
    if (inv.status === "paid") { b.paid += total; }
    else if (ps.hasPayments) { b.paid += ps.paidToDate; b.outstanding += ps.balanceDue; }
    else { b.outstanding += total; }
  });
  return {
    invoiced: buckets.map((b) => b.invoiced),
    paid: buckets.map((b) => b.paid),
    outstanding: buckets.map((b) => b.outstanding),
  };
}

// Catmull-Rom → cubic-Bézier smoothing. Given an array of [x,y] points, returns
// an SVG path string ("M … C …") tracing a smooth curve through every point.
// Purely presentational; used by the stat-card sparklines and the income chart.
function smoothLinePath(pts, tension) {
  if (!pts || pts.length < 2) return "";
  if (pts.length === 2) {
    return "M" + pts[0][0].toFixed(2) + " " + pts[0][1].toFixed(2) +
           " L" + pts[1][0].toFixed(2) + " " + pts[1][1].toFixed(2);
  }
  const t = tension == null ? 1 : tension;
  let d = "M" + pts[0][0].toFixed(2) + " " + pts[0][1].toFixed(2);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * t;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * t;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * t;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * t;
    d += " C" + c1x.toFixed(2) + " " + c1y.toFixed(2) + " " +
         c2x.toFixed(2) + " " + c2y.toFixed(2) + " " +
         p2[0].toFixed(2) + " " + p2[1].toFixed(2);
  }
  return d;
}

// ── Inline-SVG sparkline (trend line + soft area fill) for a stat card ──────
// `hue` selects a token family (indigo / green / amber). Returns null when the
// series has no positive data so the caller can hide the sparkline gracefully.
function buildSparkline(series, hue) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const max = series.reduce((m, v) => Math.max(m, v), 0);
  if (max <= 0) return null; // no data → hide gracefully
  const NS = SVG_NS;
  const W = 96, H = 34, pad = 3;
  const n = series.length;
  const plotW = W - pad * 2, plotH = H - pad * 2;
  const baseY = pad + plotH;
  const xAt = (i) => pad + (plotW * i) / (n - 1);
  const yAt = (v) => baseY - (v / max) * plotH;
  const pts = series.map((v, i) => [xAt(i), yAt(v)]);
  // Smooth the polyline into a soft organic curve (Catmull-Rom → cubic Bézier),
  // matching the mockup's signature sparkline instead of angular zig-zags.
  const linePath = smoothLinePath(pts);
  const areaPath = smoothLinePath(pts) +
    " L" + pts[n - 1][0].toFixed(1) + " " + baseY.toFixed(1) +
    " L" + pts[0][0].toFixed(1) + " " + baseY.toFixed(1) + " Z";

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "sparkline spark-" + hue);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "linearGradient");
  const gid = "spk-" + hue + "-" + Math.random().toString(36).slice(2, 8);
  grad.setAttribute("id", gid);
  grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
  const s1 = document.createElementNS(NS, "stop");
  s1.setAttribute("offset", "0"); s1.setAttribute("stop-color", "currentColor"); s1.setAttribute("stop-opacity", ".28");
  const s2 = document.createElementNS(NS, "stop");
  s2.setAttribute("offset", "1"); s2.setAttribute("stop-color", "currentColor"); s2.setAttribute("stop-opacity", "0");
  grad.append(s1, s2); defs.appendChild(grad); svg.appendChild(defs);

  const area = document.createElementNS(NS, "path");
  area.setAttribute("d", areaPath); area.setAttribute("class", "spk-area");
  area.setAttribute("fill", `url(#${gid})`);
  svg.appendChild(area);

  const line = document.createElementNS(NS, "path");
  line.setAttribute("d", linePath); line.setAttribute("class", "spk-line");
  svg.appendChild(line);

  // Small dot on the final point for a finished, mockup-like feel.
  const last = pts[n - 1];
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", last[0].toFixed(1)); dot.setAttribute("cy", last[1].toFixed(1));
  dot.setAttribute("r", "2.2"); dot.setAttribute("class", "spk-dot");
  svg.appendChild(dot);

  return svg;
}

// Round a value up to a clean axis maximum (1 / 2 / 2.5 / 5 × 10ⁿ) so the
// y-axis tick labels read as tidy round numbers.
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 2.5) step = 2.5;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * mag;
}

// Compact currency for a chart axis: $0 / $500 / $1k / $1.5k / $12k.
// Uses the currency symbol from `money()` output but abbreviates the magnitude.
function compactAxisMoney(v, cur) {
  const sym = (cur && cur.symbol) || "$";
  const abs = Math.abs(v);
  let out;
  if (abs >= 1000) {
    const k = v / 1000;
    // Trim to at most one decimal, dropping a trailing ".0".
    out = (Math.round(k * 10) / 10).toString() + "k";
  } else {
    out = String(Math.round(v));
  }
  return sym + out;
}

// ── Inline-SVG income line/area chart (extends the createElementNS technique
//    already used by buildMonthlyChart). Derives from computeInsights().monthly. ──
function buildIncomeLineChart(monthly, cur) {
  const NS = SVG_NS;
  const n = monthly.length;
  const W = 640, H = 220;
  // Left gutter carries the y-axis value labels ($0 / $500 / $1k …).
  const padL = 46, padR = 10, padTop = 14, padBottom = 26;
  const plotW = W - padL - padR, plotH = H - padTop - padBottom;
  const rawMax = monthly.reduce((m, b) => Math.max(m, b.total), 0);
  const hasData = rawMax > 0;
  // Pick a "nice" per-rung step so every tick label is a round number
  // ($0 / $500 / $1k / $1.5k …) rather than an awkward third of the peak.
  const RUNGS = 3;
  const yStep = hasData ? niceCeil(rawMax / RUNGS) : 1;
  const maxTotal = yStep * RUNGS;
  const baseY = padTop + plotH;
  const xAt = (i) => padL + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yAt = (v) => baseY - (v / maxTotal) * plotH;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "line-chart" + (hasData ? "" : " lc-empty"));
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  const total = monthly.reduce((s, b) => s + b.total, 0);
  svg.setAttribute("aria-label", hasData
    ? `Income over the last ${n} months, ${cur.code}. Total ${money(total, cur)}.`
    : `No income to show yet for the last ${n} months.`);

  // Horizontal gridlines (4 rungs) + y-axis value labels at each rung.
  for (let g = 0; g <= RUNGS; g++) {
    const gy = padTop + (plotH * g) / RUNGS;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", padL); line.setAttribute("x2", W - padR);
    line.setAttribute("y1", gy.toFixed(1)); line.setAttribute("y2", gy.toFixed(1));
    line.setAttribute("class", "lc-grid");
    svg.appendChild(line);
    // Value label: top rung = maxTotal, bottom rung = 0.
    const val = maxTotal * (1 - g / RUNGS);
    const yLbl = document.createElementNS(NS, "text");
    yLbl.setAttribute("x", (padL - 8).toFixed(1));
    yLbl.setAttribute("y", (gy + 3.5).toFixed(1));
    yLbl.setAttribute("text-anchor", "end");
    yLbl.setAttribute("class", "lc-axis-label lc-y-label");
    yLbl.textContent = hasData ? compactAxisMoney(val, cur) : (g === RUNGS ? compactAxisMoney(0, cur) : "");
    svg.appendChild(yLbl);
  }

  // Empty state: faded axis + a centered "No income to show yet" caption, so the
  // card reads as an intentional zero state (not a broken flatline).
  if (!hasData) {
    const cap = document.createElementNS(NS, "text");
    cap.setAttribute("x", (padL + plotW / 2).toFixed(1));
    cap.setAttribute("y", (padTop + plotH / 2 + 4).toFixed(1));
    cap.setAttribute("text-anchor", "middle");
    cap.setAttribute("class", "lc-empty-caption");
    cap.textContent = "No income to show yet";
    svg.appendChild(cap);
    // Month labels still anchor the x-axis so the frame doesn't look empty.
    monthly.forEach((b, i) => {
      if (i % 2 === 0 || i === n - 1) {
        const label = document.createElementNS(NS, "text");
        label.setAttribute("x", xAt(i).toFixed(1));
        label.setAttribute("y", (baseY + 16).toFixed(1));
        label.setAttribute("text-anchor", i === 0 ? "start" : (i === n - 1 ? "end" : "middle"));
        label.setAttribute("class", "lc-axis-label");
        label.textContent = monthShortLabel(b);
        svg.appendChild(label);
      }
    });
    const wrap = el("div");
    wrap.appendChild(svg);
    return wrap;
  }

  // Points → area + line paths (smoothed to match the mockup's soft curve).
  const pts = monthly.map((b, i) => [xAt(i), yAt(b.total)]);
  const linePath = smoothLinePath(pts, 0.85);
  const areaPath = smoothLinePath(pts, 0.85) +
    " L" + pts[pts.length - 1][0].toFixed(2) + " " + baseY.toFixed(2) +
    " L" + pts[0][0].toFixed(2) + " " + baseY.toFixed(2) + " Z";

  // Gradient fill for the area — defined inline, colored via CSS tokens through
  // stop-color set from computed values so dark mode tracks the token.
  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "linearGradient");
  const gid = "lcGrad";
  grad.setAttribute("id", gid);
  grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
  const s1 = document.createElementNS(NS, "stop");
  s1.setAttribute("offset", "0"); s1.setAttribute("stop-color", "var(--chart-area-top)");
  const s2 = document.createElementNS(NS, "stop");
  s2.setAttribute("offset", "1"); s2.setAttribute("stop-color", "var(--chart-area-bottom)");
  grad.append(s1, s2); defs.appendChild(grad); svg.appendChild(defs);

  const area = document.createElementNS(NS, "path");
  area.setAttribute("d", areaPath); area.setAttribute("class", "lc-area");
  area.setAttribute("fill", `url(#${gid})`);
  svg.appendChild(area);

  const line = document.createElementNS(NS, "path");
  line.setAttribute("d", linePath); line.setAttribute("class", "lc-line");
  svg.appendChild(line);

  // Node markers at EVERY point (matching the mockup) + hover titles + month
  // labels (every other label to avoid crowding).
  monthly.forEach((b, i) => {
    {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", xAt(i).toFixed(1)); c.setAttribute("cy", yAt(b.total).toFixed(1));
      c.setAttribute("r", "3.2"); c.setAttribute("class", "lc-dot" + (b.total > 0 ? "" : " lc-dot-zero"));
      const title = document.createElementNS(NS, "title");
      title.textContent = `${monthFullLabel(b)}: ${money(b.total, cur)}`;
      c.appendChild(title);
      svg.appendChild(c);
    }
    if (i % 2 === 0 || i === n - 1) {
      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", xAt(i).toFixed(1));
      label.setAttribute("y", (baseY + 16).toFixed(1));
      label.setAttribute("text-anchor", i === 0 ? "start" : (i === n - 1 ? "end" : "middle"));
      label.setAttribute("class", "lc-axis-label");
      label.textContent = monthShortLabel(b);
      svg.appendChild(label);
    }
  });

  const wrap = el("div");
  wrap.appendChild(svg);
  return wrap;
}

// Time-of-day greeting derived from the LOCAL clock (accurate, no locale lib).
// Morning < 12:00, afternoon < 18:00, else evening.
function greetingForHour(h) {
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ── DASHBOARD ────────────────────────────────────────────────────────────
function renderDashboard(host) {
  const newInv = primaryBtn("+ New invoice", () => openEditor(null));
  // Split-button affordance from the mockup: a chevron caret sits at the trailing
  // edge of the "+ New invoice" control. It's decorative (the whole button opens
  // the editor) — an inline SVG, aria-hidden, no network.
  newInv.classList.add("split-primary");
  const caret = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  caret.setAttribute("viewBox", "0 0 24 24"); caret.setAttribute("aria-hidden", "true");
  caret.setAttribute("class", "split-caret");
  caret.setAttribute("fill", "none"); caret.setAttribute("stroke", "currentColor");
  caret.setAttribute("stroke-width", "2.4"); caret.setAttribute("stroke-linecap", "round");
  caret.setAttribute("stroke-linejoin", "round");
  const caretPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  caretPath.setAttribute("d", "M6 9l6 6 6-6");
  caret.appendChild(caretPath);
  newInv.appendChild(caret);
  // Plain "Dashboard" title (the time-based greeting was removed at Eden's request).
  const greetHead = pageHead("Dashboard", "Here's what's happening with your business today.", [newInv]);
  greetHead.classList.add("dash-greeting");
  host.appendChild(greetHead);

  // Move the recurring-prompt banner host into the dashboard so it shows here.
  const rp = $("#recurringPrompts");
  if (rp && rp.parentNode !== host) host.appendChild(rp);
  renderRecurringBanner();

  const t = bookTotals();
  const multiCur = invoicesByCurrency().length > 1;

  // Real monthly series (invoiced / paid / outstanding) for the stat-card
  // sparklines — derived from the same currency group + month-bucket math the
  // income chart uses, so the trend lines mirror the real book.
  const spark = monthlySeries();

  const stats = el("div", "stat-grid");
  stats.appendChild(statTile("file", "", "Total invoiced", money(t.totalInvoiced, t.cur), `${t.count} ${t.count === 1 ? "invoice" : "invoices"}`, spark.invoiced, "indigo"));
  stats.appendChild(statTile("fileCheck", "ok", "Paid", money(t.paid, t.cur), null, spark.paid, "green"));
  stats.appendChild(statTile("clock", "warn", "Outstanding", money(t.outstanding, t.cur), null, spark.outstanding, "amber"));
  host.appendChild(stats);
  if (multiCur) {
    const hint = txt("p", "muted", `Showing ${t.cur.code}. Your book spans multiple currencies — amounts are never mixed.`);
    hint.style.cssText = "margin:-10px 0 16px;";
    host.appendChild(hint);
  }

  const grid = el("div", "dash-grid");

  // Left: recent invoices.
  const recentPanel = el("div", "list-panel");
  const rHead = el("div", "dash-recent-head");
  rHead.appendChild(txt("h3", null, "Recent invoices"));
  rHead.appendChild(ghostBtn("View all →", () => goRoute("invoices")));
  recentPanel.appendChild(rHead);
  const recentBody = el("div", "dash-recent-list");
  const recent = state.invoices.filter((i) => !isEstimate(i)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  if (!recent.length) {
    const empty = el("div", "dash-recent-empty");
    const art = sparklyDocArt(); art.classList.add("dash-empty-art");
    empty.appendChild(art);
    empty.appendChild(txt("p", null, "No invoices yet"));
    empty.appendChild(txt("p", "muted", "Create your first one — it's saved right here on this device."));
    const cta = primaryBtn("+ Create invoice", () => openEditor(null));
    cta.style.marginTop = "12px";
    empty.appendChild(cta);
    recentBody.appendChild(empty);
  } else {
    recentBody.appendChild(buildDocTable(recent, false));
  }
  recentPanel.appendChild(recentBody);
  grid.appendChild(recentPanel);

  // Right column: income chart + quick actions.
  const rightCol = el("div");
  const chartPanel = el("div", "panel-card chart-panel");
  const cHead = el("div", "chart-panel-head");
  cHead.appendChild(txt("h3", null, "Income overview"));
  cHead.appendChild(txt("span", "muted", `Last 12 months · ${t.cur.code}`));
  chartPanel.appendChild(cHead);
  const groups = invoicesByCurrency();
  const group = groups.find((g) => g.code === (insightsCurrency || t.cur.code)) || groups[0] || null;
  const data = computeInsights(group ? group.invoices : []);
  chartPanel.appendChild(buildIncomeLineChart(data.monthly, t.cur));
  const totRow = el("div", "chart-total-row");
  totRow.appendChild(txt("span", "lbl", "Total income (12 mo)"));
  totRow.appendChild(txt("span", "val", money(data.monthly.reduce((s, b) => s + b.total, 0), t.cur)));
  chartPanel.appendChild(totRow);
  rightCol.appendChild(chartPanel);

  const qaPanel = el("div", "panel-card");
  qaPanel.style.marginTop = "18px";
  qaPanel.appendChild(txt("h3", null, "Quick actions"));
  const qa = el("div", "quick-actions"); qa.style.marginTop = "12px";
  qa.appendChild(quickAction("plus", "New invoice", "Create a new invoice", () => openEditor(null)));
  qa.appendChild(quickAction("doc", "New estimate", "Send a quote or estimate", () => openEditorAsEstimate()));
  qa.appendChild(quickAction("userPlus", "Add client", "Start an invoice for a client", () => goRoute("clients")));
  qa.appendChild(quickAction("chart", "View invoices", "See your full list", () => goRoute("invoices")));
  qaPanel.appendChild(qa);
  rightCol.appendChild(qaPanel);
  grid.appendChild(rightCol);
  host.appendChild(grid);

  // Two mini panels: top clients + payment rate (derived).
  const two = el("div", "dash-two");
  const clientsPanel = el("div", "panel-card");
  clientsPanel.appendChild(txt("h3", null, "Top clients by revenue"));
  const topWrap = el("div"); topWrap.style.marginTop = "14px";
  if (!data.topClients.length || data.topClients.every((c) => c.total <= 0)) {
    const empty = el("div", "dash-mini-empty");
    const art = sparklyClientArt(); art.classList.add("dash-empty-art");
    empty.appendChild(art);
    empty.appendChild(txt("p", null, "No clients yet"));
    empty.appendChild(txt("p", "muted", "Top clients by revenue will appear here once you bill someone."));
    topWrap.appendChild(empty);
  } else {
    const maxClient = data.topClients[0].total || 1;
    const list = el("div", "top-clients");
    data.topClients.forEach((c, i) => {
      const rowEl = el("div", "top-client-row");
      rowEl.appendChild(txt("div", "top-client-rank", String(i + 1)));
      const body = el("div", "top-client-body");
      const nameRow = el("div", "top-client-name-row");
      nameRow.appendChild(txt("span", "top-client-name", c.name));
      nameRow.appendChild(txt("span", "top-client-total", money(c.total, t.cur)));
      body.appendChild(nameRow);
      const track = el("div", "top-client-bar-track");
      const bar = el("div", "top-client-bar");
      bar.style.width = Math.max(2, Math.round((c.total / maxClient) * 100)) + "%";
      track.appendChild(bar); body.appendChild(track);
      rowEl.appendChild(body);
      list.appendChild(rowEl);
    });
    topWrap.appendChild(list);
  }
  clientsPanel.appendChild(topWrap);
  two.appendChild(clientsPanel);

  const rratePanel = el("div", "panel-card");
  rratePanel.appendChild(txt("h3", null, "Payment rate"));
  const rateWrap = el("div"); rateWrap.style.marginTop = "12px";
  rateWrap.appendChild(txt("div", "pay-rate-big", t.paymentRate + "%"));
  rateWrap.appendChild(txt("div", "pay-rate-sub", `${money(t.paid, t.cur)} paid of ${money(t.totalInvoiced, t.cur)} invoiced`));
  const rtrack = el("div", "pay-rate-track");
  const rfill = el("div", "pay-rate-fill"); rfill.style.width = Math.max(2, t.paymentRate) + "%";
  rtrack.appendChild(rfill); rateWrap.appendChild(rtrack);
  rratePanel.appendChild(rateWrap);
  two.appendChild(rratePanel);
  host.appendChild(two);

  // ── Invoice status breakdown (donut + legend) ──
  host.appendChild(buildInvoiceStatusCard());
}

// ── Invoice-status card: donut + legend by derived status ───────────────────
// Counts each invoice (estimates excluded) by its DISPLAYED status, collapsing
// "partial" into Sent (still-owed, not yet paid) so the four buckets match the
// mockup (Draft / Sent / Paid / Overdue). Inline-SVG donut, both themes.
function buildInvoiceStatusCard() {
  const panel = el("div", "panel-card status-card");
  panel.appendChild(txt("h3", null, "Invoice status"));
  const invs = state.invoices.filter((i) => !isEstimate(i));
  const buckets = [
    { key: "draft", label: "Draft", hue: "draft" },
    { key: "sent", label: "Sent", hue: "sent" },
    { key: "paid", label: "Paid", hue: "paid" },
    { key: "overdue", label: "Overdue", hue: "overdue" },
  ];
  const counts = { draft: 0, sent: 0, paid: 0, overdue: 0 };
  invs.forEach((inv) => {
    const st = displayStatus(inv);
    if (st === "paid") counts.paid += 1;
    else if (st === "overdue") counts.overdue += 1;
    else if (st === "draft") counts.draft += 1;
    else counts.sent += 1; // sent + partial → still-out
  });
  const total = invs.length;
  const body = el("div", "status-card-body");

  if (!total) {
    body.appendChild(txt("p", "muted", "No invoices yet — your status breakdown will appear here."));
    panel.appendChild(body);
    return panel;
  }

  // Donut.
  const NS = SVG_NS, size = 132, cx = size / 2, cy = size / 2, r = 52, sw = 18;
  const circ = 2 * Math.PI * r;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "status-donut");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label",
    `Invoice status: ${counts.draft} draft, ${counts.sent} sent, ${counts.paid} paid, ${counts.overdue} overdue.`);
  // Track ring.
  const track = document.createElementNS(NS, "circle");
  track.setAttribute("cx", cx); track.setAttribute("cy", cy); track.setAttribute("r", r);
  track.setAttribute("class", "status-donut-track");
  track.setAttribute("fill", "none"); track.setAttribute("stroke-width", sw);
  svg.appendChild(track);
  // Arc segments.
  let offset = 0;
  buckets.forEach((b) => {
    const val = counts[b.key];
    if (val <= 0) return;
    const frac = val / total;
    const seg = document.createElementNS(NS, "circle");
    seg.setAttribute("cx", cx); seg.setAttribute("cy", cy); seg.setAttribute("r", r);
    seg.setAttribute("class", "status-seg seg-" + b.hue);
    seg.setAttribute("fill", "none");
    seg.setAttribute("stroke-width", sw);
    seg.setAttribute("stroke-dasharray", `${(frac * circ).toFixed(2)} ${circ.toFixed(2)}`);
    seg.setAttribute("stroke-dashoffset", (-offset * circ).toFixed(2));
    seg.setAttribute("transform", `rotate(-90 ${cx} ${cy})`);
    svg.appendChild(seg);
    offset += frac;
  });
  // Center count.
  const cLabel = document.createElementNS(NS, "text");
  cLabel.setAttribute("x", cx); cLabel.setAttribute("y", cy - 2);
  cLabel.setAttribute("text-anchor", "middle"); cLabel.setAttribute("class", "status-donut-num");
  cLabel.textContent = String(total);
  svg.appendChild(cLabel);
  const cSub = document.createElementNS(NS, "text");
  cSub.setAttribute("x", cx); cSub.setAttribute("y", cy + 14);
  cSub.setAttribute("text-anchor", "middle"); cSub.setAttribute("class", "status-donut-sub");
  cSub.textContent = total === 1 ? "invoice" : "invoices";
  svg.appendChild(cSub);
  body.appendChild(svg);

  // Legend with counts + percentages.
  const legend = el("div", "status-legend");
  buckets.forEach((b) => {
    const val = counts[b.key];
    const pct = total ? Math.round((val / total) * 100) : 0;
    const row = el("div", "status-legend-row");
    const dot = el("span", "status-dot seg-" + b.hue);
    row.appendChild(dot);
    row.appendChild(txt("span", "status-legend-label", b.label));
    row.appendChild(txt("span", "status-legend-count", `${val} · ${pct}%`));
    legend.appendChild(row);
  });
  body.appendChild(legend);
  panel.appendChild(body);
  return panel;
}
function quickAction(iconName, title, sub, onClick) {
  const b = el("button", "quick-action"); b.type = "button"; b.onclick = onClick;
  const ico = el("div", "qa-icon"); ico.appendChild(icon(iconName));
  b.appendChild(ico);
  const body = el("div");
  body.appendChild(txt("div", "qa-title", title));
  body.appendChild(txt("div", "qa-sub", sub));
  b.appendChild(body);
  return b;
}
// Open a fresh draft already flipped to estimate (reuses openEditor + blankInvoice).
function openEditorAsEstimate() {
  editorReturnRoute = "estimates";
  openEditor(null);
  if (draft) { draft.docKind = "estimate"; markClean(); buildEditor(); }
}

// ── Document table (shared by Invoices / Estimates / Dashboard-recent) ──────
function buildDocTable(records, isEstimateList) {
  const scroll = el("div", "table-scroll");
  const table = el("table", "data-table");
  const thead = el("thead"); const htr = el("tr");
  const dueLbl = isEstimateList ? "Valid until" : "Due date";
  ["#", "Client", "Date", dueLbl, "Status", "Amount", ""].forEach((h, i) => {
    const th = el("th", i === 5 ? "num" : null);
    if (h) th.textContent = h;
    htr.appendChild(th);
  });
  thead.appendChild(htr); table.appendChild(thead);
  const tbody = el("tbody");
  records.forEach((inv) => tbody.appendChild(buildDocRow(inv, isEstimateList)));
  table.appendChild(tbody);
  scroll.appendChild(table);
  return scroll;
}
function buildDocRow(inv, isEstimateList) {
  const tr = el("tr");
  tr.tabIndex = 0;
  tr.setAttribute("role", "button");
  tr.setAttribute("aria-label", `Open ${docTitle(inv).toLowerCase()} ${docNumberLabel(inv)}`);
  const open = () => openEditorFromList(inv.id);
  tr.addEventListener("click", (e) => { if (!e.target.closest(".row-menu-btn")) open(); });
  tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });

  const st = displayStatus(inv);
  // # cell with a status-tinted doc icon.
  const cNum = el("td");
  const docWrap = el("div", "cell-doc");
  const dico = el("div", "doc-icon " + (st === "paid" ? "paid" : st === "sent" ? "sent" : st === "overdue" ? "overdue" : st === "partial" ? "partial" : ""));
  dico.appendChild(icon("file"));
  docWrap.appendChild(dico);
  const numCol = el("div");
  numCol.appendChild(txt("div", "doc-num", docNumberLabel(inv)));
  numCol.appendChild(txt("div", "doc-kind", isEstimate(inv) ? "Estimate" : "Invoice"));
  docWrap.appendChild(numCol);
  cNum.appendChild(docWrap);
  tr.appendChild(cNum);

  // Client.
  const cClient = el("td");
  cClient.appendChild(txt("div", "cell-client-name", inv.billTo.name || "No client name"));
  if (inv.billTo.email) cClient.appendChild(txt("div", "cell-client-sub", inv.billTo.email));
  tr.appendChild(cClient);

  // Date / due.
  tr.appendChild(txt("td", "cell-muted", fmtDate(inv.date) || "—"));
  tr.appendChild(txt("td", "cell-muted", fmtDate(inv.dueDate) || "—"));

  // Status pill.
  const cStat = el("td");
  cStat.appendChild(statusPill(st));
  tr.appendChild(cStat);

  // Amount. For an invoice with recorded payments, show the balance still due
  // beneath the grand total so the "Partially paid" state is legible at a glance.
  const cAmount = el("td", "num cell-amount");
  cAmount.appendChild(txt("div", "cell-amount-total", money(invoiceTotal(inv), inv.currency)));
  if (!isEstimate(inv)) {
    const ps = paymentSummary(inv);
    if (ps.hasPayments && ps.balanceDue > 0) {
      cAmount.appendChild(txt("div", "cell-amount-balance", money(ps.balanceDue, inv.currency) + " due"));
    }
  }
  tr.appendChild(cAmount);

  // Actions cell. Estimates get a clearly-labelled "Convert to invoice" button
  // right in the row (reinforcing the estimate→invoice relationship) alongside
  // the ⋯ menu; invoices just get the menu.
  const cAct = el("td", "actions-cell");
  if (isEstimate(inv)) {
    const conv = txt("button", "btn sm est-convert", "Convert to invoice");
    conv.type = "button";
    conv.setAttribute("aria-label", `Convert estimate ${docNumberLabel(inv)} to an invoice`);
    conv.addEventListener("click", (e) => { e.stopPropagation(); convertEstimateAndEdit(inv.id); });
    cAct.appendChild(conv);
  }
  const menuBtn = el("button", "row-menu-btn"); menuBtn.type = "button";
  menuBtn.setAttribute("aria-label", `Actions for ${docNumberLabel(inv)}`);
  menuBtn.appendChild(icon("dots"));
  menuBtn.addEventListener("click", (e) => { e.stopPropagation(); openRowMenu(inv, menuBtn); });
  cAct.appendChild(menuBtn);
  tr.appendChild(cAct);
  return tr;
}
// Open a document from a list, remembering the return route.
function openEditorFromList(id) {
  editorReturnRoute = currentRoute === "estimates" ? "estimates" : "invoices";
  openEditor(id);
}
// A tiny popover menu anchored under the row's ⋯ button. Rebuilt each open.
let openMenuEl = null;
function closeRowMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; document.removeEventListener("click", closeRowMenu); } }
function openRowMenu(inv, anchor) {
  closeRowMenu();
  const menu = el("div", "row-menu");
  menu.setAttribute("role", "menu");
  const mkItem = (label, danger, fn) => {
    const b = txt("button", "row-menu-item" + (danger ? " danger" : ""), label);
    b.type = "button"; b.setAttribute("role", "menuitem");
    b.onclick = (e) => { e.stopPropagation(); closeRowMenu(); fn(); };
    return b;
  };
  menu.appendChild(mkItem("Open", false, () => openEditorFromList(inv.id)));
  menu.appendChild(mkItem("Duplicate", false, () => duplicateAndEdit(inv.id)));
  if (isEstimate(inv)) menu.appendChild(mkItem("Convert to invoice", false, () => convertEstimateAndEdit(inv.id)));
  menu.appendChild(mkItem("Delete", true, () => {
    if (!confirm(`Delete ${docTitle(inv).toLowerCase()} ${docNumberLabel(inv)}? This can't be undone.`)) return;
    state.invoices = state.invoices.filter((i) => i.id !== inv.id);
    saveState(); renderHub();
  }));
  const r = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.right = (window.innerWidth - r.right) + "px";
  document.body.appendChild(menu);
  openMenuEl = menu;
  // Defer the outside-click listener so this same click doesn't immediately close it.
  setTimeout(() => document.addEventListener("click", closeRowMenu), 0);
}

// ── INVOICES / ESTIMATES LIST VIEW ─────────────────────────────────────────
let listSearch = { invoice: "", estimate: "" };
let listStatusFilter = { invoice: "all", estimate: "all" };
let listClientFilter = { invoice: "all", estimate: "all" };
let listPage = { invoice: 1, estimate: 1 };
const PAGE_SIZE = 10;

function recordsForKind(kind) {
  return state.invoices.filter((inv) => (kind === "estimate") === isEstimate(inv));
}
function renderListView(host, kind) {
  const isEst = kind === "estimate";
  // Tag the estimates view so its scoped amber styling (top rail, tinted header,
  // solid badges) applies — and never bleeds onto the invoices view.
  host.classList.toggle("estimates-view", isEst);
  const title = isEst ? "Estimates" : "Invoices";
  const sub = isEst ? "Create, manage, and track your estimates and quotes." : "Create, manage, and track all your invoices in one place.";
  const newBtn = primaryBtn(isEst ? "+ New estimate" : "+ New invoice", () => { if (isEst) openEditorAsEstimate(); else { editorReturnRoute = "invoices"; openEditor(null); } });
  host.appendChild(pageHead(title, sub, [newBtn]));

  const all = recordsForKind(kind);

  // Stat header (invoices show 5 tiles incl. Overdue + Drafts; estimates show a
  // lighter set — all derived, no avg-payment-time).
  const groups = invoicesByCurrency();
  const cur = (groups.find((g) => g.code === insightsCurrency) || groups[0] || { currency: DEFAULT_CURRENCY }).currency;
  if (!isEst) {
    const t = bookTotals();
    const stats = el("div", "stat-grid");
    stats.appendChild(statTile("file", "", "Total invoiced", money(t.totalInvoiced, t.cur), `${t.count} invoices`));
    stats.appendChild(statTile("fileCheck", "ok", "Paid", money(t.paid, t.cur), null));
    stats.appendChild(statTile("clock", "warn", "Outstanding", money(t.outstanding, t.cur), null));
    stats.appendChild(statTile("alert", "danger", "Overdue", money(t.overdue, t.cur), `${t.overdueCount} ${t.overdueCount === 1 ? "invoice" : "invoices"}`));
    stats.appendChild(statTile("draft", "neutral", "Drafts", String(t.drafts), null));
    host.appendChild(stats);
  } else {
    // Estimate tiles: count + total value + accepted-as-invoice count is net-new,
    // so keep to honest derivations: total estimates + their combined value + drafts.
    let value = 0, drafts = 0, sent = 0;
    all.forEach((e) => { value += invoiceBreakdown(e).total; if (e.status === "draft") drafts++; if (e.status === "sent") sent++; });
    const stats = el("div", "stat-grid");
    stats.appendChild(statTile("doc", "", "Estimates", String(all.length), null));
    stats.appendChild(statTile("clock", "warn", "Total value", money(value, cur), null));
    stats.appendChild(statTile("draft", "neutral", "Drafts", String(drafts), null));
    stats.appendChild(statTile("fileCheck", "ok", "Sent", String(sent), null));
    host.appendChild(stats);
  }

  // Filters bar: search + status + client.
  const bar = el("div", "filters-bar");
  const search = el("div", "filters-search");
  search.appendChild(icon("search"));
  const searchInput = el("input"); searchInput.type = "search";
  searchInput.placeholder = isEst ? "Search estimates…" : "Search invoices…";
  searchInput.value = listSearch[kind];
  searchInput.setAttribute("aria-label", `Search ${title.toLowerCase()} by client or number`);
  searchInput.addEventListener("input", () => { listSearch[kind] = searchInput.value; listPage[kind] = 1; rerenderList(kind); });
  search.appendChild(searchInput);
  bar.appendChild(search);

  const statusSel = filterSelect("Status", [["all", "All status"], ["draft", "Draft"], ["sent", "Sent"], ["paid", "Paid"]].concat(isEst ? [] : [["overdue", "Overdue"]]), listStatusFilter[kind], (v) => { listStatusFilter[kind] = v; listPage[kind] = 1; rerenderList(kind); });
  bar.appendChild(statusSel);

  const clientNames = [...new Set(all.map((r) => (r.billTo.name || "").trim()).filter(Boolean))].sort();
  const clientOpts = [["all", "All clients"]].concat(clientNames.map((n) => [n, n]));
  bar.appendChild(filterSelect("Client", clientOpts, listClientFilter[kind], (v) => { listClientFilter[kind] = v; listPage[kind] = 1; rerenderList(kind); }));
  host.appendChild(bar);

  // The table panel — rebuilt in place by rerenderList so filters/pagination
  // don't rebuild the whole page (and don't lose the search caret unnecessarily).
  const panel = el("div", "list-panel"); panel.id = "listPanel_" + kind;
  host.appendChild(panel);
  fillListPanel(panel, kind);
}
function filterSelect(label, opts, value, onChange) {
  const wrap = el("div", "filter-select");
  const id = "flt_" + label.toLowerCase() + "_" + Math.random().toString(36).slice(2, 6);
  const lab = txt("label", null, label); lab.setAttribute("for", id);
  wrap.appendChild(lab);
  const sel = el("select"); sel.id = id;
  opts.forEach(([v, l]) => { const o = txt("option", null, l); o.value = v; if (v === value) o.selected = true; sel.appendChild(o); });
  sel.onchange = () => onChange(sel.value);
  wrap.appendChild(sel);
  return wrap;
}
function filteredRecords(kind) {
  const q = listSearch[kind].trim().toLowerCase();
  const sf = listStatusFilter[kind];
  const cf = listClientFilter[kind];
  return recordsForKind(kind)
    .filter((inv) => {
      if (sf !== "all") {
        if (sf === "overdue") { if (!(displayStatus(inv) === "overdue")) return false; }
        else if (inv.status !== sf) return false;
      }
      if (cf !== "all" && (inv.billTo.name || "").trim() !== cf) return false;
      if (q && !matchesHubSearch(inv, q)) return false;
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
function fillListPanel(panel, kind) {
  panel.innerHTML = "";
  const isEst = kind === "estimate";
  const rows = filteredRecords(kind);
  const total = recordsForKind(kind).length;
  if (!rows.length) {
    const empty = el("div", "list-empty");
    const art = icon("invoiceArt"); art.classList.add("list-empty-art");
    art.setAttribute("width", "56"); art.setAttribute("height", "56");
    empty.appendChild(art);
    if (total === 0) {
      empty.appendChild(txt("p", null, isEst ? "No estimates yet" : "No invoices yet"));
      empty.appendChild(txt("p", "muted", "Create your first one — it's saved right here on this device."));
      const cta = primaryBtn(isEst ? "+ New estimate" : "+ New invoice", () => {
        if (isEst) openEditorAsEstimate();
        else { editorReturnRoute = "invoices"; openEditor(null); }
      });
      cta.classList.add("list-empty-cta");
      empty.appendChild(cta);
    } else {
      empty.appendChild(txt("p", null, "Nothing matches those filters"));
      empty.appendChild(txt("p", "muted", "Try a different search, status, or client."));
    }
    panel.appendChild(empty);
    return;
  }
  // Pagination.
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (listPage[kind] > pages) listPage[kind] = pages;
  const page = listPage[kind];
  const start = (page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);
  panel.appendChild(buildDocTable(pageRows, isEst));

  const foot = el("div", "table-foot");
  foot.appendChild(txt("div", "table-foot-info", `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length}`));
  if (pages > 1) {
    const pager = el("div", "pager");
    const prev = el("button"); prev.type = "button"; prev.appendChild(icon("chevL", 15));
    prev.setAttribute("aria-label", "Previous page"); prev.disabled = page <= 1;
    prev.onclick = () => { if (listPage[kind] > 1) { listPage[kind]--; fillListPanel(panel, kind); } };
    pager.appendChild(prev);
    for (let p = 1; p <= pages; p++) {
      const b = txt("button", p === page ? "active" : null, String(p)); b.type = "button";
      b.setAttribute("aria-label", `Page ${p}`);
      if (p === page) b.setAttribute("aria-current", "page");
      b.onclick = () => { listPage[kind] = p; fillListPanel(panel, kind); };
      pager.appendChild(b);
    }
    const next = el("button"); next.type = "button"; next.appendChild(icon("chevR", 15));
    next.setAttribute("aria-label", "Next page"); next.disabled = page >= pages;
    next.onclick = () => { if (listPage[kind] < pages) { listPage[kind]++; fillListPanel(panel, kind); } };
    pager.appendChild(next);
    foot.appendChild(pager);
  }
  panel.appendChild(foot);
}
function rerenderList(kind) {
  const panel = $("#listPanel_" + kind);
  if (panel) fillListPanel(panel, kind);
}

// ── CLIENTS ────────────────────────────────────────────────────────────────
let clientSearch = "";
let selectedClientKey = null; // name|email key of the client shown in the side panel
function clientKey(name, email) { return (name || "").trim().toLowerCase() + "|" + (email || "").trim().toLowerCase(); }
// Build the derived client roster: every saved client + every client that only
// appears on an invoice. Stats derived live from invoices (invoices only, not
// estimates — mirrors the money math elsewhere).
function deriveClients() {
  const map = new Map();
  const ensure = (name, email, address) => {
    const key = clientKey(name, email);
    if (!map.has(key)) map.set(key, { key, name: (name || "").trim(), email: (email || "").trim(), address: address || "", totalInvoiced: 0, outstanding: 0, paid: 0, invoices: [], currency: DEFAULT_CURRENCY, hasActivity: false });
    return map.get(key);
  };
  (state.clients || []).forEach((c) => ensure(c.name, c.email, c.address));
  state.invoices.forEach((inv) => {
    if (isEstimate(inv)) return; // estimates aren't billed income
    const name = (inv.billTo.name || "").trim();
    if (!name && !(inv.billTo.email || "").trim()) return;
    const rec = ensure(inv.billTo.name, inv.billTo.email, inv.billTo.address);
    const total = invoiceBreakdown(inv).total;
    rec.totalInvoiced += total;
    if (inv.status === "paid") rec.paid += total; else rec.outstanding += total;
    rec.invoices.push(inv);
    rec.currency = inv.currency || DEFAULT_CURRENCY;
    rec.hasActivity = true;
    if (!rec.address && inv.billTo.address) rec.address = inv.billTo.address;
  });
  return [...map.values()].sort((a, b) => b.totalInvoiced - a.totalInvoiced || a.name.localeCompare(b.name));
}
function renderClientsView(host) {
  const newBtn = primaryBtn("+ New client", () => showNewClientModal());
  host.appendChild(pageHead("Clients", "Everyone you invoice, with billing details and derived totals.", [newBtn]));

  const clients = deriveClients();
  const totalInvoiced = clients.reduce((s, c) => s + c.totalInvoiced, 0);
  const outstanding = clients.reduce((s, c) => s + c.outstanding, 0);
  const cur = clients.find((c) => c.hasActivity) ? clients.find((c) => c.hasActivity).currency : DEFAULT_CURRENCY;
  const withActivity = clients.filter((c) => c.hasActivity).length;

  const stats = el("div", "stat-grid");
  stats.appendChild(statTile("users", "", "Total clients", String(clients.length), null));
  stats.appendChild(statTile("fileCheck", "ok", "With invoices", String(withActivity), null));
  stats.appendChild(statTile("file", "neutral", "Total invoiced", money(totalInvoiced, cur), null));
  stats.appendChild(statTile("clock", "warn", "Outstanding", money(outstanding, cur), null));
  host.appendChild(stats);

  const layout = el("div", "clients-layout");
  const listCol = el("div");

  const bar = el("div", "filters-bar");
  const search = el("div", "filters-search");
  search.appendChild(icon("search"));
  const searchInput = el("input"); searchInput.type = "search"; searchInput.placeholder = "Search clients…";
  searchInput.value = clientSearch; searchInput.setAttribute("aria-label", "Search clients by name or email");
  searchInput.addEventListener("input", () => { clientSearch = searchInput.value; renderClientList(); });
  search.appendChild(searchInput);
  bar.appendChild(search);
  listCol.appendChild(bar);

  const panel = el("div", "list-panel"); panel.id = "clientListPanel";
  listCol.appendChild(panel);
  layout.appendChild(listCol);

  const sidePanel = el("div", "side-panel"); sidePanel.id = "clientSidePanel";
  layout.appendChild(sidePanel);
  host.appendChild(layout);

  // Default selection: first client with activity, else first client.
  if (!selectedClientKey || !clients.some((c) => c.key === selectedClientKey)) {
    selectedClientKey = clients.length ? clients[0].key : null;
  }
  renderClientList();
  renderClientDetail();
}
function renderClientList() {
  const panel = $("#clientListPanel");
  if (!panel) return;
  panel.innerHTML = "";
  const q = clientSearch.trim().toLowerCase();
  const clients = deriveClients().filter((c) => !q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
  if (!clients.length) {
    const empty = el("div", "list-empty");
    const art = icon("users"); art.classList.add("list-empty-art"); art.setAttribute("width", "56"); art.setAttribute("height", "56");
    empty.appendChild(art);
    empty.appendChild(txt("p", null, "No clients yet"));
    empty.appendChild(txt("p", "muted", "Add a client with “+ New client”, or bill someone on an invoice — either way they'll appear here."));
    panel.appendChild(empty);
    return;
  }
  const scroll = el("div", "table-scroll");
  const table = el("table", "data-table");
  const thead = el("thead"); const htr = el("tr");
  ["Client", "Email", "Total invoiced", "Outstanding"].forEach((h, i) => {
    const th = el("th", (i >= 2) ? "num" : null); th.textContent = h; htr.appendChild(th);
  });
  thead.appendChild(htr); table.appendChild(thead);
  const tbody = el("tbody");
  const cur0 = clients.find((c) => c.hasActivity) ? clients.find((c) => c.hasActivity).currency : DEFAULT_CURRENCY;
  clients.forEach((c) => {
    const tr = el("tr"); tr.tabIndex = 0; tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `View ${c.name || "client"}`);
    if (c.key === selectedClientKey) tr.classList.add("selected");
    const pick = () => { selectedClientKey = c.key; renderClientList(); renderClientDetail(); };
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    const cName = el("td");
    const wrap = el("div", "cell-doc");
    const av = el("div", "client-avatar"); av.textContent = initials(c.name);
    wrap.appendChild(av);
    wrap.appendChild(txt("div", "cell-client-name", c.name || "Unnamed client"));
    cName.appendChild(wrap); tr.appendChild(cName);
    tr.appendChild(txt("td", "cell-muted", c.email || "—"));
    tr.appendChild(txt("td", "num cell-amount", money(c.totalInvoiced, c.hasActivity ? c.currency : cur0)));
    tr.appendChild(txt("td", "num", money(c.outstanding, c.hasActivity ? c.currency : cur0)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); scroll.appendChild(table); panel.appendChild(scroll);
}

// Direct "add a client" path. Writes a sanitized client into state.clients (the
// SAME address book deriveClients() reads and the editor's saved-client picker
// offers), so no schema change is needed. De-dupes on name+email exactly like
// the invoice-save auto-append (doSave), so adding a client that already exists
// just selects them instead of creating a duplicate.
function showNewClientModal() {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal");
  modal.appendChild(txt("h3", null, "New client"));
  modal.appendChild(txt("p", "hint", "Saved to this device only — they'll be pickable when you bill an invoice."));

  const form = el("div", "client-form");
  const draftClient = { name: "", email: "", phone: "", address: "" };
  form.appendChild(field("Name", "", (v) => { draftClient.name = v; }));
  form.appendChild(field("Email", "", (v) => { draftClient.email = v; }));
  form.appendChild(field("Phone", "", (v) => { draftClient.phone = v; }));
  form.appendChild(field("Billing address", "", (v) => { draftClient.address = v; }, true));
  modal.appendChild(form);

  const msgHost = el("div"); msgHost.id = "newClientMsg";

  const close = () => { cleanup(); backdrop.remove(); };
  const actions = el("div", "pro-actions");
  const cancelBtn = txt("button", "btn ghost", "Cancel"); cancelBtn.type = "button";
  cancelBtn.onclick = close;
  const saveBtn = txt("button", "btn", "Add client"); saveBtn.type = "button";
  saveBtn.onclick = () => {
    const name = (draftClient.name || "").trim();
    if (!name) { status(msgHost, "A client needs a name.", "err"); return; }
    const email = (draftClient.email || "").trim();
    const phone = (draftClient.phone || "").trim();
    const address = (draftClient.address || "").trim();
    // De-dupe on name+email (case-insensitive), mirroring doSave's auto-append.
    const existing = state.clients.find((c) =>
      (c.name || "").trim().toLowerCase() === name.toLowerCase() &&
      (c.email || "").trim().toLowerCase() === email.toLowerCase());
    if (!existing) {
      state.clients.push({ name, email, phone, address });
      if (!saveState()) { status(msgHost, friendly(lastSaveError), "err"); return; }
    }
    selectedClientKey = clientKey(name, email);
    close();
    // Re-render the Clients view so the new client shows and is selected.
    const host = $("#view-clients");
    if (host) { host.innerHTML = ""; renderClientsView(host); }
  };
  actions.append(cancelBtn, saveBtn);
  modal.appendChild(actions);
  modal.appendChild(msgHost);

  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  const cleanup = makeDialog(backdrop, modal, close);
}

function renderClientDetail() {
  const panel = $("#clientSidePanel");
  if (!panel) return;
  panel.innerHTML = "";
  const client = deriveClients().find((c) => c.key === selectedClientKey);
  if (!client) {
    const empty = el("div", "side-panel-empty");
    empty.appendChild(icon("users"));
    empty.appendChild(txt("p", null, "Select a client to see their details."));
    panel.appendChild(empty);
    return;
  }
  const head = el("div", "side-panel-head");
  const av = el("div", "client-avatar"); av.textContent = initials(client.name);
  head.appendChild(av);
  const ht = el("div");
  ht.appendChild(txt("div", "sp-name", client.name || "Unnamed client"));
  ht.appendChild(txt("div", "sp-sub", client.hasActivity ? `${client.invoices.length} ${client.invoices.length === 1 ? "invoice" : "invoices"}` : "No invoices yet"));
  head.appendChild(ht);
  panel.appendChild(head);

  // Contact.
  const contact = el("section");
  contact.appendChild(txt("div", "sp-section-title", "Contact"));
  if (client.email) {
    const row = el("div", "sp-row"); row.appendChild(icon("mail", 15)); row.appendChild(txt("span", null, client.email));
    contact.appendChild(row);
  }
  if (!client.email && !client.address) contact.appendChild(txt("p", "muted", "No contact details on file yet."));
  panel.appendChild(contact);

  // Billing address.
  if (client.address) {
    const addr = el("section");
    addr.appendChild(txt("div", "sp-section-title", "Billing address"));
    addr.appendChild(txt("div", "sp-address", client.address));
    panel.appendChild(addr);
  }

  // Stats.
  const stats = el("section");
  stats.appendChild(txt("div", "sp-section-title", "Stats"));
  const cur = client.hasActivity ? client.currency : DEFAULT_CURRENCY;
  const addStat = (l, v) => { const r = el("div", "sp-stat-row"); r.appendChild(txt("span", "lbl", l)); r.appendChild(txt("span", "val", v)); stats.appendChild(r); };
  addStat("Total invoiced", money(client.totalInvoiced, cur));
  addStat("Paid", money(client.paid, cur));
  addStat("Outstanding", money(client.outstanding, cur));
  panel.appendChild(stats);

  // Recent invoices.
  if (client.invoices.length) {
    const recent = el("section");
    recent.appendChild(txt("div", "sp-section-title", "Recent invoices"));
    client.invoices.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).forEach((inv) => {
      const r = el("div", "sp-recent-row"); r.tabIndex = 0; r.setAttribute("role", "button");
      r.setAttribute("aria-label", `Open ${docNumberLabel(inv)}`);
      const open = () => openEditorFromList(inv.id);
      r.addEventListener("click", open);
      r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      const left = el("div");
      left.appendChild(txt("div", "num", docNumberLabel(inv)));
      left.appendChild(txt("div", "muted", fmtDate(inv.date)));
      r.appendChild(left);
      const right = el("div"); right.style.textAlign = "right";
      right.appendChild(txt("div", "amt", money(invoiceTotal(inv), inv.currency)));
      const p = statusPill(displayStatus(inv)); p.style.marginTop = "2px";
      right.appendChild(p);
      r.appendChild(right);
      recent.appendChild(r);
    });
    panel.appendChild(recent);
  }

  // "New invoice for this client" — pre-fills billTo (uses existing openEditor + blankInvoice).
  const cta = primaryBtn("+ New invoice for this client", () => {
    editorReturnRoute = "clients";
    openEditor(null);
    if (draft) {
      draft.billTo = { name: client.name, email: client.email, address: client.address };
      markClean(); buildEditor();
    }
  });
  cta.classList.remove("sm");
  panel.appendChild(cta);

  // Remove — only for a client that lives in the saved address book (state.clients).
  // A derived-only client (one that appears solely because it's on an invoice) has
  // no address-book entry to remove, so we don't offer delete for it.
  const savedIdx = state.clients.findIndex((c) =>
    clientKey(c.name, c.email) === client.key);
  if (savedIdx >= 0) {
    const rm = ghostBtn("Remove from address book", () => {
      if (!confirm(`Remove ${client.name || "this client"} from your saved clients? Invoices already billed to them are untouched.`)) return;
      state.clients.splice(savedIdx, 1);
      saveState();
      selectedClientKey = null;
      const host = $("#view-clients");
      if (host) { host.innerHTML = ""; renderClientsView(host); }
    });
    rm.classList.remove("sm");
    rm.style.marginTop = "10px";
    panel.appendChild(rm);
  }
}

// ── SETTINGS ─────────────────────────────────────────────────────────────
function renderSettingsView(host) {
  host.innerHTML = ""; // idempotent: clear first so in-place re-renders (theme toggle, logo add/remove) REPLACE the view instead of stacking duplicate controls
  host.appendChild(pageHead("Settings", "Customize Local Invoice to fit your workflow. Everything stays on your device.", []));
  const grid = el("div", "settings-grid");
  const leftCol = el("div");
  const rightCol = el("div");

  // ── Business profile (From) ──
  const biz = el("div", "settings-card");
  biz.appendChild(txt("h3", null, "Business profile"));
  biz.appendChild(txt("p", "settings-card-sub", "Your business information appears on invoices and estimates."));
  biz.appendChild(settingsField("Business name", state.business.name || "", (v) => { state.business.name = v; saveState(); }));
  biz.appendChild(settingsField("Email", state.business.email || "", (v) => { state.business.email = v; saveState(); }));
  biz.appendChild(settingsField("Address", state.business.address || "", (v) => { state.business.address = v; saveState(); }, true));
  // Logo (respects the Pro gate — reuses buildLogoField machinery via a settings draft).
  biz.appendChild(buildSettingsLogo());
  leftCol.appendChild(biz);

  // ── Defaults: currency, tax, numbering ──
  const defaults = el("div", "settings-card");
  defaults.appendChild(txt("h3", null, "Invoice defaults"));
  defaults.appendChild(txt("p", "settings-card-sub", "These prefill each new invoice and estimate."));
  const row = el("div", "settings-row");
  // Default currency.
  const curField = el("div", "field");
  curField.appendChild(txt("span", "field-label", "Default currency"));
  const curSel = el("select"); curSel.style.cssText = SELECT_CSS;
  curSel.setAttribute("aria-label", "Default currency");
  const curCode = (state.business.currency && state.business.currency.code) || DEFAULT_CURRENCY.code;
  CURRENCIES.forEach((c) => { const o = txt("option", null, `${c.code} (${c.symbol})`); o.value = c.code; if (c.code === curCode) o.selected = true; curSel.appendChild(o); });
  curSel.onchange = () => { state.business.currency = { ...(currencyByCode(curSel.value) || DEFAULT_CURRENCY) }; saveState(); };
  curField.appendChild(curSel);
  row.appendChild(curField);
  // Default tax rate.
  const taxField = el("div", "field");
  taxField.appendChild(txt("span", "field-label", "Default tax rate (%)"));
  const taxInput = el("input"); taxInput.inputMode = "decimal"; taxInput.value = safeNumber(state.business.taxRate);
  taxInput.setAttribute("aria-label", "Default tax rate (%)");
  taxInput.oninput = () => { state.business.taxRate = safeNumber(taxInput.value); saveState(); };
  taxField.appendChild(taxInput);
  row.appendChild(taxField);
  defaults.appendChild(row);
  const row2 = el("div", "settings-row");
  // Tax label.
  const labelField = el("div", "field");
  labelField.appendChild(txt("span", "field-label", "Tax label"));
  const labelInput = el("input"); labelInput.value = state.business.taxLabel || ""; labelInput.placeholder = "VAT / GST / Sales tax";
  labelInput.setAttribute("aria-label", "Tax label");
  labelInput.oninput = () => { state.business.taxLabel = labelInput.value; saveState(); };
  labelField.appendChild(labelInput);
  row2.appendChild(labelField);
  // Next invoice number.
  const numField = el("div", "field");
  numField.appendChild(txt("span", "field-label", "Next invoice number"));
  const numInput = el("input"); numInput.inputMode = "numeric"; numInput.value = safeNumber(state.nextNumber) || 1;
  numInput.setAttribute("aria-label", "Next invoice number");
  numInput.oninput = () => { const n = Math.max(1, Math.floor(safeNumber(numInput.value)) || 1); state.nextNumber = n; saveState(); };
  numField.appendChild(numInput);
  row2.appendChild(numField);
  defaults.appendChild(row2);
  leftCol.appendChild(defaults);

  // ── Appearance / theme (reuse the shipped light/dark toggle mechanism) ──
  const appearance = el("div", "settings-card");
  appearance.appendChild(txt("h3", null, "Appearance"));
  appearance.appendChild(txt("p", "settings-card-sub", "Choose how Local Invoice looks. Your invoice PDFs always print on light paper."));
  const seg = el("div", "theme-seg");
  seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Theme");
  [["light", "Light"], ["dark", "Dark"], ["system", "System"]].forEach(([val, lbl]) => {
    const b = txt("button", getThemePref() === val ? "active" : null, lbl); b.type = "button";
    b.setAttribute("aria-pressed", String(getThemePref() === val));
    b.onclick = () => { setTheme(val); renderSettingsView(host); };
    seg.appendChild(b);
  });
  appearance.appendChild(seg);
  rightCol.appendChild(appearance);

  // ── Data Vault (backup / restore / restore-with-code) ──
  const vault = el("div", "settings-card");
  vault.appendChild(txt("h3", null, "Data & backup"));
  vault.appendChild(txt("p", "settings-card-sub", IS_NATIVE ? "All your data lives on this device. Back it up or move it to another device." : "All your data lives on this device. Back it up or move it to another browser."));
  const vaultRow = el("div", "settings-vault-row");
  vaultRow.appendChild(ghostBtn("Back up your data", () => exportVault()));
  vaultRow.appendChild(ghostBtn("Restore from backup", () => { const vi = $("#vaultFileInput"); if (vi) vi.click(); }));
  vault.appendChild(vaultRow);
  const restoreRow = el("div"); restoreRow.style.marginTop = "12px";
  const restoreLink = txt("button", "restore-link", IS_NATIVE ? "Restore Purchases" : "Already bought Pro? Restore with a code"); restoreLink.type = "button";
  restoreLink.style.cssText = "text-align:left;width:auto;margin-top:0;";
  if (IS_NATIVE) {
    restoreLink.onclick = async () => {
      const prev = restoreLink.textContent;
      restoreLink.disabled = true; restoreLink.textContent = "Restoring…";
      let res;
      try { res = await Billing.restorePurchases(); }
      catch (e) { console.error("Local Invoice: restore threw", e); res = { ok: false }; }
      restoreLink.disabled = false; restoreLink.textContent = prev;
      if (res && res.ok) { refreshAfterProChange(); runPendingProIntent(); showVaultToast("Pro restored on this device."); }
      else { showVaultToast("No previous purchase found for this Apple Account."); }
    };
  } else {
    restoreLink.onclick = () => showRestoreEntryModal();
  }
  restoreRow.appendChild(restoreLink);
  vault.appendChild(restoreRow);
  rightCol.appendChild(vault);

  grid.append(leftCol, rightCol);
  host.appendChild(grid);
}
function settingsField(label, value, onChange, isTextarea) {
  const wrap = el("div", "field");
  wrap.appendChild(txt("span", "field-label", label));
  const input = isTextarea ? el("textarea") : el("input");
  input.setAttribute("aria-label", label); // the visible label is a span, not a <label> — name the control for AT
  input.value = value || "";
  input.addEventListener("input", () => onChange(input.value));
  wrap.appendChild(input);
  return wrap;
}
// Settings logo control — mirrors buildLogoField's Pro gate but writes straight
// to state.business.logo. Uses the SAME Billing.refreshProStatus + showProModal
// flow so the paywall behaves identically.
function buildSettingsLogo() {
  const wrap = el("div", "field logo-field");
  const labelRow = el("div", "field-label-row");
  labelRow.appendChild(txt("span", "field-label", "Logo"));
  labelRow.appendChild(txt("span", "pro-tag", "Pro"));
  wrap.appendChild(labelRow);
  const row = el("div", "logo-row");
  if (validLogo(state.business.logo)) {
    const img = el("img", "logo-thumb"); img.src = state.business.logo; img.alt = "Business logo";
    row.appendChild(img);
    const remove = ghostBtn("Remove", () => { state.business.logo = ""; saveState(); renderSettingsView($("#view-settings")); });
    row.appendChild(remove);
  } else {
    const upload = ghostBtn("Upload logo", null);
    upload.onclick = async () => {
      if (upload.disabled) return;
      upload.disabled = true; const label = upload.textContent; upload.textContent = "Checking…";
      let pro = false;
      try { pro = await Billing.refreshProStatus(); } catch (e) { console.error(e); pro = false; }
      if (reconcileProAccess()) return;
      upload.disabled = false; upload.textContent = label;
      if (pro) pickSettingsLogo();
      else { setPendingProIntent(() => { if (Billing.isPro()) pickSettingsLogo(); }); showProModal(); }
    };
    row.appendChild(upload);
  }
  wrap.appendChild(row);
  wrap.appendChild(txt("p", "field-hint", "Recommended: square PNG or JPG up to 2MB. Shown on your invoice PDFs with Pro."));
  return wrap;
}
function pickSettingsLogo() {
  const input = el("input"); input.type = "file"; input.accept = "image/png,image/jpeg";
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) { alert("That image is too large — please use one under 2MB."); return; }
    const reader = new FileReader();
    reader.onload = () => { state.business.logo = String(reader.result); saveState(); renderSettingsView($("#view-settings")); };
    reader.readAsDataURL(file);
  };
  input.click();
}

// ── Boot ─────────────────────────────────────────────────────────────────
$("#newInvoiceBtn").onclick = () => openEditor(null);
{ const upb = $("#unlockProTopbar"); if (upb) upb.onclick = () => { try { showProModal(); } catch (e) { console.error("Local Invoice: showProModal threw", e); } }; }
const insightsBtnBoot = $("#insightsBtn");
if (insightsBtnBoot) insightsBtnBoot.onclick = () => showInsights();
function goHome() {
  // The logo goes to the dashboard. From an open editor, guard unsaved changes
  // first (leaveEditor returns to the list it came from — the router then lets
  // the user navigate on), otherwise route straight to the dashboard.
  if (!$("#editor").classList.contains("hidden")) { leaveEditor(); return; }
  goRoute("dashboard");
}
$("#logo").onclick = goHome;
$("#logo").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); } });
// iOS has no restore CODE — Apple's "Restore Purchases" (paywall + Settings) is the
// only restore path there, so the footer code-entry link is web-only.
if (IS_NATIVE) $("#footerRestoreLink").style.display = "none";
else $("#footerRestoreLink").onclick = () => showRestoreEntryModal();
$("#footerLicenseLink").onclick = () => showLicenseCardModal();
$("#footerBackupBtn").onclick = () => exportVault();
const vaultInput = $("#vaultFileInput");
$("#footerRestoreBackupBtn").onclick = () => vaultInput.click();
vaultInput.onchange = () => {
  const f = vaultInput.files && vaultInput.files[0];
  vaultInput.value = ""; // allow re-picking the same file; the File object stays readable
  if (f) importVault(f);
};
initRouter(); // wire nav + hash router, then render the initial route (renders the hub internals)
maybeShowRecurringPrompts(); // scan recurring invoices; surface "time to bill again" prompts
updateFooterProLinks();
maybeShowLicenseNag();
renderUnlockProCard(); // seed the sidebar "Unlock Pro" door (removes itself for owners)

// ── Boot entitlement check (item 1) ────────────────────────────────────────
// Only browsers that MIGHT already own Pro make a billing network call at boot
// (shouldCheckAtBoot() is false for a brand-new visitor, so fresh loads still make
// ZERO billing calls). This recovers the "paid then closed the tab too early" case.
// After it lands, re-sync any gated UI and — if Pro but no restore code — show the
// self-heal banner so they can create one for other devices.
(async function bootProCheck() {
  try {
    if (Billing.shouldCheckAtBoot && Billing.shouldCheckAtBoot()) {
      await Billing.refreshProStatus();
      // Reconcile FIRST: on a verified revocation this fires the one-time
      // access-stop notice and already calls refreshAfterProChange(), so we
      // don't double-refresh. Otherwise re-sync gated UI as before.
      if (!reconcileProAccess()) refreshAfterProChange();
    } else {
      // No boot billing call (brand-new visitor) — still seed was_pro from the
      // cached truth so a first-ever refund is detectable, but never trigger the
      // access-stop path here (isPro() here isn't a fresh verified answer).
      try { if (Billing.isPro() && !wasPro()) setWasPro(true); } catch (e) { console.error(e); }
    }
  } catch (e) {
    console.error("Local Invoice: boot Pro check failed", e);
  }
  try { updateSelfHealNag(); } catch (e) { console.error(e); }
})();


/* Offline support (progressive enhancement): register the service worker ONLY
   on the real https web deployment. Never in the Capacitor native shell
   (localhost) or local dev, where assets already load offline and a SW could
   interfere. Fails silently. */
(function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  var h = location.hostname;
  var webOK = location.protocol === "https:" && h !== "localhost" && h !== "127.0.0.1" && !h.endsWith(".local");
  if (!webOK) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
})();

// ── QR deep-link restore (?restore=CODE) ───────────────────────────────────
// The license card's QR encodes https://localinvoiceapp.com/?restore=<code> so a
// phone camera scan opens the app and restores Pro in one step (a bare-text QR
// would just land the user in a web search). Handle the param once, then scrub
// it from the URL and history — the code is a secret and shouldn't linger there.
(async () => {
  let code = null;
  try { code = new URLSearchParams(location.search).get("restore"); } catch (e) {}
  if (!code || !code.trim()) return;
  try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
  const normalized = formatRestoreCode(code);
  const proceed = async () => {
    let res;
    try { res = await Billing.restoreWithCode(normalized); }
    catch (e) { res = { ok: false }; }
    if (res && res.ok) {
      updateFooterProLinks();
      updateSelfHealNag();
      proToast("Welcome back — Pro is unlocked on this device.");
      refreshAfterProChange();
    } else {
      // Couldn't restore from the scan (offline, refunded, or an odd code) — open
      // the restore modal prefilled so the user can see the code and retry.
      showRestoreEntryModal();
      const inp = document.querySelector(".restore-code-input");
      if (inp) inp.value = normalized || String(code).trim();
    }
  };
  // A successful restore ADOPTS the scanned identity: rememberIdentity() overwrites
  // the stored code, and the boot nag stays quiet because code_ack is already set —
  // so opening someone else's link would silently and permanently discard this
  // device's own code. If a DIFFERENT code is already saved here, ask before
  // switching. Re-scanning your own card (same code) stays one-step seamless.
  let existing = null;
  try { existing = Billing.getRestoreCode(); } catch (e) {}
  if (existing && existing !== normalized) {
    const backdrop = el("div", "modal-backdrop");
    const modal = el("div", "modal pro-modal");
    let cleanup = () => {};
    const close = () => { cleanup(); backdrop.remove(); };
    modal.appendChild(txt("h3", null, "Keep your current Pro code?"));
    modal.appendChild(txt("p", "hint", "This device already has a Pro code saved:"));
    const box = el("div", "restore-code-box");
    box.appendChild(txt("div", "restore-code-value", existing));
    modal.appendChild(box);
    modal.appendChild(txt("p", "hint",
      "The link you opened restores a different code. Switching replaces the code saved on this device — if you haven't saved your license card, the current code can't be recovered here."));
    const keepBtn = txt("button", "btn big", "Keep my current code"); keepBtn.type = "button";
    keepBtn.onclick = close;
    const switchBtn = txt("button", "btn ghost", "Switch to the new code"); switchBtn.type = "button";
    switchBtn.onclick = () => { close(); proceed(); };
    const actions = el("div", "pro-actions"); actions.append(keepBtn, switchBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    document.body.appendChild(backdrop);
    cleanup = makeDialog(backdrop, modal, close); // role/aria-modal, focus-in, Tab-trap, Esc, focus restore
    return;
  }
  await proceed();
})();
