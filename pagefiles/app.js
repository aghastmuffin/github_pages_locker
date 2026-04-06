const state = {
  uuid: "",
  quiz: null,
  questions: [],
  idx: 0,
  answers: [],
  submitted: [],
  grades: [],
  manifest: null,
  timerStartMs: 0,
  timerTickId: null,
  finalElapsedMs: 0,
  lastResult: null,
  pendingDraft: null,
  saveEnabled: true,
  instructorOverviewEnabled: true,
};

const el = {
  resumeScreen: document.getElementById("resume-screen"),
  resumeSummary: document.getElementById("resume-summary"),
  resumeLoadBtn: document.getElementById("resume-load-btn"),
  resumeDiscardBtn: document.getElementById("resume-discard-btn"),
  loaderScreen: document.getElementById("loader-screen"),
  quizScreen: document.getElementById("quiz-screen"),
  resultScreen: document.getElementById("result-screen"),
  uuidInput: document.getElementById("uuid-input"),
  loadBtn: document.getElementById("load-btn"),
  sampleBtn: document.getElementById("sample-btn"),
  userSessionCode: document.getElementById("user-session-code"),
  saveToggle: document.getElementById("save-toggle"),
  instructorOverviewToggle: document.getElementById("instructor-overview-toggle"),
  instructorOverviewLink: document.getElementById("instructor-overview-link"),
  loadSavedBtn: document.getElementById("load-saved-btn"),
  loaderError: document.getElementById("loader-error"),
  pickerStatus: document.getElementById("picker-status"),
  testPicker: document.getElementById("test-picker"),
  quizTitle: document.getElementById("quiz-title"),
  timerPill: document.getElementById("timer-pill"),
  progressPill: document.getElementById("progress-pill"),
  questionTracker: document.getElementById("question-tracker"),
  article: document.getElementById("article"),
  question: document.getElementById("question"),
  choiceWrap: document.getElementById("choice-wrap"),
  writeWrap: document.getElementById("write-wrap"),
  writeInput: document.getElementById("write-input"),
  prevBtn: document.getElementById("prev-btn"),
  saveDraftBtn: document.getElementById("save-draft-btn"),
  saveStatus: document.getElementById("save-status"),
  nextBtn: document.getElementById("next-btn"),
  resultUuid: document.getElementById("result-uuid"),
  rightCount: document.getElementById("right-count"),
  wrongCount: document.getElementById("wrong-count"),
  percentLine: document.getElementById("percent-line"),
  resultTime: document.getElementById("result-time"),
  reviewList: document.getElementById("review-list"),
  continueBtn: document.getElementById("continue-btn"),
  restartBtn: document.getElementById("restart-btn"),
  pdfBtn: document.getElementById("pdf-btn"),
  homeBtns: document.querySelectorAll("[data-go-home]"),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_STORAGE_KEY = "QUIZ_APP_DRAFT_V1";
const SAVE_PREF_KEY = "QUIZ_APP_SAVE_PREF_V1";
const INSTRUCTOR_OVERVIEW_PREF_KEY = "QUIZ_APP_INSTRUCTOR_OVERVIEW_PREF_V1";
const MODULE_TYPE_ORDER = { english: 0, math: 1 };
const LOG_SESSION_KEY = "QUIZ_APP_LOG_SESSION_V1";
const LOG_SUPABASE_URL = "https://cahitfvxroazudhoiixa.supabase.co";
const LOG_SUPABASE_ANON_KEY = "sb_publishable_XYm-dyC0_ny5NtpTSltLKA_ptuSD9TV";
const SHORT_SESSION_ID_RE = /^[A-Z0-9]{3}$/;
const activityLogger = {
  client: null,
  sessionId: "",
};

function setScreen(name) {
  el.resumeScreen.classList.toggle("hidden", name !== "resume");
  el.loaderScreen.classList.toggle("hidden", name !== "loader");
  el.quizScreen.classList.toggle("hidden", name !== "quiz");
  el.resultScreen.classList.toggle("hidden", name !== "result");
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setSaveStatus(message = "") {
  if (!el.saveStatus) return;
  el.saveStatus.textContent = message;
}

function updateTimerPill(elapsedMs = 0) {
  if (!el.timerPill) return;
  el.timerPill.textContent = `Time ${formatDuration(elapsedMs)}`;
}

function startTimer() {
  if (state.timerTickId) {
    clearInterval(state.timerTickId);
    state.timerTickId = null;
  }

  state.timerStartMs = Date.now();
  state.finalElapsedMs = 0;
  updateTimerPill(0);

  state.timerTickId = window.setInterval(() => {
    updateTimerPill(Date.now() - state.timerStartMs);
  }, 1000);
}

function stopTimer() {
  if (state.timerTickId) {
    clearInterval(state.timerTickId);
    state.timerTickId = null;
  }

  if (state.timerStartMs > 0) {
    state.finalElapsedMs = Date.now() - state.timerStartMs;
    updateTimerPill(state.finalElapsedMs);
    return state.finalElapsedMs;
  }

  updateTimerPill(0);
  return 0;
}

function resetTimer() {
  if (state.timerTickId) {
    clearInterval(state.timerTickId);
    state.timerTickId = null;
  }
  state.timerStartMs = 0;
  state.finalElapsedMs = 0;
  updateTimerPill(0);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeTestType(value) {
  const type = String(value || "").toLowerCase();
  if (type === "english" || type === "math") {
    return type;
  }
  return "";
}

function normalizeManifestLabel(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  const marker = text.match(/\s+(English|Math):\s+Module\s+1/i);
  if (marker && typeof marker.index === "number" && marker.index > 0) {
    return text.slice(0, marker.index).trim();
  }

  return text;
}

function manifestItems() {
  if (!state.manifest || !Array.isArray(state.manifest.items)) {
    return [];
  }
  return state.manifest.items;
}

function compareManifestModules(a, b) {
  const typeA = normalizeTestType(a && a.test_type);
  const typeB = normalizeTestType(b && b.test_type);
  const orderA = MODULE_TYPE_ORDER[typeA] ?? 99;
  const orderB = MODULE_TYPE_ORDER[typeB] ?? 99;
  if (orderA !== orderB) return orderA - orderB;

  const moduleA = Number(a && a.module);
  const moduleB = Number(b && b.module);
  const safeModuleA = Number.isFinite(moduleA) ? moduleA : 999;
  const safeModuleB = Number.isFinite(moduleB) ? moduleB : 999;
  if (safeModuleA !== safeModuleB) return safeModuleA - safeModuleB;

  return String((a && a.uuid) || "").localeCompare(String((b && b.uuid) || ""));
}

function findManifestItemByUuid(uuid) {
  const needle = String(uuid || "").toLowerCase();
  if (!needle) return null;
  return manifestItems().find((item) => String(item.uuid || "").toLowerCase() === needle) || null;
}

function getNextModuleUuid(currentUuid) {
  const current = findManifestItemByUuid(currentUuid);
  if (!current) return "";

  const currentLabel = normalizeManifestLabel(current.label);
  if (!currentLabel) return "";

  const ordered = manifestItems()
    .filter((item) => normalizeManifestLabel(item.label) === currentLabel)
    .sort(compareManifestModules);

  const currentIndex = ordered.findIndex(
    (item) => String(item.uuid || "").toLowerCase() === String(current.uuid || "").toLowerCase(),
  );
  if (currentIndex < 0 || currentIndex >= ordered.length - 1) {
    return "";
  }

  return String(ordered[currentIndex + 1].uuid || "");
}

function setContinueButtonTarget(nextUuid) {
  if (!el.continueBtn) return;

  const uuid = String(nextUuid || "").trim();
  const valid = UUID_RE.test(uuid);
  el.continueBtn.classList.toggle("hidden", !valid);
  el.continueBtn.disabled = !valid;
  el.continueBtn.dataset.nextUuid = valid ? uuid : "";
}

function answerHasValue(answer) {
  return Boolean(answer && typeof answer.value === "string" && answer.value.trim() !== "");
}

function hasUnfinishedProgress() {
  if (!state.quiz || state.questions.length === 0) {
    return false;
  }
  if (state.lastResult) {
    return false;
  }

  const touchedAnswer = state.answers.some((answer) => answerHasValue(answer));
  const touchedSubmission = state.submitted.some(Boolean);
  return touchedAnswer || touchedSubmission || state.idx > 0;
}

function readSavePreference() {
  const raw = localStorage.getItem(SAVE_PREF_KEY);
  if (raw === "0") return false;
  if (raw === "1") return true;
  return true;
}

function writeSavePreference(enabled) {
  localStorage.setItem(SAVE_PREF_KEY, enabled ? "1" : "0");
}

function readInstructorOverviewPreference() {
  const raw = localStorage.getItem(INSTRUCTOR_OVERVIEW_PREF_KEY);
  if (raw === "0") return false;
  if (raw === "1") return true;
  return true;
}

function writeInstructorOverviewPreference(enabled) {
  localStorage.setItem(INSTRUCTOR_OVERVIEW_PREF_KEY, enabled ? "1" : "0");
}

function syncInstructorOverviewControls() {
  if (el.instructorOverviewToggle) {
    el.instructorOverviewToggle.checked = state.instructorOverviewEnabled;
  }

  if (el.instructorOverviewLink) {
    el.instructorOverviewLink.classList.toggle("hidden", !state.instructorOverviewEnabled);
    el.instructorOverviewLink.setAttribute("aria-disabled", state.instructorOverviewEnabled ? "false" : "true");
    el.instructorOverviewLink.tabIndex = state.instructorOverviewEnabled ? 0 : -1;
  }
}

function setInstructorOverviewEnabled(enabled, options = {}) {
  const persist = options.persist !== false;
  state.instructorOverviewEnabled = Boolean(enabled);

  if (persist) {
    writeInstructorOverviewPreference(state.instructorOverviewEnabled);
  }

  syncInstructorOverviewControls();
}

function readStoredDraft() {
  if (!state.saveEnabled) {
    return null;
  }

  const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const draft = JSON.parse(raw);
    if (!draft || draft.version !== 1 || !UUID_RE.test(String(draft.uuid || ""))) {
      return null;
    }
    return draft;
  } catch (_err) {
    return null;
  }
}

function clearStoredDraft() {
  localStorage.removeItem(DRAFT_STORAGE_KEY);
  state.pendingDraft = null;
}

function updateSavedDraftButtons() {
  if (!el.loadSavedBtn) return;
  if (!state.saveEnabled) {
    el.loadSavedBtn.classList.add("hidden");
    return;
  }
  const draft = readStoredDraft();
  el.loadSavedBtn.classList.toggle("hidden", !draft);
}

function syncSaveControls() {
  if (el.saveToggle) {
    el.saveToggle.checked = state.saveEnabled;
  }

  if (el.saveDraftBtn) {
    el.saveDraftBtn.disabled = !state.saveEnabled;
    el.saveDraftBtn.title = state.saveEnabled ? "" : "Enable test saving to store progress";
  }
}

function setSaveEnabled(enabled, options = {}) {
  const persist = options.persist !== false;
  const clearDraft = options.clearDraft !== false;
  state.saveEnabled = Boolean(enabled);

  if (persist) {
    writeSavePreference(state.saveEnabled);
  }

  if (!state.saveEnabled && clearDraft) {
    clearStoredDraft();
  }

  syncSaveControls();
  updateSavedDraftButtons();

  if (!state.saveEnabled) {
    setSaveStatus("Test saving is off.");
  } else if (el.saveStatus && el.saveStatus.textContent === "Test saving is off.") {
    setSaveStatus("");
  }
}

function writeCurrentDraft() {
  if (!state.saveEnabled) {
    return false;
  }

  if (!hasUnfinishedProgress()) {
    clearStoredDraft();
    updateSavedDraftButtons();
    return false;
  }

  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    uuid: state.uuid,
    idx: state.idx,
    answers: state.answers,
    submitted: state.submitted,
  };

  localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  state.pendingDraft = payload;
  updateSavedDraftButtons();
  return true;
}

function saveDraftWithStatus(prefix = "Progress saved") {
  const saved = writeCurrentDraft();
  if (!saved) {
    if (!state.saveEnabled) {
      setSaveStatus("Test saving is off.");
    } else {
      setSaveStatus("");
    }
    return false;
  }

  const stamp = new Date().toLocaleTimeString();
  setSaveStatus(`${prefix} at ${stamp}`);
  return true;
}

function showResumeSummary(draft) {
  if (!el.resumeSummary) return;

  if (!draft) {
    el.resumeSummary.textContent = "We found saved answers from a previous session.";
    return;
  }

  const when = draft.savedAt ? new Date(draft.savedAt) : null;
  const savedText = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : "an earlier time";
  el.resumeSummary.textContent = `Saved test ${draft.uuid} from ${savedText}.`;
}

function normalize(str) {
  return String(str || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function acceptedWriteAnswers(correct) {
  return String(correct || "")
    .split(",")
    .map((s) => normalize(s))
    .filter(Boolean);
}

function setError(msg) {
  el.loaderError.textContent = msg;
  el.loaderError.classList.toggle("hidden", !msg);
}

function generateShortSessionId() {
  return Math.random().toString(36).slice(2, 5).toUpperCase();
}

function getOrCreateLogSessionId() {
  if (activityLogger.sessionId) {
    return activityLogger.sessionId;
  }

  let sessionId = "";
  try {
    sessionId = String(localStorage.getItem(LOG_SESSION_KEY) || "").trim();
    if (!SHORT_SESSION_ID_RE.test(sessionId)) {
      sessionId = generateShortSessionId();
      localStorage.setItem(LOG_SESSION_KEY, sessionId);
    }
  } catch (_err) {
    sessionId = generateShortSessionId();
  }

  activityLogger.sessionId = sessionId;
  return sessionId;
}

function syncUserSessionCode() {
  if (!el.userSessionCode) return;
  const sessionId = getOrCreateLogSessionId();
  el.userSessionCode.textContent = `Your user code: ${sessionId} (share this with your instructor)`;
}

function currentQuestionRef() {
  const typedUuid = String((el.uuidInput && el.uuidInput.value) || "").trim();
  const testId = String(state.uuid || typedUuid || "unknown").trim() || "unknown";
  const questionNumber = state.questions.length > 0 ? state.idx + 1 : 0;
  return `${testId}#${questionNumber}`;
}

function describeButtonForLog(button) {
  const id = String(button.id || "").trim();
  const text = String(button.textContent || "").replace(/\s+/g, " ").trim();
  if (id && text) return `${id}:${text}`;
  if (id) return id;
  return text || "button";
}

function safeLogEvent(type, value, questionRef = currentQuestionRef()) {
  try {
    const client = activityLogger.client;
    if (!client) return;

    client
      .from("events")
      .insert({
        session_id: getOrCreateLogSessionId(),
        type: String(type || "event"),
        value: String(value ?? ""),
        question_id: String(questionRef || currentQuestionRef()),
      })
      .then(() => {})
      .catch(() => {});
  } catch (_err) {
    // Logging must never block or break quiz UX.
  }
}

async function initActivityLogger() {
  try {
    const supabaseModule = await import("https://esm.sh/@supabase/supabase-js@2");
    activityLogger.client = supabaseModule.createClient(LOG_SUPABASE_URL, LOG_SUPABASE_ANON_KEY);
  } catch (_err) {
    activityLogger.client = null;
  }
}

let MQ_STATIC = undefined;

function cleanDisplayText(text) {
  let out = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ");

  // The source questionbank includes CP1252-decoded UTF-8 artifacts like "â" and "Ã©".
  // Attempt to re-decode those sequences before stripping characters.
  if (/[ÃÂâ]/.test(out)) {
    try {
      out = decodeURIComponent(escape(out));
    } catch (_err) {
      // Leave text as-is when conversion is not valid.
    }
  }

  return out
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, "")
    .replace(/\u00A0/g, " ");
}

function cleanLatex(latex) {
  return cleanDisplayText(latex)
    .trim();
}

function isIgnorableArtifactNode(node) {
  if (!node) return false;

  if (node.nodeType === Node.TEXT_NODE) {
    return !cleanDisplayText(node.nodeValue || "").trim();
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.tagName === "BR") {
      return true;
    }

    if (/^(SPAN|EM|I|B|STRONG|U|SMALL|FONT)$/.test(node.tagName)) {
      return !cleanDisplayText(node.textContent || "").trim();
    }
  }

  return false;
}

function stripMqNeighborArtifacts(root) {
  const nodes = root.querySelectorAll(".mq-math-mode");
  nodes.forEach((node) => {
    // Strip ignorable siblings that some sources append after MathQuill markup.
    let next = node.nextSibling;
    while (isIgnorableArtifactNode(next)) {
      const doomed = next;
      next = next.nextSibling;
      doomed.remove();
    }

    // Strip ignorable trailing children that MathQuill can inject inside the span.
    let last = node.lastChild;
    while (isIgnorableArtifactNode(last)) {
      const doomed = last;
      last = doomed.previousSibling;
      doomed.remove();
    }
  });
}

function dedupeAdjacentMathSpans(root) {
  const nodes = Array.from(root.querySelectorAll(".mq-math-mode"));
  nodes.forEach((node) => {
    if (!node.isConnected) {
      return;
    }

    const latex = cleanLatex(node.getAttribute("latex-data") || node.dataset.latexData || "");
    if (!latex) {
      return;
    }

    let prev = node.previousSibling;
    while (isIgnorableArtifactNode(prev)) {
      prev = prev.previousSibling;
    }

    if (!prev || prev.nodeType !== Node.ELEMENT_NODE || !prev.classList.contains("mq-math-mode")) {
      return;
    }

    const prevLatex = cleanLatex(prev.getAttribute("latex-data") || prev.dataset.latexData || "");
    const sameBlockType = node.classList.contains("mq-block") === prev.classList.contains("mq-block");

    if (sameBlockType && prevLatex && prevLatex === latex) {
      node.remove();
    }
  });
}

function getEquationOnlyBlockLatex(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const mathNodes = node.querySelectorAll(".mq-math-mode");
  if (mathNodes.length !== 1) {
    return "";
  }

  const mathNode = mathNodes[0];
  const latex = cleanLatex(mathNode.getAttribute("latex-data") || mathNode.dataset.latexData || "");
  if (!latex) {
    return "";
  }

  const clone = node.cloneNode(true);
  clone.querySelectorAll(".mq-math-mode").forEach((el) => el.remove());
  const residual = cleanDisplayText(clone.textContent || "").replace(/\s+/g, "");
  return residual ? "" : latex;
}

function isIgnorableContainerElement(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  if (node.querySelector(".mq-math-mode")) {
    return false;
  }

  const text = cleanDisplayText(node.textContent || "").replace(/\s+/g, "");
  return !text;
}

function collapseDuplicateEquationBlocks(root) {
  const blocks = Array.from(root.querySelectorAll("p,div"));
  blocks.forEach((block) => {
    if (!block.isConnected) {
      return;
    }

    const latex = getEquationOnlyBlockLatex(block);
    if (!latex) {
      return;
    }

    let next = block.nextElementSibling;
    while (next && isIgnorableContainerElement(next)) {
      const doomed = next;
      next = next.nextElementSibling;
      doomed.remove();
    }

    if (!next) {
      return;
    }

    const nextFirstMath = next.querySelector(".mq-math-mode");
    if (!nextFirstMath) {
      return;
    }

    const nextLatex = cleanLatex(nextFirstMath.getAttribute("latex-data") || nextFirstMath.dataset.latexData || "");
    if (!nextLatex || nextLatex !== latex) {
      return;
    }

    block.remove();
  });
}

function scrubContainerText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest("script") || parent.closest("style") || parent.closest("textarea")) {
      continue;
    }
    textNodes.push(node);
  }

  textNodes.forEach((node) => {
    const cleaned = cleanDisplayText(node.nodeValue || "");
    if (cleaned !== node.nodeValue) {
      node.nodeValue = cleaned;
    }
  });
}

function removeTrailingBreaks(root) {
  let last = root.lastChild;
  while (last && last.nodeType === Node.ELEMENT_NODE && last.tagName === "BR") {
    const doomed = last;
    last = last.previousSibling;
    doomed.remove();
  }
}

function getMathQuillStatic() {
  if (MQ_STATIC !== undefined) {
    return MQ_STATIC;
  }

  if (window.MathQuill && typeof window.MathQuill.getInterface === "function") {
    MQ_STATIC = window.MathQuill.getInterface(2);
    return MQ_STATIC;
  }

  MQ_STATIC = null;
  return null;
}

function extractLatexToken(token) {
  if (token.startsWith("\\[") && token.endsWith("\\]")) {
    return { latex: token.slice(2, -2), block: true };
  }
  if (token.startsWith("\\(") && token.endsWith("\\)")) {
    return { latex: token.slice(2, -2), block: false };
  }
  if (token.startsWith("$$") && token.endsWith("$$")) {
    return { latex: token.slice(2, -2), block: true };
  }
  if (token.startsWith("$") && token.endsWith("$")) {
    return { latex: token.slice(1, -1), block: false };
  }
  return { latex: token, block: false };
}

function latexTextToFragment(text) {
  const src = String(text || "");
  const re = /(\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;

  let match;
  let last = 0;
  let hasLatex = false;
  const frag = document.createDocumentFragment();

  while ((match = re.exec(src)) !== null) {
    hasLatex = true;
    if (match.index > last) {
      frag.appendChild(document.createTextNode(src.slice(last, match.index)));
    }

    const token = extractLatexToken(match[0]);
    const clean = cleanLatex(token.latex);
    const span = document.createElement("span");
    span.className = token.block ? "mq-math-mode mq-block" : "mq-math-mode";
    span.setAttribute("latex-data", clean);
    span.textContent = clean;
    frag.appendChild(span);
    last = re.lastIndex;
  }

  if (!hasLatex) {
    return null;
  }

  if (last < src.length) {
    frag.appendChild(document.createTextNode(src.slice(last)));
  }

  return frag;
}


function coerceDraftAnswers(savedAnswers, totalQuestions) {
  const out = new Array(totalQuestions).fill(null);
  if (!Array.isArray(savedAnswers)) {
    return out;
  }

  for (let i = 0; i < totalQuestions; i += 1) {
    const answer = savedAnswers[i];
    if (!answer || typeof answer.value !== "string") {
      continue;
    }

    const mode = answer.mode === "write" ? "write" : "choice";
    out[i] = { mode, value: answer.value };
  }

  return out;
}

function coerceDraftSubmitted(savedSubmitted, totalQuestions) {
  const out = new Array(totalQuestions).fill(false);
  if (!Array.isArray(savedSubmitted)) {
    return out;
  }

  for (let i = 0; i < totalQuestions; i += 1) {
    out[i] = Boolean(savedSubmitted[i]);
  }

  return out;
}

function normalizeLegacyMathToken(text) {
  return cleanLatex(text)
    .replace(/\s+/g, "")
    .replace(/−/g, "-");
}

function isSimpleLegacyToken(text) {
  return /^[A-Za-z0-9.,+\-]+$/.test(String(text || ""));
}

function hasCorruptedLegacyLatex(text) {
  const value = String(text || "");
  if (!value) {
    return false;
  }

  // Legacy corruption in this dataset is non-ASCII mojibake or placeholder question marks.
  return /[^\x20-\x7E]|\?\?/.test(value);
}

function recoverLegacyLatexFromStructure(node) {
  if (!node) {
    return "";
  }

  const fraction = node.querySelector(".mq-fraction");
  if (fraction) {
    const numerator = cleanLatex((fraction.querySelector(".mq-numerator") || {}).textContent || "").replace(/\s+/g, "");
    const denominator = cleanLatex((fraction.querySelector(".mq-denominator") || {}).textContent || "").replace(/\s+/g, "");
    if (numerator && denominator) {
      return `\\frac{${numerator}}{${denominator}}`;
    }
  }

  const root = node.querySelector(".mq-root-block");
  return cleanLatex(root ? root.textContent || "" : "");
}

function chooseLegacyLatex(node, attrLatex) {
  const root = node.querySelector(".mq-root-block");
  const rootText = cleanLatex(root ? root.textContent || "" : "");
  const attribute = cleanLatex(attrLatex || "");
  const recovered = recoverLegacyLatexFromStructure(node);

  if (!rootText) {
    return attribute || recovered;
  }
  if (!attribute) {
    return recovered || rootText;
  }

  if (hasCorruptedLegacyLatex(attribute)) {
    return recovered || rootText;
  }

  const normAttr = normalizeLegacyMathToken(attribute);
  const normRoot = normalizeLegacyMathToken(rootText);

  if (!normRoot || normAttr === normRoot) {
    return attribute;
  }

  // Some source files reuse an incorrect simple latex-data value across all choices.
  // When both values are simple tokens and conflict, trust the rendered root text.
  if (isSimpleLegacyToken(normAttr) && isSimpleLegacyToken(normRoot)) {
    return rootText;
  }

  return attribute;
}

function cleanLegacyMathMarkup(root) {
  const nodes = root.querySelectorAll("span.mq-math-mode");
  nodes.forEach((node) => {
    const rawLatex = node.getAttribute("latex-data") || node.dataset.latexData || "";
    let latex = chooseLegacyLatex(node, rawLatex);
    if (hasCorruptedLegacyLatex(latex)) {
      latex = recoverLegacyLatexFromStructure(node) || cleanLatex((node.querySelector(".mq-root-block") || {}).textContent || "");
    }

    if (!latex) {
      node.remove();
      return;
    }

    const replacement = document.createElement("span");
    replacement.className = node.classList.contains("mq-block") ? "mq-math-mode mq-block" : "mq-math-mode";
    replacement.setAttribute("latex-data", latex);
    replacement.textContent = latex;
    node.replaceWith(replacement);
  });
}

function injectLatexSpansFromTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const cleaned = cleanDisplayText(node.nodeValue || "");
    if (cleaned !== node.nodeValue) {
      node.nodeValue = cleaned;
    }

    if (!cleaned.trim()) {
      continue;
    }

    const parent = node.parentElement;
    if (!parent) {
      continue;
    }
    if (parent.closest(".mq-math-mode") || parent.closest("script") || parent.closest("style") || parent.closest("textarea")) {
      continue;
    }
    if (!/[\\$]/.test(cleaned)) {
      continue;
    }

    textNodes.push(node);
  }

  textNodes.forEach((node) => {
    const frag = latexTextToFragment(node.nodeValue);
    if (frag && node.parentNode) {
      node.parentNode.replaceChild(frag, node);
    }
  });
}

function renderMathQuill(root) {
  const MQ = getMathQuillStatic();
  if (!MQ || !root) {
    return;
  }

  const nodes = root.querySelectorAll(".mq-math-mode");
  nodes.forEach((node) => {
    const latex = cleanLatex(node.getAttribute("latex-data") || node.dataset.latexData || "");
    if (!latex) {
      return;
    }

    node.textContent = "";
    node.removeAttribute("data-mq-render-failed");
    try {
      MQ.StaticMath(node).latex(latex);
    } catch (_err) {
      node.textContent = latex;
      node.setAttribute("data-mq-render-failed", "1");
    }
  });
}

function sanitizeRichHtml(html) {
  const input = String(html || "");
  if (!input) {
    return "";
  }

  const doc = new DOMParser().parseFromString(input, "text/html");
  doc.body.querySelectorAll("script,style,noscript,template,iframe,object,embed").forEach((node) => node.remove());

  const allNodes = doc.body.querySelectorAll("*");
  allNodes.forEach((node) => {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attr.name);
      }
    }

    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      if (/^\s*javascript:/i.test(href)) {
        node.removeAttribute("href");
      }
    }
  });

  return doc.body.innerHTML;
}

function setRenderableContent(target, value, allowHtml = true) {
  const raw = String(value || "").replace(/\r\n?/g, "\n");

  // For HTML blobs, avoid pre-cleaning the whole string (mojibake re-decode can fail when the blob
  // contains real Unicode). Instead, parse first and scrub individual text nodes in-DOM.
  if (allowHtml && /<[^>]+>/.test(raw)) {
    target.innerHTML = sanitizeRichHtml(raw);
    scrubContainerText(target);
    cleanLegacyMathMarkup(target);
    injectLatexSpansFromTextNodes(target);
    stripMqNeighborArtifacts(target);
    dedupeAdjacentMathSpans(target);
    collapseDuplicateEquationBlocks(target);
    removeTrailingBreaks(target);
    renderMathQuill(target);
    scrubContainerText(target);
    stripMqNeighborArtifacts(target);
    dedupeAdjacentMathSpans(target);
    collapseDuplicateEquationBlocks(target);
    removeTrailingBreaks(target);
    return;
  }

  const src = cleanDisplayText(raw);
  target.textContent = "";
  const frag = latexTextToFragment(src);
  if (frag) {
    target.appendChild(frag);
    renderMathQuill(target);
    scrubContainerText(target);
    stripMqNeighborArtifacts(target);
    dedupeAdjacentMathSpans(target);
    removeTrailingBreaks(target);
    return;
  }

  target.textContent = src;
}

async function loadQuizByUuid(raw, options = {}) {
  if (!UUID_RE.test(raw)) {
    setError("Please enter a valid UUID.");
    return false;
  }

  setError("");
  el.loadBtn.disabled = true;

  try {
    const candidatePaths = [
      `./questionbank/${raw}.json`,
      `../questionbank/${raw}.json`,
    ];

    let res = null;
    for (const p of candidatePaths) {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(p, { cache: "no-store" });
      if (r.ok) {
        res = r;
        break;
      }
    }
    if (!res) {
      throw new Error(`Could not load quiz JSON for ${raw}`);
    }

    const quiz = await res.json();
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      throw new Error("Quiz file loaded, but no questions were found.");
    }

    state.uuid = raw;
    state.quiz = quiz;
    state.questions = quiz.questions;
    state.answers = new Array(state.questions.length).fill(null);
    state.submitted = new Array(state.questions.length).fill(false);
    state.grades = new Array(state.questions.length).fill(null);
    state.idx = 0;
    state.lastResult = null;
    state.finalElapsedMs = 0;
    setContinueButtonTarget("");

    const draft = options && options.draft;
    if (draft && String(draft.uuid || "").toLowerCase() === raw.toLowerCase()) {
      state.answers = coerceDraftAnswers(draft.answers, state.questions.length);
      state.submitted = coerceDraftSubmitted(draft.submitted, state.questions.length);
      state.idx = Math.max(0, Math.min(Number(draft.idx) || 0, state.questions.length - 1));
      state.grades = state.questions.map((q, i) => (state.submitted[i] ? gradeOne(q, state.answers[i]) : null));
      setSaveStatus("Loaded saved progress. Timer restarted for this session.");
    } else {
      setSaveStatus("");
    }

    startTimer();

    renderQuestion();
    setScreen("quiz");
    if (draft && String(draft.uuid || "").toLowerCase() !== raw.toLowerCase()) {
      clearStoredDraft();
      updateSavedDraftButtons();
    }
    return true;
  } catch (err) {
    setError(err.message || "Failed to load quiz.");
    return false;
  } finally {
    el.loadBtn.disabled = false;
  }
}

async function loadQuiz() {
  const raw = el.uuidInput.value.trim();
  await loadQuizByUuid(raw);
}

function moduleButtonName(item, index) {
  const type = normalizeTestType(item && item.test_type);
  const parsedModule = Number(item && item.module);
  const mod = Number.isFinite(parsedModule) && parsedModule > 0 ? parsedModule : index + 1;
  if (type === "english" || type === "math") {
    const typeName = type.charAt(0).toUpperCase() + type.slice(1);
    return `${typeName} M${mod}`;
  }
  return `Module ${index + 1}`;
}

function buildPicker(manifestItems) {
  const groups = new Map();
  for (const item of manifestItems) {
    const key = normalizeManifestLabel(item.label) || "Unknown Test";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  el.testPicker.innerHTML = "";

  for (const [label, items] of sorted) {
    const ordered = [...items].sort(compareManifestModules);

    const card = document.createElement("div");
    card.className = "test-card";

    const title = document.createElement("div");
    title.className = "test-title";
    title.textContent = label;
    card.appendChild(title);

    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "test-main-btn";
    mainBtn.textContent = "Load Test";
    mainBtn.addEventListener("click", async () => {
      const first = (ordered[0] && ordered[0].uuid) || "";
      el.uuidInput.value = first;
      await loadQuizByUuid(first);
    });
    card.appendChild(mainBtn);

    const row = document.createElement("div");
    row.className = "module-row";

    ordered.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "secondary module-btn";
      btn.textContent = moduleButtonName(item, idx);
      btn.title = item.uuid;
      btn.addEventListener("click", async () => {
        el.uuidInput.value = item.uuid;
        await loadQuizByUuid(item.uuid);
      });
      row.appendChild(btn);
    });

    card.appendChild(row);
    el.testPicker.appendChild(card);
  }
}

async function initPicker() {
  const paths = [
    "./questionbank/quiz_origin_manifest.json",
    "../questionbank/quiz_origin_manifest.json",
  ];

  let res = null;
  for (const p of paths) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(p, { cache: "no-store" });
    if (r.ok) {
      res = r;
      break;
    }
  }

  if (!res) {
    el.pickerStatus.textContent = "Could not load quiz_origin_manifest.json";
    return;
  }

  const data = await res.json();
  state.manifest = data;
  const items = Array.isArray(data.items) ? data.items : [];
  buildPicker(items);
  el.pickerStatus.textContent = `Loaded ${items.length} quiz UUIDs`;
}

function pickChoice(value) {
  state.answers[state.idx] = {
    mode: "choice",
    value,
  };
  saveDraftWithStatus("Autosaved");
  renderQuestion();
}

function renderChoices(q) {
  el.choiceWrap.innerHTML = "";
  const active = state.answers[state.idx]?.value;

  (q.options || []).forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-btn";
    if (opt.name) {
      const prefix = document.createElement("span");
      prefix.className = "choice-prefix";
      prefix.textContent = `${opt.name}. `;
      btn.appendChild(prefix);
    }

    const content = document.createElement("span");
    content.className = "choice-content";
    setRenderableContent(content, opt.content || "", true);
    btn.appendChild(content);

    if (active && active === (opt.content || "")) {
      btn.classList.add("active");
    }
    btn.addEventListener("click", () => pickChoice(opt.content || ""));
    el.choiceWrap.appendChild(btn);
  });
}

function trackerExpectedLabel(q) {
  if (q.type === "write") {
    return String(q.correct || "").split(",")[0].trim() || "?";
  }

  const normalizedCorrect = normalize(q.correct || "");
  const match = (q.options || []).find((opt) => normalize(opt.content || "") === normalizedCorrect);
  return (match && (match.name || "").trim()) || String(q.correct || "?").trim() || "?";
}

function renderQuestionTracker(revealIndex = -1) {
  if (!el.questionTracker) return;

  el.questionTracker.innerHTML = "";
  state.questions.forEach((q, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tracker-item";
    item.setAttribute("aria-label", `Go to question ${i + 1}`);
    item.addEventListener("click", () => {
      state.idx = i;
      renderQuestion();
    });
    if (i === state.idx) {
      item.classList.add("current");
    }

    const num = document.createElement("span");
    num.textContent = `Q${i + 1}`;
    item.appendChild(num);

    if (state.submitted[i] && state.grades[i]) {
      const status = document.createElement("span");
      status.className = "tracker-status";
      if (i === revealIndex) {
        status.classList.add("reveal");
      }

      if (state.grades[i].correct) {
        const mark = document.createElement("span");
        mark.className = "tracker-mark good";
        mark.textContent = "✓";
        status.appendChild(mark);
      } else {
        const ans = document.createElement("span");
        ans.className = "tracker-answer";
        ans.textContent = trackerExpectedLabel(q);
        status.appendChild(ans);

        const mark = document.createElement("span");
        mark.className = "tracker-mark bad";
        mark.textContent = "✕";
        status.appendChild(mark);
      }

      item.appendChild(status);
    }

    el.questionTracker.appendChild(item);
  });
}

function renderQuestion(revealIndex = -1) {
  const q = state.questions[state.idx];
  const num = state.idx + 1;
  const total = state.questions.length;

  el.quizTitle.textContent = `Quiz ${state.uuid}`;
  el.progressPill.textContent = `${num} / ${total}`;
  renderQuestionTracker(revealIndex);
  setRenderableContent(el.article, q.article || "", true);
  setRenderableContent(el.question, q.question || "", true);

  const isWrite = q.type === "write";
  el.writeWrap.classList.toggle("hidden", !isWrite);
  el.choiceWrap.classList.toggle("hidden", isWrite);

  if (isWrite) {
    // Clear any prior choice nodes so open-ended questions never show stale options.
    el.choiceWrap.innerHTML = "";
    const current = state.answers[state.idx]?.value || "";
    el.writeInput.value = current;
  } else {
    renderChoices(q);
  }

  el.prevBtn.disabled = state.idx === 0;
  el.nextBtn.textContent = state.idx === total - 1 ? "Finish" : "Next";
}

function gradeOne(q, answer) {
  if (!answer || typeof answer.value !== "string") {
    return { correct: false, expected: q.correct || "", actual: "(blank)" };
  }

  const actualNorm = normalize(answer.value);

  if (q.type === "write") {
    const accepted = acceptedWriteAnswers(q.correct);
    const ok = accepted.includes(actualNorm);
    return {
      correct: ok,
      expected: q.correct || "",
      actual: answer.value,
    };
  }

  const correctNorm = normalize(q.correct || "");
  const ok = actualNorm === correctNorm;
  return {
    correct: ok,
    expected: q.correct || "",
    actual: answer.value,
  };
}

function buildPdfMarkup(result) {
  const finished = result.finishedAt ? new Date(result.finishedAt) : null;
  const finishedText = finished && !Number.isNaN(finished.getTime()) ? finished.toLocaleString() : "Unknown";
  const reviewRows = result.review.map((r, i) => {
    const status = r.correct ? "Right" : "Wrong";
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${status}</td>
        <td>${escapeHtml(r.actual)}</td>
        <td>${escapeHtml(r.expected)}</td>
      </tr>
    `;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Quiz ${escapeHtml(result.uuid)} Results</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; margin: 24px; color: #1a1a1a; }
    h1 { margin: 0 0 8px; }
    .meta { margin-bottom: 16px; }
    .meta p { margin: 3px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #cfcfcf; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f4f6fb; }
  </style>
</head>
<body>
  <h1>Quiz Results</h1>
  <div class="meta">
    <p><strong>UUID:</strong> ${escapeHtml(result.uuid)}</p>
    <p><strong>Score:</strong> ${result.right}/${result.total} (${result.pct}%)</p>
    <p><strong>Time:</strong> ${escapeHtml(formatDuration(result.elapsedMs))}</p>
    <p><strong>Finished:</strong> ${escapeHtml(finishedText)}</p>
  </div>
  <table>
    <thead>
      <tr>
        <th>Question</th>
        <th>Result</th>
        <th>Your Answer</th>
        <th>Expected</th>
      </tr>
    </thead>
    <tbody>${reviewRows}</tbody>
  </table>
</body>
</html>`;
}

function saveResultsPdf() {
  if (!state.lastResult) {
    return;
  }

  const markup = buildPdfMarkup(state.lastResult);

  // Print from a same-origin iframe first so popup/privacy settings cannot force a blank tab.
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);

  const cleanupIframe = () => {
    window.setTimeout(() => {
      iframe.remove();
    }, 1000);
  };

  try {
    const frameWindow = iframe.contentWindow;
    if (!frameWindow) {
      throw new Error("No iframe window");
    }

    frameWindow.document.open();
    frameWindow.document.write(markup);
    frameWindow.document.close();

    const triggerPrint = () => {
      frameWindow.focus();
      frameWindow.print();
      cleanupIframe();
    };

    if (frameWindow.document.readyState === "complete") {
      window.setTimeout(triggerPrint, 100);
    } else {
      iframe.addEventListener("load", () => window.setTimeout(triggerPrint, 100), { once: true });
    }
    return;
  } catch (_err) {
    cleanupIframe();
  }

  // Fallback for browsers that disallow iframe printing.
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    window.alert("Could not open a print window. Please allow popups and try again.");
    return;
  }

  try {
    printWindow.document.open();
    printWindow.document.write(markup);
    printWindow.document.close();
    window.setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 200);
  } catch (_err) {
    window.alert("PDF export was blocked by browser security settings. Try disabling strict privacy protections for this site.");
  }
}

function finishQuiz() {
  const review = state.questions.map((q, i) => gradeOne(q, state.answers[i]));
  const right = review.filter((r) => r.correct).length;
  const wrong = review.length - right;
  const pct = review.length ? Math.round((right / review.length) * 100) : 0;
  const elapsedMs = stopTimer();

  state.lastResult = {
    uuid: state.uuid,
    right,
    wrong,
    total: review.length,
    pct,
    elapsedMs,
    finishedAt: new Date().toISOString(),
    review,
  };

  el.resultUuid.textContent = `UUID: ${state.uuid}`;
  el.rightCount.textContent = String(right);
  el.wrongCount.textContent = String(wrong);
  el.percentLine.textContent = `Score: ${right}/${review.length} (${pct}%)`;
  el.resultTime.textContent = `Time: ${formatDuration(elapsedMs)}`;

  el.reviewList.innerHTML = "";
  review.forEach((r, i) => {
    const li = document.createElement("li");
    li.textContent = `Q${i + 1}: ${r.correct ? "Right" : "Wrong"} | Your answer: ${r.actual} | Expected: ${r.expected}`;
    el.reviewList.appendChild(li);
  });

  setContinueButtonTarget(getNextModuleUuid(state.uuid));

  clearStoredDraft();
  updateSavedDraftButtons();
  setSaveStatus("");

  setScreen("result");
}

function goNext() {
  const currentIdx = state.idx;
  state.submitted[currentIdx] = true;
  state.grades[currentIdx] = gradeOne(state.questions[currentIdx], state.answers[currentIdx]);

  if (state.idx >= state.questions.length - 1) {
    finishQuiz();
    return;
  }
  state.idx += 1;
  saveDraftWithStatus("Autosaved");
  renderQuestion(currentIdx);
}

function goPrev() {
  if (state.idx === 0) return;
  state.idx -= 1;
  saveDraftWithStatus("Autosaved");
  renderQuestion();
}

function resetApp(options = {}) {
  const keepDraft = Boolean(options.keepDraft);
  setScreen("loader");
  setError("");
  state.uuid = "";
  state.quiz = null;
  state.questions = [];
  state.answers = [];
  state.submitted = [];
  state.grades = [];
  state.idx = 0;
  state.lastResult = null;
  setContinueButtonTarget("");
  resetTimer();
  setSaveStatus("");

  if (!keepDraft || !state.saveEnabled) {
    clearStoredDraft();
    updateSavedDraftButtons();
  }
}

async function loadSavedDraft() {
  if (!state.saveEnabled) {
    setError("Enable test saving first to load saved progress.");
    setScreen("loader");
    return;
  }

  const draft = readStoredDraft();
  if (!draft) {
    showResumeSummary(null);
    setScreen("loader");
    setError("No saved progress was found.");
    updateSavedDraftButtons();
    return;
  }

  el.uuidInput.value = draft.uuid;
  setError("");
  await loadQuizByUuid(draft.uuid, { draft });
}

el.loadBtn.addEventListener("click", loadQuiz);
el.sampleBtn.addEventListener("click", () => {
  // Uses the currently open file UUID from editor context when available.
  el.uuidInput.value = "0f56dc3e-c66b-4dcd-b354-0e6de1091d26";
});

el.uuidInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    loadQuiz();
  }
});

el.writeInput.addEventListener("input", () => {
  state.answers[state.idx] = {
    mode: "write",
    value: el.writeInput.value,
  };
  saveDraftWithStatus("Autosaved");
  safeLogEvent("answer_input", el.writeInput.value);
});

el.prevBtn.addEventListener("click", goPrev);
el.nextBtn.addEventListener("click", goNext);
el.saveDraftBtn.addEventListener("click", () => {
  saveDraftWithStatus("Saved manually");
});
if (el.continueBtn) {
  el.continueBtn.addEventListener("click", async () => {
    const nextUuid = String(el.continueBtn.dataset.nextUuid || "").trim();
    if (!UUID_RE.test(nextUuid)) {
      setContinueButtonTarget("");
      return;
    }

    el.uuidInput.value = nextUuid;
    el.continueBtn.disabled = true;
    await loadQuizByUuid(nextUuid);
  });
}
el.restartBtn.addEventListener("click", () => resetApp());
el.pdfBtn.addEventListener("click", saveResultsPdf);
el.homeBtns.forEach((btn) => {
  btn.addEventListener("click", () => resetApp());
});

el.loadSavedBtn.addEventListener("click", loadSavedDraft);
el.resumeLoadBtn.addEventListener("click", loadSavedDraft);
el.resumeDiscardBtn.addEventListener("click", () => {
  clearStoredDraft();
  updateSavedDraftButtons();
  showResumeSummary(null);
  setScreen("loader");
});

if (el.saveToggle) {
  el.saveToggle.addEventListener("change", () => {
    setSaveEnabled(el.saveToggle.checked);
    setError("");
    if (!state.saveEnabled) {
      showResumeSummary(null);
      if (state.questions.length === 0) {
        setScreen("loader");
      }
    }
  });
}

if (el.instructorOverviewToggle) {
  el.instructorOverviewToggle.addEventListener("change", () => {
    setInstructorOverviewEnabled(el.instructorOverviewToggle.checked);
  });
}

if (el.instructorOverviewLink) {
  el.instructorOverviewLink.addEventListener("click", (event) => {
    if (!state.instructorOverviewEnabled) {
      event.preventDefault();
      return;
    }
    safeLogEvent("instructor_questions", "open");
  });
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!target || typeof target.closest !== "function") {
    return;
  }

  const button = target.closest("button");
  if (!button) {
    return;
  }

  safeLogEvent("click", describeButtonForLog(button));
}, true);

document.addEventListener("visibilitychange", () => {
  safeLogEvent("visibility", document.hidden ? "hidden" : "visible");
});

window.addEventListener("beforeunload", (event) => {
  if (!state.saveEnabled || !hasUnfinishedProgress()) {
    return;
  }

  writeCurrentDraft();
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("pagehide", () => {
  if (state.saveEnabled && hasUnfinishedProgress()) {
    writeCurrentDraft();
  }
});

setSaveEnabled(readSavePreference(), { persist: false });
setInstructorOverviewEnabled(readInstructorOverviewPreference(), { persist: false });
syncUserSessionCode();
updateSavedDraftButtons();
state.pendingDraft = readStoredDraft();
if (state.pendingDraft) {
  showResumeSummary(state.pendingDraft);
  setScreen("resume");
} else {
  setScreen("loader");
}

initPicker();
initActivityLogger();
