import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, ReactNode } from "react";
import {
  ArrowLeft, ArrowRight, BarChart3, BookOpen, Check, CheckCircle2, ChevronDown,
  CircleHelp, Clock3, Eye, EyeOff, FileText, History, KeyRound, Layers3, LoaderCircle, LockKeyhole,
  Menu, Moon, RotateCcw, Settings2, ShieldCheck, Sparkles, Sun, Upload, X, ZoomIn, ZoomOut,
} from "lucide-react";
import DOMPurify from "dompurify";
import katex from "katex";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | undefined;

async function loadPdfJs() {
  const pdfjsLib = await (pdfJsPromise ??= import("pdfjs-dist"));
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
  return pdfjsLib;
}

type Tier = "Tier 1" | "Tier 2";
type Theme = "dark" | "light";
type QuestionStatus = "not-visited" | "not-answered" | "answered" | "marked" | "answered-marked";
type Question = {
  id: string;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  passageText?: string;
  selectedOption?: number;
  visited: boolean;
  marked: boolean;
  timeSpentSeconds: number;
};
type ExamSettings = {
  tier: Tier;
  subject: string;
  tier1Subjects: Tier1Subject[];
  expectedQuestions: number;
  positiveMarks: number;
  negativeMarks: number;
  timerMinutes: number;
  untimed: boolean;
  sectionName: string;
};
type Attempt = {
  id: string;
  completedAt: string;
  sectionName: string;
  tier: Tier;
  positiveMarks: number;
  negativeMarks: number;
  elapsedSeconds: number;
  questions: Question[];
};
type ExtractedQuestion = {
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  passageText?: string;
};
type GeminiConnectionStatus =
  | "idle"
  | "testing"
  | "connected"
  | "invalid_key"
  | "quota"
  | "network"
  | "timeout"
  | "api_error"
  | "cleared";

const HISTORY_KEY = "mockforge.attempts";
const THEME_KEY = "mockforge.theme";
const GEMINI_CONNECTION_TEST_TIMEOUT_MS = 180_000;
const MIN_QUESTION_ZOOM = 70;
const MAX_QUESTION_ZOOM = 150;
const QUESTION_ZOOM_STEP = 10;
const TIER1_SUBJECTS = [
  "General Intelligence & Reasoning",
  "General Awareness",
  "Quantitative Aptitude",
  "English Comprehension",
] as const;
type Tier1Subject = typeof TIER1_SUBJECTS[number];
const SUBJECTS = [
  { name: "Mathematical Abilities", questions: 30, minutes: 35 },
  { name: "Reasoning & General Intelligence", questions: 30, minutes: 25 },
  { name: "English Language & Comprehension", questions: 45, minutes: 45 },
  { name: "General Awareness", questions: 25, minutes: 15 },
  { name: "Computer Knowledge Module", questions: 20, minutes: 15 },
];

const initialSettings: ExamSettings = {
  tier: "Tier 1",
  subject: SUBJECTS[0].name,
  tier1Subjects: [...TIER1_SUBJECTS],
  expectedQuestions: 25,
  positiveMarks: 2,
  negativeMarks: 0.5,
  timerMinutes: 15,
  untimed: false,
  sectionName: "",
};

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function readAttempts(): Attempt[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(stored) ? stored as Attempt[] : [];
  } catch {
    return [];
  }
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function mathAndMarkup(text: string): string {
  const lines = text.split("\n");
  const rendered = lines.map((line) => {
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    if (cells.length > 1 && cells.some((cell) => cell.length > 0)) {
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return "";
      return `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`;
    }
    return renderInline(line);
  }).filter(Boolean);
  const output = rendered.some((line) => line.startsWith("<tr>"))
    ? rendered.map((line) => line.startsWith("<tr>") ? line : `<tr><td colspan="4">${line}</td></tr>`).join("")
    : rendered.join("<br>");
  const wrapped = output.includes("<tr>") ? `<table class="question-table"><tbody>${output}</tbody></table>` : output;
  return DOMPurify.sanitize(wrapped, { ADD_TAGS: ["u"], ADD_ATTR: ["colspan", "class"] });
}

function renderInline(text: string): string {
  const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const withMath = safeText.replace(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g, (match) => {
    const display = match.startsWith("$$");
    const expression = match.slice(display ? 2 : 1, display ? -2 : -1);
    try {
      return katex.renderToString(expression, { displayMode: display, throwOnError: false });
    } catch {
      return match;
    }
  });
  return withMath.replace(/&lt;(\/?u)&gt;/gi, "<$1>");
}

function statusOf(question: Question): QuestionStatus {
  if (!question.visited) return "not-visited";
  if (question.marked && question.selectedOption !== undefined) return "answered-marked";
  if (question.marked) return "marked";
  if (question.selectedOption !== undefined) return "answered";
  return "not-answered";
}

function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [settings, setSettings] = useState<ExamSettings>(initialSettings);
  const [customOverride, setCustomOverride] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [questionZoom, setQuestionZoom] = useState(100);
  const [view, setView] = useState<"setup" | "ready" | "exam" | "results">("setup");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [apiModal, setApiModal] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [showGeminiApiKey, setShowGeminiApiKey] = useState(false);
  const [geminiConnectionStatus, setGeminiConnectionStatus] = useState<GeminiConnectionStatus>("idle");
  const geminiTestControllerRef = useRef<AbortController | null>(null);
  const [submitModal, setSubmitModal] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[]>(readAttempts);
  const [currentAttempt, setCurrentAttempt] = useState<Attempt | null>(null);
  const [storageWarning, setStorageWarning] = useState("");
  const [reviewFilter, setReviewFilter] = useState("All");
  const [mobilePaletteOpen, setMobilePaletteOpen] = useState(false);
  const activeQuestionRef = useRef(0);
  const submittedRef = useRef(false);
  const extractionInFlightRef = useRef(false);
  const extractionControllerRef = useRef<AbortController | null>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const examInitializedRef = useRef(false);
  const testGeminiConnection = async () => {
    const apiKey = geminiApiKey.trim();
    if (!apiKey) {
      setGeminiConnectionStatus("invalid_key");
      return;
    }
    const localDevelopmentHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
    if (window.location.protocol !== "https:" && !localDevelopmentHosts.includes(window.location.hostname)) {
      setGeminiConnectionStatus("api_error");
      return;
    }

    const controller = new AbortController();
    geminiTestControllerRef.current = controller;
    setGeminiConnectionStatus("testing");
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GEMINI_CONNECTION_TEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/ai/test-gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
        signal: controller.signal,
      });
      if (!response.ok) {
        setGeminiConnectionStatus("api_error");
        return;
      }
      const result: unknown = await response.json().catch(() => undefined);
      const resultStatus = result && typeof result === "object" && "status" in result
        ? result.status
        : undefined;
      const knownStatuses: Exclude<GeminiConnectionStatus, "idle" | "testing" | "cleared">[] = [
        "connected", "invalid_key", "quota", "network", "timeout", "api_error",
      ];
      setGeminiConnectionStatus(knownStatuses.find((status) => status === resultStatus) ?? "api_error");
    } catch {
      if (timedOut) {
        setGeminiConnectionStatus("timeout");
      } else if (!controller.signal.aborted) {
        setGeminiConnectionStatus("network");
      }
    } finally {
      clearTimeout(timeout);
      if (geminiTestControllerRef.current === controller) geminiTestControllerRef.current = null;
    }
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The selected theme remains active for this session if storage is unavailable.
    }
  }, [theme]);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  const patchSettings = (patch: Partial<ExamSettings>) => setSettings((current) => ({ ...current, ...patch }));
  const selectedSubjectNames = settings.tier === "Tier 1"
    ? TIER1_SUBJECTS.filter((subject) => settings.tier1Subjects.includes(subject))
    : [settings.subject];
  const selectedSubjectLabel = selectedSubjectNames.join(", ");
  const activeSectionName = settings.sectionName || selectedSubjectLabel;
  const toggleTier1Subject = (subject: Tier1Subject) => {
    setSettings((current) => ({
      ...current,
      tier1Subjects: current.tier1Subjects.includes(subject)
        ? current.tier1Subjects.filter((selected) => selected !== subject)
        : [...current.tier1Subjects, subject],
    }));
  };
  const startExam = () => {
    if (view !== "ready" || questions.length === 0 || examInitializedRef.current) return;
    examInitializedRef.current = true;
    setActiveIndex(0);
    activeQuestionRef.current = 0;
    setQuestionZoom(100);
    setElapsedSeconds(0);
    setSecondsLeft(settings.untimed ? 0 : settings.timerMinutes * 60);
    setQuestions((current) => current.map((question, index) =>
      index === 0 ? { ...question, visited: true } : question,
    ));
    submittedRef.current = false;
    setWarning("");
    setView("exam");
  };
  const applyTier = (tier: Tier) => {
    if (tier === "Tier 1") {
      patchSettings({ tier, expectedQuestions: 25, positiveMarks: 2, negativeMarks: 0.5, timerMinutes: 15 });
    } else {
      const subject = SUBJECTS.find((item) => item.name === settings.subject) ?? SUBJECTS[0];
      patchSettings({ tier, positiveMarks: 3, negativeMarks: 1, expectedQuestions: subject.questions, timerMinutes: subject.minutes });
    }
  };
  const applySubject = (subjectName: string) => {
    const subject = SUBJECTS.find((item) => item.name === subjectName);
    patchSettings({
      subject: subjectName,
      ...(settings.tier === "Tier 2" && subject
        ? { expectedQuestions: subject.questions, timerMinutes: subject.minutes }
        : {}),
    });
  };
  const toggleCustomOverride = (enabled: boolean) => {
    setCustomOverride(enabled);
    if (!enabled) applyTier(settings.tier);
  };

  const loadFile = async (selected: File | undefined) => {
    if (!selected) return;
    setError("");
    setWarning("");
    setFile(null);
    setPageCount(0);
    if (selected.size > 50 * 1024 * 1024) {
      setError("This PDF is larger than 50 MB. Choose a smaller response sheet.");
      return;
    }
    if (selected.type !== "application/pdf" && !selected.name.toLowerCase().endsWith(".pdf")) {
      setError("Please choose a PDF response sheet.");
      return;
    }
    try {
      const data = await selected.arrayBuffer();
      const pdfjsLib = await loadPdfJs();
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      setFile(selected);
      setPageCount(pdf.numPages);
      setStartPage(1);
      setEndPage(Math.min(pdf.numPages, 5));
    } catch (reason) {
      setError(`Could not read this PDF: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => void loadFile(event.target.files?.[0]);
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void loadFile(event.dataTransfer.files[0]);
  };

  const extractQuestions = async (
    images: { page: number; data: string }[],
    signal: AbortSignal,
  ): Promise<ExtractedQuestion[]> => {
    const sectionInstruction = settings.tier === "Tier 1"
      ? `Only include questions from these selected Tier 1 subjects/modules: ${selectedSubjectNames.join(", ")}. Preserve their order and distribution from the provided pages; do not rebalance or invent questions.${settings.sectionName.trim() ? ` Restrict them to the section "${settings.sectionName.trim()}".` : ""}`
      : `Only include questions belonging to section "${settings.sectionName || settings.subject}" from the provided pages.`;
    const prompt = `You are extracting questions from an SSC competitive exam candidate response sheet. ${sectionInstruction} Skip ads and promotional pages. Return ONLY valid JSON matching {"questions":[{"questionText":"...","options":["...","...","...","..."],"correctOptionIndex":1,"passageText":"..."}]}. correctOptionIndex is 1, 2, 3, or 4 based on the green official correct-answer tick (not the candidate's chosen answer). Scrub every checkmark, red cross, Question ID, Option ID, Status, Chosen Option, Adda247 and Google Play artifact from question/option text. Keep question and options clean. Express math in LaTeX with $...$ inline and $$...$$ display; preserve structured frequency tables as Markdown tables. Wrap any underlined English text in <u>...</u>. Attach the exact same passageText to every sub-question sharing a comprehension/cloze passage. Each question must have exactly four options. Do not invent missing content.`;
    let response: Response;
    try {
      response = await fetch("/api/ai/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, pages: images }),
        signal,
      });
    } catch (reason) {
      if (signal.aborted) throw reason;
      const detail = reason instanceof Error ? reason.message : String(reason);
      throw new Error(`Could not reach the MockForge extraction server. Check that the app server is running. ${detail}`);
    }
    const responseText = await response.text();
    if (!response.ok) {
      let detail = `AI extraction service returned ${response.status}.`;
      if (responseText.trim()) {
        try {
          const errorResult: unknown = JSON.parse(responseText);
          if (
            errorResult &&
            typeof errorResult === "object" &&
            "error" in errorResult &&
            typeof errorResult.error === "string" &&
            errorResult.error
          ) {
            detail = errorResult.error;
          }
        } catch {
          detail = `AI extraction service returned ${response.status}: ${responseText}`;
        }
      }
      throw new Error(detail);
    }
    if (!responseText.trim()) {
      throw new Error("AI extraction service returned an empty response.");
    }
    let result: unknown;
    try {
      result = JSON.parse(responseText) as unknown;
    } catch {
      throw new Error(`AI extraction service returned invalid JSON: ${responseText}`);
    }
    return parseExtracted(JSON.stringify(result));
  };

  const generateMock = async () => {
    if (extractionInFlightRef.current) return;
    if (settings.tier === "Tier 1" && selectedSubjectNames.length === 0) {
      setError("Select at least one Tier 1 subject to generate a mock.");
      return;
    }
    if (!file) {
      setError("Upload a candidate response sheet PDF to continue.");
      return;
    }
    if (startPage < 1 || endPage < startPage || endPage > pageCount) {
      setError(`Choose a valid page range between 1 and ${pageCount}.`);
      return;
    }
    setError("");
    setWarning("");
    setBusy(true);
    extractionInFlightRef.current = true;
    const controller = new AbortController();
    extractionControllerRef.current = controller;
    try {
      setProgress(`Slicing pages ${startPage} to ${endPage}...`);
      const pdfjsLib = await loadPdfJs();
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const images: { page: number; data: string }[] = [];
      for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
        if (controller.signal.aborted) throw new DOMException("Extraction cancelled.", "AbortError");
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Your browser could not create a PDF rendering canvas.");
        await page.render({ canvasContext: context, viewport }).promise;
        if (controller.signal.aborted) throw new DOMException("Extraction cancelled.", "AbortError");
        images.push({ page: pageNumber, data: canvas.toDataURL("image/png").split(",")[1] });
        canvas.width = 0;
        canvas.height = 0;
      }
      setProgress("Extracting questions & scrubbing answer key...");
      const extracted = await extractQuestions(images, controller.signal);
      if (!extracted.length) throw new Error("No questions were found in this page range. Try adjusting the section name or pages.");
      const normalized: Question[] = extracted.map((question, index) => ({
        id: `${Date.now()}-${index}`,
        questionText: scrubArtifacts(question.questionText),
        options: question.options.slice(0, 4).map(scrubArtifacts),
        correctOptionIndex: question.correctOptionIndex,
        passageText: question.passageText ? scrubArtifacts(question.passageText) : undefined,
        visited: false,
        marked: false,
        timeSpentSeconds: 0,
      }));
      setQuestions(normalized);
      setActiveIndex(0);
      activeQuestionRef.current = 0;
      submittedRef.current = false;
      examInitializedRef.current = false;
      if (normalized.length !== settings.expectedQuestions) {
        setWarning(`Expected ${settings.expectedQuestions} questions, but found ${normalized.length}. Review the section before starting.`);
      }
      setView("ready");
    } catch (reason) {
      setError(controller.signal.aborted
        ? "Question extraction was cancelled."
        : reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (extractionControllerRef.current === controller) extractionControllerRef.current = null;
      extractionInFlightRef.current = false;
      setBusy(false);
      setProgress("");
    }
  };

  useEffect(() => {
    const clearSessionKey = () => {
      geminiTestControllerRef.current?.abort();
      geminiTestControllerRef.current = null;
      setGeminiApiKey("");
      setShowGeminiApiKey(false);
      setGeminiConnectionStatus("idle");
    };
    window.addEventListener("pagehide", clearSessionKey);
    return () => {
      window.removeEventListener("pagehide", clearSessionKey);
      geminiTestControllerRef.current?.abort();
      extractionControllerRef.current?.abort();
    };
  }, []);

  const finishAttempt = useCallback(() => {
    if (submittedRef.current || questions.length === 0) return;
    submittedRef.current = true;
    const attempt: Attempt = {
      id: `${Date.now()}`,
      completedAt: new Date().toISOString(),
      sectionName: activeSectionName,
      tier: settings.tier,
      positiveMarks: settings.positiveMarks,
      negativeMarks: settings.negativeMarks,
      elapsedSeconds,
      questions,
    };
    const next = [attempt, ...readAttempts()].slice(0, 12);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      setAttempts(next);
      setStorageWarning("");
    } catch (reason) {
      setStorageWarning(`This mock is available now, but could not be saved to this browser: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    setCurrentAttempt(attempt);
    setSubmitModal(false);
    setView("results");
  }, [elapsedSeconds, questions, settings]);

  useEffect(() => {
    if (view !== "exam" || questions.length === 0) return;
    const interval = window.setInterval(() => {
      setElapsedSeconds((value) => value + 1);
      setQuestions((current) => current.map((question, index) =>
        index === activeQuestionRef.current ? { ...question, timeSpentSeconds: question.timeSpentSeconds + 1 } : question,
      ));
      if (!settings.untimed) setSecondsLeft((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [view, questions.length, settings.untimed]);

  useEffect(() => {
    if (view === "exam" && !settings.untimed && secondsLeft === 0 && elapsedSeconds > 0) finishAttempt();
  }, [elapsedSeconds, finishAttempt, secondsLeft, settings.untimed, view]);

  const changeQuestion = (index: number) => {
    if (index < 0 || index >= questions.length) return;
    activeQuestionRef.current = index;
    setActiveIndex(index);
    setQuestions((current) => current.map((question, questionIndex) =>
      questionIndex === index ? { ...question, visited: true } : question,
    ));
    setMobilePaletteOpen(false);
  };

  const selectOption = (option: number) => {
    setQuestions((current) => current.map((question, index) =>
      index === activeIndex ? { ...question, selectedOption: option } : question,
    ));
  };

  const markAndNext = () => {
    setQuestions((current) => current.map((question, index) =>
      index === activeIndex ? { ...question, marked: true } : question,
    ));
    if (activeIndex < questions.length - 1) changeQuestion(activeIndex + 1);
  };

  const clearResponse = () => setQuestions((current) => current.map((question, index) =>
    index === activeIndex ? { ...question, selectedOption: undefined } : question,
  ));

  const launchRetry = () => {
    if (!currentAttempt) return;
    const retry = currentAttempt.questions.filter((question) =>
      question.selectedOption !== question.correctOptionIndex ||
      question.timeSpentSeconds > 90,
    ).map((question, index) => ({
      ...question,
      id: `${Date.now()}-${index}`,
      visited: index === 0,
      marked: false,
      selectedOption: undefined,
      timeSpentSeconds: 0,
    }));
    if (retry.length === 0) {
      setWarning("No incorrect, skipped, or slow questions to retry. Great work!");
      setView("setup");
      return;
    }
    setQuestions(retry);
    setActiveIndex(0);
    activeQuestionRef.current = 0;
    setQuestionZoom(100);
    setElapsedSeconds(0);
    setSecondsLeft(settings.untimed ? 0 : settings.timerMinutes * 60);
    setWarning("");
    submittedRef.current = false;
    examInitializedRef.current = true;
    setView("exam");
  };

  const currentQuestion = questions[activeIndex];
  const statusCount = (status: QuestionStatus) => questions.filter((question) => statusOf(question) === status).length;
  const rightCount = questions.filter((question) => question.selectedOption === question.correctOptionIndex).length;
  const wrongCount = questions.filter((question) =>
    question.selectedOption !== undefined && question.selectedOption !== question.correctOptionIndex,
  ).length;
  const answeredCount = rightCount + wrongCount;

  if (view === "exam" && currentQuestion) {
    return (
      <>
        <div className="exam-shell">
          <header className="exam-header">
            <div className="brand-lockup exam-brand"><div className="brand-mark"><Layers3 size={19} /></div><span>MockForge</span></div>
            <div className="exam-title"><span>{activeSectionName}</span><b>{settings.tier} <i>•</i> +{settings.positiveMarks} / -{settings.negativeMarks}</b></div>
            <div className="header-right">
              <span className="scheme-pill"><Check size={14} /> Correct: +{settings.positiveMarks} <span>·</span> Wrong: -{settings.negativeMarks}</span>
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
              <button className="icon-btn header-menu" onClick={() => setMobilePaletteOpen((open) => !open)} aria-label="Toggle question palette"><Menu size={19} /></button>
            </div>
          </header>
          {warning && <div className="warning-banner"><CircleHelp size={17} />{warning}<button onClick={() => setWarning("")} aria-label="Dismiss warning"><X size={15} /></button></div>}
          <main className="exam-layout">
            <section className="question-workspace">
              <div className="workspace-topline">
                <span className="workspace-section-name">SECTION: {activeSectionName}</span>
                <div className="workspace-toolbar">
                  <span className="workspace-question-count">{questions.length} QUESTIONS</span>
                  <div className="question-zoom-controls" role="group" aria-label="Question display zoom">
                    <button
                      type="button"
                      className="question-zoom-button"
                      onClick={() => setQuestionZoom((zoom) => Math.max(MIN_QUESTION_ZOOM, zoom - QUESTION_ZOOM_STEP))}
                      disabled={questionZoom === MIN_QUESTION_ZOOM}
                      aria-label="Zoom out"
                      title="Zoom out"
                    >
                      <ZoomOut size={15} />
                    </button>
                    <span className="question-zoom-level" aria-live="polite" aria-atomic="true">{questionZoom}%</span>
                    <button
                      type="button"
                      className="question-zoom-button"
                      onClick={() => setQuestionZoom((zoom) => Math.min(MAX_QUESTION_ZOOM, zoom + QUESTION_ZOOM_STEP))}
                      disabled={questionZoom === MAX_QUESTION_ZOOM}
                      aria-label="Zoom in"
                      title="Zoom in"
                    >
                      <ZoomIn size={15} />
                    </button>
                    <button
                      type="button"
                      className="question-zoom-reset"
                      onClick={() => setQuestionZoom(100)}
                      disabled={questionZoom === 100}
                      aria-label="Reset question zoom to 100%"
                      title="Reset zoom to 100%"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>
              <div className="question-scroll">
                <div className="question-display-content" style={{ zoom: questionZoom / 100 }}>
                  {currentQuestion.passageText && (
                    <div className="passage-card">
                      <div className="passage-heading"><BookOpen size={16} /><span>Comprehension passage</span><span className="passage-lock"><LockKeyhole size={13} /> Shared across questions</span></div>
                      <div className="rich-content passage-copy" dangerouslySetInnerHTML={{ __html: mathAndMarkup(currentQuestion.passageText) }} />
                    </div>
                  )}
                  <div className="question-card">
                    <div className="question-heading"><span className="question-number">Question {activeIndex + 1}</span><span className="question-points">+{settings.positiveMarks} <i>·</i> -{settings.negativeMarks}</span></div>
                    <div className="rich-content question-copy" dangerouslySetInnerHTML={{ __html: mathAndMarkup(currentQuestion.questionText) }} />
                    <div className="options-list">
                      {currentQuestion.options.map((option, index) => (
                        <button
                          key={`${currentQuestion.id}-${index}`}
                          className={`option-row ${currentQuestion.selectedOption === index + 1 ? "option-selected" : ""}`}
                          onClick={() => selectOption(index + 1)}
                        >
                          <span className="option-letter">{index + 1}</span>
                          <span className="rich-content option-copy" dangerouslySetInnerHTML={{ __html: mathAndMarkup(option) }} />
                          <span className="radio-indicator">{currentQuestion.selectedOption === index + 1 && <span />}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="control-bar">
                <button className="btn btn-review" onClick={markAndNext}><ShieldCheck size={16} /><span>Mark for Review <em>&amp; Next</em></span></button>
                <button className="btn btn-outline" onClick={clearResponse}>Clear Response</button>
                <div className="control-spacer" />
                <button className="btn btn-light" onClick={() => changeQuestion(activeIndex - 1)} disabled={activeIndex === 0}><ArrowLeft size={16} /> Previous</button>
                <button className="btn btn-primary" onClick={() => activeIndex < questions.length - 1 ? changeQuestion(activeIndex + 1) : setSubmitModal(true)}>
                  Save &amp; Next <ArrowRight size={16} />
                </button>
                <button className="btn btn-submit" onClick={() => setSubmitModal(true)}>Submit Section</button>
              </div>
            </section>
            <aside className={`exam-sidebar ${mobilePaletteOpen ? "palette-open" : ""}`}>
              <div className="timer-card">
                <div className="timer-label"><Clock3 size={16} />{settings.untimed ? "PRACTICE TIME" : "TIME REMAINING"}</div>
                <div className={`timer-value ${!settings.untimed && secondsLeft < 60 ? "timer-urgent" : ""}`}>{formatClock(settings.untimed ? elapsedSeconds : secondsLeft)}</div>
                <div className="timer-progress"><span style={{ width: `${settings.untimed ? 100 : Math.max(0, (secondsLeft / (settings.timerMinutes * 60)) * 100)}%` }} /></div>
                <div className="timer-caption">{settings.untimed ? "Untimed practice mode" : "Section timer is running"}</div>
              </div>
              <div className="sidebar-card">
                <div className="sidebar-title">Question palette <span>{questions.length}</span></div>
                <div className="palette-counts">
                  <span><i className="count-dot count-green" />{answeredCount} Answered</span>
                  <span><i className="count-dot count-red" />{questions.length - answeredCount} Unanswered</span>
                </div>
                <div className="palette-grid">
                  {questions.map((question, index) => (
                    <button
                      key={question.id}
                      className={`palette-btn palette-${statusOf(question)} ${activeIndex === index ? "palette-current" : ""}`}
                      onClick={() => changeQuestion(index)}
                      aria-label={`Question ${index + 1}, ${statusOf(question)}`}
                    >
                      {index + 1}{question.marked && question.selectedOption !== undefined && <i />}
                    </button>
                  ))}
                </div>
                <div className="palette-legend">
                  <span><i className="legend-box legend-unvisited" />Not Visited <b>{statusCount("not-visited")}</b></span>
                  <span><i className="legend-box legend-unanswered" />Not Answered <b>{statusCount("not-answered")}</b></span>
                  <span><i className="legend-box legend-answered" />Answered <b>{statusCount("answered")}</b></span>
                  <span><i className="legend-box legend-marked" />Marked for Review <b>{statusCount("marked")}</b></span>
                  <span><i className="legend-box legend-answered-marked" />Answered &amp; Marked <b>{statusCount("answered-marked")}</b></span>
                </div>
                <div className="sidebar-footer"><span><CheckCircle2 size={15} />{answeredCount} of {questions.length} answered</span><span>{Math.round((answeredCount / questions.length) * 100)}%</span></div>
              </div>
            </aside>
          </main>
        </div>
        {submitModal && (
          <Modal title="Submit this section?" onClose={() => setSubmitModal(false)}>
            <p className="modal-copy">You have answered <strong>{answeredCount} of {questions.length}</strong> questions. Unanswered questions will be submitted as-is.</p>
            <div className="submit-summary"><span><i className="count-dot count-green" />{answeredCount} Answered</span><span><i className="count-dot count-red" />{questions.length - answeredCount} Unanswered</span></div>
            <div className="modal-actions"><button className="btn btn-light" onClick={() => setSubmitModal(false)}>Go back</button><button className="btn btn-primary" onClick={finishAttempt}>Submit section</button></div>
          </Modal>
        )}
      </>
    );
  }

  if (view === "ready") {
    return (
      <div className="ready-shell">
        <header className="site-header">
          <a className="brand-lockup" href="#" onClick={(event) => event.preventDefault()}><div className="brand-mark"><Layers3 size={19} /></div><span>MockForge</span></a>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </header>
        <main className="ready-main">
          <div className="ready-intro">
            <div className="eyebrow"><span className="eyebrow-dot" /> QUESTIONS EXTRACTED</div>
            <h1>Mock Test Ready</h1>
            <p>Review your test details before starting. Your timer won’t begin until you do.</p>
          </div>
          <section className="ready-card" aria-labelledby="ready-test-name">
            <div className="ready-test-title">
              <span className="ready-file-icon"><FileText size={22} /></span>
              <div><span className="section-kicker">YOUR MOCK TEST</span><h2 id="ready-test-name">{activeSectionName}</h2></div>
              <span className="ready-tier">{settings.tier}</span>
            </div>
            {warning && <div className="setup-warning"><CircleHelp size={17} /><span>{warning}</span><button onClick={() => setWarning("")} aria-label="Dismiss warning"><X size={15} /></button></div>}
            <div className="ready-details">
              <div className="ready-detail"><span>Subject</span><strong>{selectedSubjectLabel}</strong></div>
              <div className="ready-detail"><span>Questions extracted</span><strong>{questions.length}</strong></div>
              <div className="ready-detail"><span>Expected questions</span><strong>{settings.expectedQuestions}</strong></div>
              <div className="ready-detail"><span>Duration</span><strong>{settings.untimed ? "Untimed practice" : `${settings.timerMinutes} minutes`}</strong></div>
              <div className="ready-detail"><span>Correct answer</span><strong>+{settings.positiveMarks} marks</strong></div>
              <div className="ready-detail"><span>Incorrect answer</span><strong>−{settings.negativeMarks} marks</strong></div>
            </div>
            <div className="ready-note"><Clock3 size={16} /><span>The exam timer and question timing start when you begin the mock.</span></div>
            <div className="ready-actions">
              <button className="btn btn-light" onClick={() => setView("setup")}><ArrowLeft size={16} />Back to Setup</button>
              <button className="btn btn-primary" onClick={startExam} disabled={questions.length === 0 || examInitializedRef.current}>Start Mock Test<ArrowRight size={16} /></button>
            </div>
          </section>
        </main>
      </div>
    );
  }

  if (view === "results" && currentAttempt) {
    return <Results
      attempt={currentAttempt}
      filter={reviewFilter}
      setFilter={setReviewFilter}
      storageWarning={storageWarning}
      theme={theme}
      onToggleTheme={toggleTheme}
      onRetry={launchRetry}
      onHome={() => { setWarning(""); setView("setup"); }}
    />;
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand-lockup" href="#" onClick={(event) => event.preventDefault()}><div className="brand-mark"><Layers3 size={19} /></div><span>MockForge</span></a>
        <nav className="header-nav"><span><BookOpen size={15} /> PYQ Mock Test Studio</span><ThemeToggle theme={theme} onToggle={toggleTheme} /><button className="api-settings" onClick={() => setApiModal(true)}><KeyRound size={15} /> API Settings</button></nav>
      </header>
      <main className="home-main">
        <section className="hero-section">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-dot" /> YOUR EXAM, YOUR PACE</div>
            <h1>Turn past papers into<br /><span>your next best score.</span></h1>
            <p>Upload a response sheet. Build a realistic CBT mock. Know exactly where to improve.</p>
            <div className="hero-proof"><span><CheckCircle2 size={16} /> Exam-style interface</span><span><ShieldCheck size={16} /> Answer key stays yours</span></div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-glow" />
            <div className="art-sheet">
              <div className="art-top"><div /><span>RESPONSE SHEET</span><span>•••</span></div>
              <div className="art-line wide" /><div className="art-line medium" />
              <div className="art-question"><b>01</b><div><span /><span /></div></div>
              <div className="art-choices">{[0, 1, 2, 3].map((item) => <i className={item === 2 ? "choice-checked" : ""} key={item}>{item === 2 ? <Check size={12} /> : null}</i>)}</div>
              <div className="art-question second"><b>02</b><div><span /><span /></div></div>
              <div className="art-choices">{[0, 1, 2, 3].map((item) => <i className={item === 0 ? "choice-checked" : ""} key={item}>{item === 0 ? <Check size={12} /> : null}</i>)}</div>
            </div>
            <div className="art-float"><Sparkles size={16} /><span>Ready when you are</span></div>
          </div>
        </section>

        <section className="setup-layout">
          <div className="setup-card">
            <div className="card-heading">
              <div><div className="section-kicker">01 — SET UP YOUR MOCK</div><h2>Start with a question paper</h2><p>Upload your response sheet, then choose exactly what to practise.</p></div>
              <div className="step-badge"><FileText size={17} /> PDF to Mock</div>
            </div>
            <div
              className={`upload-zone ${dragging ? "upload-dragging" : ""} ${file ? "upload-ready" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => pdfInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") pdfInputRef.current?.click(); }}
            >
              <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf" onChange={onFileInput} hidden />
              <div className="upload-icon">{file ? <CheckCircle2 size={23} /> : <Upload size={23} />}</div>
              <div className="upload-copy">
                <strong>{file ? file.name : "Drop your response sheet here"}</strong>
                <span>{file ? `${pageCount} pages detected · Click to replace PDF` : "or browse files · PDF format, up to 50 MB"}</span>
              </div>
              {file && <span className="pdf-chip"><FileText size={13} /> PDF</span>}
              {!file && <button className="browse-btn" type="button">Browse files</button>}
            </div>

            <div className="form-section">
              <div className="form-section-title"><span className="step-number">1</span><div><strong>Choose your exam preset</strong><small>We’ll set the marking scheme and timer for you.</small></div></div>
              <div className="tier-options">
                {(["Tier 1", "Tier 2"] as Tier[]).map((tier) => (
                  <button className={`tier-option ${settings.tier === tier ? "tier-active" : ""}`} onClick={() => applyTier(tier)} key={tier}>
                    <span className={`tier-radio ${settings.tier === tier ? "radio-active" : ""}`}>{settings.tier === tier && <i />}</span>
                    <span className="tier-info"><strong>{tier}</strong><small>{tier === "Tier 1" ? "+2.0 correct · −0.5 wrong" : "+3.0 correct · −1.0 wrong"}</small></span>
                    <span className="tier-time"><Clock3 size={13} />{tier === "Tier 1" ? "15 min" : "Subject based"}</span>
                  </button>
                ))}
              </div>
              {settings.tier === "Tier 1" && (
                <fieldset className="tier1-subjects">
                  <legend>Subjects / modules</legend>
                  <div className="tier1-subject-options">
                    {TIER1_SUBJECTS.map((subject) => {
                      const selected = settings.tier1Subjects.includes(subject);
                      return (
                        <label className={`tier1-subject-option ${selected ? "tier1-subject-selected" : ""}`} key={subject}>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleTier1Subject(subject)}
                          />
                          <span>{subject}</span>
                        </label>
                      );
                    })}
                  </div>
                  <small className="tier1-subject-count">
                    {selectedSubjectNames.length === 0
                      ? "Select at least one subject to generate a mock."
                      : `${selectedSubjectNames.length} of ${TIER1_SUBJECTS.length} subjects selected`}
                  </small>
                </fieldset>
              )}
              {settings.tier === "Tier 2" && (
                <label className="field-label subject-field">Subject module
                  <span className="select-wrap"><select value={settings.subject} onChange={(event) => applySubject(event.target.value)}>{SUBJECTS.map((subject) => <option key={subject.name}>{subject.name}</option>)}</select><ChevronDown size={16} /></span>
                </label>
              )}
            </div>

            <div className="form-section custom-section">
                <label className="custom-toggle">
                  <span className="toggle-copy"><span className="custom-icon"><Settings2 size={16} /></span><span><strong>Custom exam settings</strong><small>Override the preset marks, question count, or timer.</small></span></span>
                  <input type="checkbox" checked={customOverride} onChange={(event) => toggleCustomOverride(event.target.checked)} />
                  <span className="switch" />
                  <span className="untimed-label">Override</span>
              </label>
                <label className="untimed-toggle"><input type="checkbox" checked={settings.untimed} onChange={(event) => patchSettings({ untimed: event.target.checked })} /><span>Untimed practice mode</span></label>
              <div className="custom-fields">
                  <label className={`field-label ${!customOverride ? "field-muted" : ""}`}>Expected questions<input type="number" min="1" max="200" disabled={!customOverride} value={settings.expectedQuestions} onChange={(event) => patchSettings({ expectedQuestions: Math.max(1, Number(event.target.value)) })} /></label>
                  <label className={`field-label ${!customOverride ? "field-muted" : ""}`}>Positive marks (+)<input type="number" min="0" step="0.25" disabled={!customOverride} value={settings.positiveMarks} onChange={(event) => patchSettings({ positiveMarks: Math.max(0, Number(event.target.value)) })} /></label>
                  <label className={`field-label ${!customOverride ? "field-muted" : ""}`}>Negative marks (−)<input type="number" min="0" step="0.05" disabled={!customOverride} value={settings.negativeMarks} onChange={(event) => patchSettings({ negativeMarks: Math.max(0, Number(event.target.value)) })} /></label>
                  <label className={`field-label ${!customOverride || settings.untimed ? "field-muted" : ""}`}>Timer (minutes)<input type="number" min="1" max="240" disabled={!customOverride || settings.untimed} value={settings.timerMinutes} onChange={(event) => patchSettings({ timerMinutes: Math.max(1, Number(event.target.value)) })} /></label>
              </div>
            </div>

            <div className="form-section section-slicer">
              <div className="form-section-title"><span className="step-number">2</span><div><strong>Choose the section &amp; page range</strong><small>Only your selected pages are sent for question extraction.</small></div></div>
              <div className="slicer-fields">
                <label className="field-label">Section name<input type="text" placeholder="e.g. Module I Mathematical Abilities" value={settings.sectionName} onChange={(event) => patchSettings({ sectionName: event.target.value })} /></label>
                <div className="page-range">
                  <label className="field-label">Start page<input type="number" min="1" max={pageCount || undefined} value={startPage} onChange={(event) => setStartPage(Number(event.target.value))} disabled={!file} /></label>
                  <span className="range-dash">to</span>
                  <label className="field-label">End page<input type="number" min="1" max={pageCount || undefined} value={endPage} onChange={(event) => setEndPage(Number(event.target.value))} disabled={!file} /></label>
                  <span className="range-total">/ {pageCount || "—"}</span>
                </div>
              </div>
            </div>

            {warning && <div className="setup-warning"><CircleHelp size={17} /><span>{warning}</span><button onClick={() => setWarning("")} aria-label="Dismiss warning"><X size={15} /></button></div>}
            {error && <div className="error-banner"><CircleHelp size={17} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
            {busy && <div className="progress-banner"><LoaderCircle size={17} className="spin" /><span>{progress}</span><button className="cancel-extraction" onClick={() => extractionControllerRef.current?.abort()}>Cancel</button></div>}
            {busy && <div className="generation-time-notice">This may take approximately 5–10 minutes depending on the PDF size and number of pages. Please keep this tab open while your questions are being processed.</div>}
            <button className="generate-btn" disabled={busy || !file || (settings.tier === "Tier 1" && selectedSubjectNames.length === 0)} onClick={() => void generateMock()}>
              {busy ? <><LoaderCircle size={17} className="spin" /> Building your mock...</> : <>Generate section mock <ArrowRight size={17} /></>}
            </button>
            <div className="privacy-note"><LockKeyhole size={13} />Selected pages only · Your response sheet stays private</div>
          </div>

          <aside className="setup-aside">
            <div className="how-card">
              <div className="how-icon"><Sparkles size={18} /></div><h3>From PDF to practice</h3>
              <p>MockForge reads the questions, preserves the official answer key, and builds your own exam simulator.</p>
              <div className="how-steps">
                <div><i>01</i><span><strong>Pick your pages</strong><small>Skip covers and unrelated sections</small></span></div>
                <div><i>02</i><span><strong>Questions are extracted</strong><small>Math, passages &amp; answers preserved</small></span></div>
                <div><i>03</i><span><strong>Take the mock</strong><small>Review your score and weak spots</small></span></div>
              </div>
            </div>
            <div className="secure-card"><div className="secure-icon"><ShieldCheck size={17} /></div><div><strong>AI keys stay server-side</strong><p>Gemini is called by the app server; Lovable AI remains an optional fallback.</p></div><button onClick={() => setApiModal(true)} aria-label="Open API settings"><ArrowRight size={16} /></button></div>
          </aside>
        </section>

        <section className="recent-section">
          <div className="recent-heading"><div><div className="section-kicker">YOUR PRACTICE, IN PROGRESS</div><h2>Recent mocks</h2></div><span className="history-count">{attempts.length} {attempts.length === 1 ? "attempt" : "attempts"}</span></div>
          {attempts.length === 0 ? (
            <div className="empty-history"><div><History size={19} /></div><span><strong>Your completed mocks will show up here</strong><small>Finish your first section to start tracking your progress.</small></span><BarChart3 size={20} className="empty-chart" /></div>
          ) : (
            <div className="history-list">{attempts.slice(0, 4).map((attempt) => {
              const score = getScore(attempt);
            return <button className="history-row" key={attempt.id} onClick={() => { setCurrentAttempt(attempt); setReviewFilter("All"); setStorageWarning(""); setView("results"); setSettings((current) => ({ ...current, tier: attempt.tier, positiveMarks: attempt.positiveMarks, negativeMarks: attempt.negativeMarks, sectionName: attempt.sectionName, expectedQuestions: attempt.questions.length })); }}>
                <span className="history-file"><FileText size={17} /></span><span className="history-meta"><strong>{attempt.sectionName}</strong><small>{attempt.tier} · {new Date(attempt.completedAt).toLocaleDateString()} · {attempt.questions.length} questions</small></span><span className="history-score"><b>{score.net.toFixed(2)}</b><small>score</small></span><ArrowRight size={17} />
              </button>;
            })}</div>
          )}
        </section>
        <footer className="site-footer"><span>MockForge <i>·</i> Built for better practice</span><span><LockKeyhole size={12} /> Your attempts are saved on this device</span></footer>
      </main>
      {apiModal && <Modal title="Google Gemini API settings" onClose={() => setApiModal(false)}>
        <p className="modal-copy">Add a Gemini key to test its connection. The key stays in this page’s memory, is cleared when the page session ends, and is not saved to your browser. This key is only used for the connection test; PDF extraction continues using the server’s existing environment configuration.</p>
        <section className="gemini-settings" aria-label="Google Gemini configuration">
          <div className="provider-heading"><span className="provider-mark">G</span><div><strong>Google Gemini</strong><small>Bring your own API key</small></div></div>
          <label className="field-label key-field">API key
            <span className="api-key-control">
              <input
                type={showGeminiApiKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={geminiApiKey}
                onChange={(event) => {
                  geminiTestControllerRef.current?.abort();
                  geminiTestControllerRef.current = null;
                  setGeminiApiKey(event.target.value);
                  setGeminiConnectionStatus("idle");
                }}
                placeholder="Paste your Gemini API key"
                aria-label="Google Gemini API key"
              />
              <button
                className="key-visibility"
                type="button"
                onClick={() => setShowGeminiApiKey((current) => !current)}
                aria-label={showGeminiApiKey ? "Hide API key" : "Show API key"}
              >{showGeminiApiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </span>
          </label>
          <a className="gemini-key-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">
            Get an API key from Google AI Studio <ArrowRight size={13} />
          </a>
          <div className={`connection-status connection-${geminiConnectionStatus}`} role="status" aria-live="polite">
            <span className="connection-dot" />
            {geminiConnectionStatus === "idle" && "Not tested"}
            {geminiConnectionStatus === "testing" && <><LoaderCircle size={14} className="spin" /> Testing connection...</>}
            {geminiConnectionStatus === "connected" && "Connection successful. The API key is valid."}
            {geminiConnectionStatus === "invalid_key" && (geminiApiKey.trim() ? "Google rejected this API key. Check that it is correct and active." : "Enter an API key to test the connection.")}
            {geminiConnectionStatus === "quota" && "The key is valid, but its Gemini quota or rate limit has been reached."}
            {geminiConnectionStatus === "network" && "Could not reach Google Gemini. Check your network connection and try again."}
            {geminiConnectionStatus === "timeout" && "The connection test timed out. Try again in a moment."}
            {geminiConnectionStatus === "api_error" && (window.location.protocol !== "https:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname)
              ? "Use a secure HTTPS connection to test your API key."
              : "Google Gemini could not complete the connection test. Check the key's API access and try again.")}
            {geminiConnectionStatus === "cleared" && "API key cleared from this session."}
          </div>
          <div className="gemini-actions">
            <button className="btn btn-outline" type="button" disabled={!geminiApiKey} onClick={() => {
              geminiTestControllerRef.current?.abort();
              geminiTestControllerRef.current = null;
              setGeminiApiKey("");
              setShowGeminiApiKey(false);
              setGeminiConnectionStatus("cleared");
            }}>Clear API Key</button>
            <button className="btn btn-primary" type="button" disabled={geminiConnectionStatus === "testing"} onClick={() => void testGeminiConnection()}>
              {geminiConnectionStatus === "testing" ? <><LoaderCircle size={14} className="spin" /> Testing...</> : "Test Connection"}
            </button>
          </div>
        </section>
        <div className="key-hint"><KeyRound size={14} /><span>The key is sent to this app’s server using HTTPS (localhost is allowed for development) and is never included in the URL or returned by the server.</span></div>
        <div className="modal-actions"><button className="btn btn-light" onClick={() => setApiModal(false)}>Done</button></div>
      </Modal>}
    </div>
  );
}

function parseExtracted(text: string): ExtractedQuestion[] {
  const json = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The extraction service returned invalid JSON. Please retry or select a smaller page range.");
  }
  const container = parsed as { questions?: unknown };
  if (!Array.isArray(container.questions)) throw new Error("The extraction response did not contain a questions array.");
  const output: ExtractedQuestion[] = [];
  for (const candidate of container.questions) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.questionText !== "string" ||
      !Array.isArray(item.options) ||
      item.options.length !== 4 ||
      !item.options.every((option) => typeof option === "string") ||
      ![1, 2, 3, 4].includes(Number(item.correctOptionIndex))
    ) continue;
    output.push({
      questionText: item.questionText,
      options: item.options as string[],
      correctOptionIndex: Number(item.correctOptionIndex),
      ...(typeof item.passageText === "string" ? { passageText: item.passageText } : {}),
    });
  }
  return output;
}

function scrubArtifacts(text: string): string {
  return text
    .replace(/[✔✓✗]/g, "")
    .replace(/\b(?:Question ID|Option ID|Status|Chosen Option)\s*[:#-]?\s*[\w-]*/gi, "")
    .replace(/\b(?:Adda247|Google Play)\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function getScore(attempt: Attempt) {
  const correct = attempt.questions.filter((question) => question.selectedOption === question.correctOptionIndex).length;
  const wrong = attempt.questions.filter((question) => question.selectedOption !== undefined && question.selectedOption !== question.correctOptionIndex).length;
  const attempted = correct + wrong;
  const positiveEarned = correct * attempt.positiveMarks;
  const negativeLost = wrong * attempt.negativeMarks;
  return {
    correct, wrong, attempted, unattempted: attempt.questions.length - attempted,
    positiveEarned, negativeLost, net: positiveEarned - negativeLost,
    max: attempt.questions.length * attempt.positiveMarks,
    accuracy: attempted ? (correct / attempted) * 100 : 0,
    totalTime: attempt.elapsedSeconds,
    averageTime: attempt.questions.length ? attempt.elapsedSeconds / attempt.questions.length : 0,
  };
}

function Results({ attempt, filter, setFilter, storageWarning, theme, onToggleTheme, onRetry, onHome }: {
  attempt: Attempt;
  filter: string;
  setFilter: (filter: string) => void;
  storageWarning: string;
  theme: Theme;
  onToggleTheme: () => void;
  onRetry: () => void;
  onHome: () => void;
}) {
  const score = getScore(attempt);
  const filters = ["All", "Incorrect", "Unattempted", "Slow > 90s", "Correct"];
  const visible = attempt.questions.filter((question) => {
    if (filter === "Incorrect") return question.selectedOption !== undefined && question.selectedOption !== question.correctOptionIndex;
    if (filter === "Unattempted") return question.selectedOption === undefined;
    if (filter === "Slow > 90s") return question.timeSpentSeconds > 90;
    if (filter === "Correct") return question.selectedOption === question.correctOptionIndex;
    return true;
  });
  return (
    <div className="results-shell">
      <header className="site-header">
        <a className="brand-lockup" href="#" onClick={(event) => event.preventDefault()}><div className="brand-mark"><Layers3 size={19} /></div><span>MockForge</span></a>
        <div className="results-header-right"><span>{attempt.sectionName}</span><ThemeToggle theme={theme} onToggle={onToggleTheme} /><button className="btn btn-light btn-small" onClick={onHome}><ArrowLeft size={15} />Back to setup</button></div>
      </header>
      <main className="results-main">
        {storageWarning && <div className="error-banner results-storage-warning"><CircleHelp size={17} /><span>{storageWarning}</span></div>}
        <div className="results-intro"><div className="eyebrow"><span className="eyebrow-dot" /> SECTION COMPLETE</div><h1>Your practice, <span>decoded.</span></h1><p>{attempt.sectionName} <i>·</i> {new Date(attempt.completedAt).toLocaleString()}</p></div>
        <div className="score-grid">
          <div className="score-card score-primary"><div className="score-card-label"><BarChart3 size={16} /> NET SCORE</div><div className="score-large">{score.net.toFixed(2)}<span> / {score.max.toFixed(2)}</span></div><div className="score-note">{attempt.tier} <i>·</i> +{attempt.positiveMarks} / −{attempt.negativeMarks}</div><div className="score-progress"><span style={{ width: `${score.max ? Math.max(0, Math.min(100, (score.net / score.max) * 100)) : 0}%` }} /></div></div>
          <Metric label="Positive marks" value={`+${score.positiveEarned.toFixed(2)}`} detail={`${score.correct} correct`} icon={<CheckCircle2 size={16} />} tone="green" />
          <Metric label="Negative marks" value={`−${score.negativeLost.toFixed(2)}`} detail={`${score.wrong} incorrect`} icon={<X size={16} />} tone="red" />
          <Metric label="Accuracy" value={`${score.accuracy.toFixed(1)}%`} detail={`${score.correct} of ${score.attempted} attempted`} icon={<BarChart3 size={16} />} tone="blue" />
          <Metric label="Attempted" value={`${score.attempted} / ${attempt.questions.length}`} detail={`${score.unattempted} unattempted`} icon={<FileText size={16} />} tone="purple" />
          <Metric label="Total time" value={formatClock(score.totalTime)} detail={`Avg. ${Math.round(score.averageTime)}s per question`} icon={<Clock3 size={16} />} tone="amber" />
        </div>
        <div className="review-topline"><div><h2>Question review</h2><p>Understand every answer, then take another shot at the tough ones.</p></div><button className="btn btn-primary retry-btn" onClick={onRetry}><RotateCcw size={16} />Re-attempt wrong &amp; slow</button></div>
        <div className="review-filters">{filters.map((name) => <button key={name} onClick={() => setFilter(name)} className={filter === name ? "filter-active" : ""}>{name}<small>{name === "All" ? attempt.questions.length : name === "Incorrect" ? score.wrong : name === "Unattempted" ? score.unattempted : name === "Slow > 90s" ? attempt.questions.filter((q) => q.timeSpentSeconds > 90).length : score.correct}</small></button>)}</div>
        <div className="review-list">
          {visible.length === 0 ? <div className="review-empty">No questions in this category.</div> : visible.map((question) => {
            const index = attempt.questions.indexOf(question);
            const isCorrect = question.selectedOption === question.correctOptionIndex;
            const isUnattempted = question.selectedOption === undefined;
            const slow = question.timeSpentSeconds > 90;
            return <article className="review-card" key={question.id}>
              <div className="review-card-head"><span className="review-q-number">Question {index + 1}</span><span className={`review-result ${isCorrect ? "result-correct" : isUnattempted ? "result-unattempted" : "result-wrong"}`}>{isCorrect ? <><Check size={13} /> Correct</> : isUnattempted ? "Unattempted" : <><X size={13} /> Incorrect</>}</span><span className={`review-time ${slow ? "time-slow" : ""}`}><Clock3 size={13} />{question.timeSpentSeconds}s</span></div>
              {question.passageText && <div className="review-passage"><BookOpen size={13} /><div className="rich-content" dangerouslySetInnerHTML={{ __html: mathAndMarkup(question.passageText) }} /></div>}
              <div className="rich-content review-question-text" dangerouslySetInnerHTML={{ __html: mathAndMarkup(question.questionText) }} />
              <div className="review-options">{question.options.map((option, optionIndex) => {
                const number = optionIndex + 1;
                const correctOption = number === question.correctOptionIndex;
                const chosenOption = number === question.selectedOption;
                return <div key={number} className={`review-option ${correctOption ? "review-option-correct" : ""} ${chosenOption && !correctOption ? "review-option-wrong" : ""}`}><span>{number}</span><div className="rich-content" dangerouslySetInnerHTML={{ __html: mathAndMarkup(option) }} />{correctOption && <b><Check size={13} /> Official answer</b>}{chosenOption && <em>Your answer</em>}</div>;
              })}</div>
            </article>;
          })}
        </div>
        <footer className="results-footer"><span>MockForge <i>·</i> Keep showing up. The score will follow.</span><button onClick={onHome}>Start another mock <ArrowRight size={14} /></button></footer>
      </main>
    </div>
  );
}

function Metric({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: ReactNode; tone: string }) {
  return <div className="metric-card"><div className={`metric-icon metric-${tone}`}>{icon}</div><span className="metric-label">{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? Sun : Moon;
  return (
    <button className="theme-toggle" type="button" onClick={onToggle} aria-label={`Switch to ${nextTheme} theme`} title={`Switch to ${nextTheme} theme`}>
      <Icon size={17} aria-hidden="true" />
      <span>{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><div><span className="modal-icon"><Settings2 size={17} /></span><h2>{title}</h2></div><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={19} /></button></div>{children}</section></div>;
}

export default App;
