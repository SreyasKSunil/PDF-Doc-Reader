/* Read Aloud Webapp
   - PDF parsing via PDF.js
   - DOCX parsing via Mammoth
   - Speech via Web Speech API (speechSynthesis)
   - Tap a line to start from there
   - Pause resumes from the same spot (speechSynthesis.pause/resume)
*/

const el = (id) => document.getElementById(id);

const fileInput = el("fileInput");
const btnClear = el("btnClear");
const btnPlay = el("btnPlay");
const btnPause = el("btnPause");
const btnStop = el("btnStop");
const voiceSelect = el("voiceSelect");
const rateSlider = el("rate");
const rateLabel = el("rateLabel");
const statusText = el("statusText");
const textView = el("textView");
const docMeta = el("docMeta");

let voices = [];
let sections = []; // [{ title, lines: [{text, sectionIndex, lineIndex}], startLineGlobal, endLineGlobal }]
let globalLines = []; // flat list of { text, sectionIndex, lineIndex }
let current = { sectionIndex: 0, lineIndex: 0 };
let speaking = { active: false, paused: false };
let currentUtterance = null;

let pendingLineOverride = null;
// If user taps a line inside a section while "read by section" behavior is active,
// we read from that line to end of that section first, then continue section by section.
let readBySection = true;

function setStatus(msg) {
  statusText.textContent = msg;
}

function safeEnableControls(enabled) {
  btnPlay.disabled = !enabled;
  btnPause.disabled = !enabled;
  btnStop.disabled = !enabled;
}

function stopSpeech() {
  try {
    window.speechSynthesis.cancel();
  } catch (_) {}
  speaking.active = false;
  speaking.paused = false;
  currentUtterance = null;
}

function isSpeechSupported() {
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

function loadVoices() {
  voices = window.speechSynthesis.getVoices() || [];
  voiceSelect.innerHTML = "";
  if (!voices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Default device voice";
    voiceSelect.appendChild(opt);
    return;
  }

  // Prefer local voices, then language match, then the rest.
  const userLang = (navigator.language || "en").toLowerCase();
  const scored = voices.map((v, idx) => {
    let score = 0;
    if (v.localService) score += 3;
    if ((v.lang || "").toLowerCase().startsWith(userLang.split("-")[0])) score += 2;
    if ((v.name || "").toLowerCase().includes("siri")) score += 1;
    return { v, idx, score };
  }).sort((a, b) => b.score - a.score);

  scored.forEach(({ v, idx }) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = `${v.name} (${v.lang}${v.localService ? ", device" : ""})`;
    voiceSelect.appendChild(opt);
  });

  // Default to top-ranked
  voiceSelect.value = String(scored[0].idx);
}

function getSelectedVoice() {
  const idx = parseInt(voiceSelect.value, 10);
  if (Number.isFinite(idx) && voices[idx]) return voices[idx];
  return null;
}

function rate() {
  return parseFloat(rateSlider.value) || 1.0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeText(t) {
  return (t || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* Q/A sectioning
   - If text contains obvious Q/A markers, group into sections by Question starts.
   - Otherwise, group by paragraphs.
*/
function parseIntoSections(text) {
  const t = normalizeText(text);
  if (!t) return [];

  const linesRaw = t.split("\n").map(s => s.trim()).filter(Boolean);

  const qStart = (s) => /^(q[:.\-)]\s+|question[:.\-)]\s+)/i.test(s);
  const aStart = (s) => /^(a[:.\-)]\s+|answer[:.\-)]\s+)/i.test(s);

  const hasQA = linesRaw.some(qStart) && linesRaw.some(aStart);

  let result = [];
  if (hasQA) {
    let currentSec = null;
    for (const ln of linesRaw) {
      if (qStart(ln) || !currentSec) {
        if (currentSec) result.push(currentSec);
        currentSec = { title: "Q and A", rawLines: [] };
      }
      currentSec.rawLines.push(ln);
    }
    if (currentSec) result.push(currentSec);
  } else {
    // Paragraph based
    const paras = t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    result = paras.map((p, i) => {
      // Convert paragraph to lines by sentence-ish splitting for better tapping.
      const pieces = splitToReadableLines(p);
      return { title: `Section ${i + 1}`, rawLines: pieces };
    });
  }

  // Build display lines
  const built = [];
  result.forEach((sec, sIdx) => {
    const raw = sec.rawLines.length ? sec.rawLines : ["(empty)"];
    const lines = raw.map((txt, lIdx) => ({
      text: txt,
      sectionIndex: sIdx,
      lineIndex: lIdx
    }));
    built.push({ title: sec.title, lines });
  });

  return built;
}

/* Sentence-ish splitting for non-QA docs.
   Safari boundary events are unreliable, so we speak line by line.
*/
function splitToReadableLines(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const parts = cleaned.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

  // Merge short fragments for smoother audio
  const lines = [];
  let buf = "";
  for (const p of parts) {
    if (!buf) { buf = p; continue; }
    if ((buf.length < 80) || p.length < 40) {
      buf += " " + p;
    } else {
      lines.push(buf);
      buf = p;
    }
  }
  if (buf) lines.push(buf);
  return lines;
}

function buildGlobalLines() {
  globalLines = [];
  sections.forEach((sec) => {
    sec.lines.forEach((ln) => globalLines.push(ln));
  });
}

function renderText() {
  textView.innerHTML = "";
  if (!sections.length) return;

  sections.forEach((sec, sIdx) => {
    const wrap = document.createElement("div");
    wrap.className = "section";

    const title = document.createElement("div");
    title.className = "sectionTitle";
    title.textContent = sec.title;
    wrap.appendChild(title);

    sec.lines.forEach((ln) => {
      const div = document.createElement("div");
      div.className = "line";
      div.textContent = ln.text;
      div.dataset.section = String(sIdx);
      div.dataset.line = String(ln.lineIndex);

      div.addEventListener("click", () => {
        const si = parseInt(div.dataset.section, 10);
        const li = parseInt(div.dataset.line, 10);
        jumpTo(si, li, true);
      });

      wrap.appendChild(div);
    });

    textView.appendChild(wrap);
  });

  updateActiveHighlight();
}

function updateActiveHighlight() {
  const all = textView.querySelectorAll(".line");
  all.forEach((node) => node.classList.remove("active"));

  const selector = `.line[data-section="${current.sectionIndex}"][data-line="${current.lineIndex}"]`;
  const active = textView.querySelector(selector);
  if (active) {
    active.classList.add("active");
    // Keep the active line visible
    active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function jumpTo(sectionIndex, lineIndex, autoPlay) {
  current.sectionIndex = clamp(sectionIndex, 0, Math.max(0, sections.length - 1));
  const maxLine = sections[current.sectionIndex]?.lines?.length ? sections[current.sectionIndex].lines.length - 1 : 0;
  current.lineIndex = clamp(lineIndex, 0, Math.max(0, maxLine));

  pendingLineOverride = { sectionIndex: current.sectionIndex, lineIndex: current.lineIndex };
  updateActiveHighlight();
  setStatus(`Ready at section ${current.sectionIndex + 1}, line ${current.lineIndex + 1}.`);

  if (autoPlay) {
    stopSpeech();
    // iOS Safari needs a user gesture. This click is the gesture.
    startPlayback();
  }
}

function sectionTextFromLine(sectionIndex, lineIndex) {
  const sec = sections[sectionIndex];
  if (!sec) return "";
  const slice = sec.lines.slice(lineIndex).map(x => x.text).join("\n");
  return slice.trim();
}

function fullSectionText(sectionIndex) {
  const sec = sections[sectionIndex];
  if (!sec) return "";
  return sec.lines.map(x => x.text).join("\n").trim();
}

function speakText(text, onEnd) {
  if (!isSpeechSupported()) {
    setStatus("Speech not supported in this browser.");
    return;
  }
  if (!text) {
    onEnd?.();
    return;
  }

  const u = new SpeechSynthesisUtterance(text);
  const v = getSelectedVoice();
  if (v) u.voice = v;
  u.rate = rate();

  u.onstart = () => {
    speaking.active = true;
    speaking.paused = false;
  };
  u.onend = () => {
    speaking.active = false;
    speaking.paused = false;
    currentUtterance = null;
    onEnd?.();
  };
  u.onerror = () => {
    speaking.active = false;
    speaking.paused = false;
    currentUtterance = null;
    setStatus("Speech error. Try another voice.");
  };

  currentUtterance = u;
  window.speechSynthesis.speak(u);
}

function startPlayback() {
  if (!sections.length) {
    setStatus("Load a file first.");
    return;
  }

  // Resume if paused
  if (window.speechSynthesis.paused) {
    window.speechSynthesis.resume();
    speaking.paused = false;
    setStatus("Resumed.");
    return;
  }

  // If already speaking, ignore
  if (window.speechSynthesis.speaking) {
    setStatus("Playing.");
    return;
  }

  // Default behavior:
  // - If user tapped a line, read from that line to end of that section first.
  // - Then continue section by section (Question + Answer treated as a section).
  const playNext = () => {
    // Move to next section
    current.sectionIndex += 1;
    current.lineIndex = 0;
    pendingLineOverride = null;

    if (current.sectionIndex >= sections.length) {
      setStatus("Finished.");
      return;
    }

    updateActiveHighlight();
    speakCurrentSection(playNext);
  };

  speakCurrentSection(playNext);
}

function speakCurrentSection(onSectionEnd) {
  updateActiveHighlight();

  let text = "";
  const secIdx = current.sectionIndex;

  if (readBySection) {
    if (pendingLineOverride && pendingLineOverride.sectionIndex === secIdx) {
      text = sectionTextFromLine(secIdx, pendingLineOverride.lineIndex);
      // After reading the override part of this section, continue with next sections.
      pendingLineOverride = null;
    } else {
      text = fullSectionText(secIdx);
    }
  } else {
    // Line-by-line mode (not exposed in UI, kept for future)
    text = sections[secIdx]?.lines?.[current.lineIndex]?.text || "";
  }

  setStatus(`Reading section ${secIdx + 1} of ${sections.length}.`);
  // Highlight first line of section as active for visibility
  current.lineIndex = pendingLineOverride?.lineIndex ?? current.lineIndex ?? 0;
  updateActiveHighlight();

  speakText(text, () => {
    // After speaking, advance to next section
    onSectionEnd?.();
  });
}

function pausePlayback() {
  if (!isSpeechSupported()) return;
  if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
    window.speechSynthesis.pause();
    speaking.paused = true;
    setStatus("Paused.");
  } else if (window.speechSynthesis.paused) {
    // Optional: allow pause button to act as resume too
    window.speechSynthesis.resume();
    speaking.paused = false;
    setStatus("Resumed.");
  }
}

function stopPlayback() {
  stopSpeech();
  setStatus("Stopped.");
}

/* File loading */

async function extractTextFromPDF(arrayBuffer) {
  const pdfjsLib = window["pdfjs-dist/build/pdf"];
  if (!pdfjsLib) throw new Error("PDF.js missing");

  // Worker configuration for CDN usage
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.js";

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let allText = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items.map((it) => it.str).filter(Boolean);
    allText.push(strings.join(" "));
    allText.push("\n");
  }

  return normalizeText(allText.join("\n"));
}

async function extractTextFromDOCX(arrayBuffer) {
  const res = await window.mammoth.extractRawText({ arrayBuffer });
  return normalizeText(res.value || "");
}

function resetDocumentState() {
  stopSpeech();
  sections = [];
  globalLines = [];
  current = { sectionIndex: 0, lineIndex: 0 };
  pendingLineOverride = null;
  textView.innerHTML = "";
  docMeta.textContent = "";
  safeEnableControls(false);
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  resetDocumentState();

  if (!isSpeechSupported()) {
    setStatus("SpeechSynthesis not supported. Try Safari or Chrome.");
    return;
  }

  const name = file.name || "Document";
  docMeta.textContent = `Loaded: ${name}`;
  setStatus("Reading file...");

  try {
    const buf = await file.arrayBuffer();
    let text = "";

    const lower = name.toLowerCase();
    if (lower.endsWith(".pdf") || file.type === "application/pdf") {
      text = await extractTextFromPDF(buf);
    } else if (lower.endsWith(".docx")) {
      text = await extractTextFromDOCX(buf);
    } else {
      setStatus("Unsupported file type. Use PDF or DOCX.");
      return;
    }

    if (!text) {
      setStatus("No readable text found in this file.");
      return;
    }

    sections = parseIntoSections(text);
    buildGlobalLines();
    renderText();

    current = { sectionIndex: 0, lineIndex: 0 };
    updateActiveHighlight();

    safeEnableControls(true);
    setStatus("Ready. Tap a line or press Play.");
  } catch (err) {
    setStatus("Failed to load file.");
  } finally {
    // Clear the input so selecting the same file again triggers change
    fileInput.value = "";
  }
});

btnPlay.addEventListener("click", () => startPlayback());
btnPause.addEventListener("click", () => pausePlayback());
btnStop.addEventListener("click", () => stopPlayback());

btnClear.addEventListener("click", () => {
  resetDocumentState();
  setStatus("Cleared.");
});

rateSlider.addEventListener("input", () => {
  rateLabel.textContent = rate().toFixed(2);
  // If currently speaking, changes will apply to the next utterance.
});

voiceSelect.addEventListener("change", () => {
  // If speaking, restart from current section so voice change is immediate.
  if (window.speechSynthesis.speaking || window.speechSynthesis.paused) {
    stopSpeech();
    startPlayback();
  }
});

/* Voice loading quirks
   - iOS Safari loads voices asynchronously.
*/
if (isSpeechSupported()) {
  window.speechSynthesis.onvoiceschanged = () => loadVoices();
  loadVoices();
  safeEnableControls(false);
} else {
  safeEnableControls(false);
  setStatus("Speech not supported in this browser.");
}
