const state = {
  uuid: "",
  quiz: null,
  questions: [],
  idx: 0,
  answers: [],
  manifest: null,
};

const el = {
  loaderScreen: document.getElementById("loader-screen"),
  quizScreen: document.getElementById("quiz-screen"),
  resultScreen: document.getElementById("result-screen"),
  uuidInput: document.getElementById("uuid-input"),
  loadBtn: document.getElementById("load-btn"),
  sampleBtn: document.getElementById("sample-btn"),
  loaderError: document.getElementById("loader-error"),
  pickerStatus: document.getElementById("picker-status"),
  testPicker: document.getElementById("test-picker"),
  quizTitle: document.getElementById("quiz-title"),
  progressPill: document.getElementById("progress-pill"),
  article: document.getElementById("article"),
  question: document.getElementById("question"),
  choiceWrap: document.getElementById("choice-wrap"),
  writeWrap: document.getElementById("write-wrap"),
  writeInput: document.getElementById("write-input"),
  prevBtn: document.getElementById("prev-btn"),
  nextBtn: document.getElementById("next-btn"),
  resultUuid: document.getElementById("result-uuid"),
  rightCount: document.getElementById("right-count"),
  wrongCount: document.getElementById("wrong-count"),
  percentLine: document.getElementById("percent-line"),
  reviewList: document.getElementById("review-list"),
  restartBtn: document.getElementById("restart-btn"),
  homeBtns: document.querySelectorAll("[data-go-home]"),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_TYPE_ORDER = { english: 0, math: 1 };

function setScreen(name) {
  el.loaderScreen.classList.toggle("hidden", name !== "loader");
  el.quizScreen.classList.toggle("hidden", name !== "quiz");
  el.resultScreen.classList.toggle("hidden", name !== "result");
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

function setRenderableContent(target, value, allowHtml = true) {
  const raw = String(value || "").replace(/\r\n?/g, "\n");

  // For HTML blobs, avoid pre-cleaning the whole string (mojibake re-decode can fail when the blob
  // contains real Unicode). Instead, parse first and scrub individual text nodes in-DOM.
  if (allowHtml && /<[^>]+>/.test(raw)) {
    target.innerHTML = raw;
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

async function loadQuizByUuid(raw) {
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
    let path = null;
    for (const p of candidatePaths) {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(p, { cache: "no-store" });
      if (r.ok) {
        res = r;
        path = p;
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
    state.idx = 0;

    renderQuestion();
    setScreen("quiz");
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

function renderQuestion() {
  const q = state.questions[state.idx];
  const num = state.idx + 1;
  const total = state.questions.length;

  el.quizTitle.textContent = `Quiz ${state.uuid}`;
  el.progressPill.textContent = `${num} / ${total}`;
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

function finishQuiz() {
  const review = state.questions.map((q, i) => gradeOne(q, state.answers[i]));
  const right = review.filter((r) => r.correct).length;
  const wrong = review.length - right;
  const pct = review.length ? Math.round((right / review.length) * 100) : 0;

  el.resultUuid.textContent = `UUID: ${state.uuid}`;
  el.rightCount.textContent = String(right);
  el.wrongCount.textContent = String(wrong);
  el.percentLine.textContent = `Score: ${right}/${review.length} (${pct}%)`;

  el.reviewList.innerHTML = "";
  review.forEach((r, i) => {
    const li = document.createElement("li");
    li.textContent = `Q${i + 1}: ${r.correct ? "Right" : "Wrong"} | Your answer: ${r.actual} | Expected: ${r.expected}`;
    el.reviewList.appendChild(li);
  });

  setScreen("result");
}

function goNext() {
  if (state.idx >= state.questions.length - 1) {
    finishQuiz();
    return;
  }
  state.idx += 1;
  renderQuestion();
}

function goPrev() {
  if (state.idx === 0) return;
  state.idx -= 1;
  renderQuestion();
}

function resetApp() {
  setScreen("loader");
  setError("");
  state.uuid = "";
  state.quiz = null;
  state.questions = [];
  state.answers = [];
  state.idx = 0;
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
});

el.prevBtn.addEventListener("click", goPrev);
el.nextBtn.addEventListener("click", goNext);
el.restartBtn.addEventListener("click", resetApp);
el.homeBtns.forEach((btn) => {
  btn.addEventListener("click", resetApp);
});

setScreen("loader");
initPicker();
