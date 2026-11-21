import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, ReactNode } from "react";
import {
  ArrowLeft, ArrowRight, BarChart3, BookOpen, Check, CheckCircle2, ChevronDown,
  CircleHelp, Clock3, FileText, History, KeyRound, Layers3, LoaderCircle, LockKeyhole,
  Menu, Moon, RotateCcw, Settings2, ShieldCheck, Sparkles, Sun, Upload, X, ZoomIn, ZoomOut,
} from "lucide-react";
import DOMPurify from "dompurify";
import katex from "katex";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  createStableId,
  savePdfRecord,
  addExtraction,
  addMockTest,
  getMockTest,
  listMockTests,
  addAttempt,
  updateAttempt,
  listAttempts,
  deleteAttempt,
  getAttempt,
  listPdfs,
  getPdf,
  updatePdf,
  deletePdf,
  updateMockTest,
  deleteMockTest,
  getSetting,
  setSetting,
} from "./lib/storage";
import type { AttemptRecord, AttemptQuestionState, AttemptScore, ExtractionRecord, MockTestRecord, PdfRecord, StoredQuestion } from "./lib/storage";

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | undefined;

async function loadPdfJs() {
  const pdfjsLib = await (pdfJsPromise ??= import("pdfjs-dist"));
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
  return pdfjsLib;
}

type Tier = "Tier 1" | "Tier 2";
type ExamName = "SSC CGL" | "SSC CHSL";
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
  examName: ExamName;
  subject: string;
  selectedSubjects: string[];
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
  untracked?: boolean;
};
type ExtractedQuestion = {
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  passageText?: string;
};

const HISTORY_KEY = "mockforge.attempts";
const THEME_KEY = "mockforge.theme";
const MIN_QUESTION_ZOOM = 70;
const MAX_QUESTION_ZOOM = 150;
const QUESTION_ZOOM_STEP = 10;
const SUBJECTS = [
  { name: "Mathematical Abilities", questions: 30, minutes: 35 },
  { name: "Reasoning & General Intelligence", questions: 30, minutes: 25 },
  { name: "English Language & Comprehension", questions: 45, minutes: 45 },
  { name: "General Awareness", questions: 25, minutes: 15 },
  { name: "Computer Knowledge Module", questions: 20, minutes: 15 },
];
const TIER1_SUBJECTS = [
  "General Intelligence & Reasoning",
  "General Awareness",
  "Quantitative Aptitude",
  "English Comprehension",
];

const initialSettings: ExamSettings = {
  tier: "Tier 1",
  examName: "SSC CGL",
  subject: SUBJECTS[0].name,
  selectedSubjects: [...TIER1_SUBJECTS],
  expectedQuestions: 100,
  positiveMarks: 2,
  negativeMarks: 0.5,
  timerMinutes: 60,
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
  const [savedPdfId, setSavedPdfId] = useState<string | null>(null);
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
  const [view, setView] = useState<"setup" | "library" | "ready" | "exam" | "results">("setup");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [apiModal, setApiModal] = useState(false);
  const [submitModal, setSubmitModal] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[]>(readAttempts);
  const [currentAttempt, setCurrentAttempt] = useState<Attempt | null>(null);
  const [storageWarning, setStorageWarning] = useState("");
  const [reviewFilter, setReviewFilter] = useState("All");
  const [mobilePaletteOpen, setMobilePaletteOpen] = useState(false);
  const [savedMocks, setSavedMocks] = useState<MockTestRecord[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [currentMockId, setCurrentMockId] = useState<string | null>(null);
  const [startingAttempt, setStartingAttempt] = useState(false);
  const [untrackedPractice, setUntrackedPractice] = useState(false);
  const [completedAttemptCounts, setCompletedAttemptCounts] = useState<Record<string, number>>({});
  const [latestAttemptDates, setLatestAttemptDates] = useState<Record<string, number>>({});
  const [unfinishedAttempts, setUnfinishedAttempts] = useState<AttemptRecord[]>([]);
  const [savedPdfs, setSavedPdfs] = useState<PdfRecord[]>([]);
  const [migrationStatus, setMigrationStatus] = useState<"idle" | "running" | "complete" | "failed">("idle");
  const [autosaveRevision, setAutosaveRevision] = useState(0);
  const activeQuestionRef = useRef(0);
  const submittedRef = useRef(false);
  const extractionInFlightRef = useRef(false);
  const extractionControllerRef = useRef<AbortController | null>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const examInitializedRef = useRef(false);
  const pdfUploadSequenceRef = useRef(0);
  const pdfPersistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const savedMockOpenSequenceRef = useRef(0);
  const activeAttemptIdRef = useRef<string | null>(null);
  const activeAttemptStartedAtRef = useRef<number | null>(null);
  const activeAttemptMockTestIdRef = useRef<string | null>(null);
  const attemptCreationInFlightRef = useRef(false);
  const untrackedPracticeRef = useRef(false);
  const autosaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const autosavePausedRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  const activeAttemptSnapshotRef = useRef<AttemptRecord | null>(null);
  const latestQuestionsRef = useRef<Question[]>([]);
  const latestElapsedRef = useRef(0);
  const latestRemainingRef = useRef(0);
  const latestActiveIndexRef = useRef(0);
  const latestSettingsRef = useRef(settings);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The selected theme remains active for this session if storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    void listAttempts().then((records) => {
      setUnfinishedAttempts(records
        .filter((record) => record.status === "in-progress")
        .sort((left, right) => right.updatedAt - left.updatedAt));
    }).catch((reason) => {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not check for unfinished attempts: ${detail}`);
    });
  }, []);

  useEffect(() => {
    void migrateLegacyHistory();
  }, []);

  useEffect(() => {
    void listPdfs().then(setSavedPdfs).catch((reason) => {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not load saved PDFs: ${detail}`);
    });
  }, []);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  const patchSettings = (patch: Partial<ExamSettings>) => setSettings((current) => ({ ...current, ...patch }));
  latestQuestionsRef.current = questions;
  latestElapsedRef.current = elapsedSeconds;
  latestRemainingRef.current = secondsLeft;
  latestActiveIndexRef.current = activeIndex;
  latestSettingsRef.current = settings;
  const migrateLegacyHistory = async () => {
    if (migrationStatus === "running") return;
    setMigrationStatus("running");
    try {
      const marker = await getSetting("legacy-attempt-migration-v1");
      if (marker === "completed") {
        setMigrationStatus("complete");
        return;
      }
      let legacy: unknown = [];
      try {
        legacy = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
      } catch {
        setMigrationStatus("failed");
        setStorageWarning("Legacy attempt history was malformed and could not be migrated.");
        return;
      }
      if (!Array.isArray(legacy)) {
        setMigrationStatus("failed");
        setStorageWarning("Legacy attempt history was incompatible and could not be migrated.");
        return;
      }
      for (const candidate of legacy) {
        if (!candidate || typeof candidate !== "object") continue;
        const item = candidate as Record<string, unknown>;
        if (
          typeof item.id !== "string" ||
          typeof item.completedAt !== "string" ||
          typeof item.sectionName !== "string" ||
          typeof item.tier !== "string" ||
          typeof item.elapsedSeconds !== "number" ||
          !Array.isArray(item.questions)
        ) continue;
        const existing = await getAttempt(item.id);
        if (existing) continue;
        const completedAt = Date.parse(item.completedAt);
        if (!Number.isFinite(completedAt)) continue;
        const positiveMarks = typeof item.positiveMarks === "number" ? item.positiveMarks : 0;
        const negativeMarks = typeof item.negativeMarks === "number" ? item.negativeMarks : 0;
        const tier = item.tier === "Tier 2" ? "Tier 2" : "Tier 1";
        const sectionName = item.sectionName;
        const legacyQuestions: Question[] = [];
        for (const questionCandidate of item.questions) {
          if (!questionCandidate || typeof questionCandidate !== "object") continue;
          const question = questionCandidate as Record<string, unknown>;
          if (
            typeof question.id !== "string" ||
            typeof question.questionText !== "string" ||
            !Array.isArray(question.options) ||
            typeof question.correctOptionIndex !== "number"
          ) continue;
          legacyQuestions.push({
            id: question.id,
            questionText: question.questionText,
            options: question.options.filter((option): option is string => typeof option === "string"),
            correctOptionIndex: question.correctOptionIndex,
            ...(typeof question.passageText === "string" ? { passageText: question.passageText } : {}),
            selectedOption: typeof question.selectedOption === "number" ? question.selectedOption : undefined,
            visited: typeof question.visited === "boolean" ? question.visited : false,
            marked: typeof question.marked === "boolean" ? question.marked : false,
            timeSpentSeconds: typeof question.timeSpentSeconds === "number" ? question.timeSpentSeconds : 0,
          });
        }
        if (!legacyQuestions.length) continue;
        const mockId = `legacy-mock-${item.id}`;
        if (!await getMockTest(mockId)) {
          const storedQuestions: StoredQuestion[] = legacyQuestions.map((question, index) => ({
            id: question.id,
            order: index,
            subject: tier === "Tier 2" ? sectionName : undefined,
            questionText: question.questionText,
            options: [...question.options],
            correctOptionIndex: question.correctOptionIndex,
            passageText: question.passageText,
            formatVersion: 1,
          }));
          await addMockTest({
            id: mockId,
            name: `Migrated · ${sectionName}`,
            exam: {
              tier,
              examName: "SSC CGL",
              subject: sectionName,
              selectedSubjects: tier === "Tier 1" ? [] : [sectionName],
              expectedQuestions: legacyQuestions.length,
              positiveMarks,
              negativeMarks,
              timerMinutes: tier === "Tier 1" ? 60 : 35,
              untimed: false,
              sectionName,
              navigationRules: { allowPrevious: true, allowNext: true, allowMarkForReview: true },
            },
            questions: storedQuestions,
            questionOrder: storedQuestions.map((question) => question.id),
            createdAt: completedAt,
            updatedAt: completedAt,
          });
        }
        const legacyAttempt: Attempt = {
          id: item.id,
          completedAt: item.completedAt,
          sectionName,
          tier,
          positiveMarks,
          negativeMarks,
          elapsedSeconds: item.elapsedSeconds,
          questions: legacyQuestions,
        };
        const score = getScore(legacyAttempt);
        const storedQuestions: StoredQuestion[] = legacyQuestions.map((question, index) => ({
          id: question.id,
          order: index,
          subject: tier === "Tier 2" ? sectionName : undefined,
          questionText: question.questionText,
          options: [...question.options],
          correctOptionIndex: question.correctOptionIndex,
          passageText: question.passageText,
          formatVersion: 1,
        }));
        const states: AttemptQuestionState[] = legacyQuestions.map((question) => ({
          questionId: question.id,
          selectedOption: question.selectedOption,
          visited: question.visited,
          marked: question.marked,
          timeSpentSeconds: question.timeSpentSeconds,
        }));
        const attemptRecord: AttemptRecord = {
          id: item.id,
          mockTestId: mockId,
          status: "completed",
          startedAt: completedAt - item.elapsedSeconds * 1000,
          completedAt,
          mockName: `Migrated · ${sectionName}`,
          exam: {
            tier,
            examName: "SSC CGL",
            subject: sectionName,
            selectedSubjects: tier === "Tier 1" ? [] : [sectionName],
            expectedQuestions: legacyQuestions.length,
            positiveMarks,
            negativeMarks,
            timerMinutes: tier === "Tier 1" ? 60 : 35,
            untimed: false,
            sectionName,
            navigationRules: { allowPrevious: true, allowNext: true, allowMarkForReview: true },
          },
          questions: storedQuestions,
          questionOrder: storedQuestions.map((question) => question.id),
          answers: states,
          questionStates: states,
          activeQuestionIndex: legacyQuestions.length - 1,
          remainingSeconds: 0,
          elapsedSeconds: item.elapsedSeconds,
          perQuestionTiming: Object.fromEntries(legacyQuestions.map((question) => [question.id, question.timeSpentSeconds])),
          score: {
            correct: score.correct,
            wrong: score.wrong,
            attempted: score.attempted,
            unattempted: score.unattempted,
            positiveEarned: score.positiveEarned,
            negativeLost: score.negativeLost,
            net: score.net,
            max: score.max,
            accuracy: score.accuracy,
            totalTime: score.totalTime,
            averageTime: score.averageTime,
          },
          createdAt: completedAt - item.elapsedSeconds * 1000,
          updatedAt: completedAt,
        };
        await addAttempt(attemptRecord);
      }
      await setSetting("legacy-attempt-migration-v1", "completed");
      setMigrationStatus("complete");
    } catch (reason) {
      setMigrationStatus("failed");
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Attempt migration did not complete: ${detail}`);
    }
  };
  const openLibrary = async () => {
    setLibraryLoading(true);
    setStorageWarning("");
    try {
      const [mocks, attempts, pdfs] = await Promise.all([listMockTests(), listAttempts(), listPdfs()]);
      setSavedMocks([...mocks].sort((left, right) => right.createdAt - left.createdAt));
      setSavedPdfs([...pdfs].sort((left, right) => right.createdAt - left.createdAt));
      const counts: Record<string, number> = {};
      const latest: Record<string, number> = {};
      for (const attempt of attempts) {
        if (attempt.status !== "completed" || !attempt.completedAt) continue;
        counts[attempt.mockTestId] = (counts[attempt.mockTestId] ?? 0) + 1;
        latest[attempt.mockTestId] = Math.max(latest[attempt.mockTestId] ?? 0, attempt.completedAt);
      }
      setCompletedAttemptCounts(counts);
      setLatestAttemptDates(latest);
    } catch (reason) {
      setSavedMocks([]);
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not load the saved mock library: ${detail}`);
    } finally {
      setLibraryLoading(false);
      setView("library");
    }
  };
  const renamePdf = async (pdf: PdfRecord) => {
    const nextName = window.prompt("Rename PDF", pdf.filename)?.trim();
    if (!nextName || nextName === pdf.filename) return;
    try {
      if (!await getPdf(pdf.id)) {
        setSavedPdfs((current) => current.filter((item) => item.id !== pdf.id));
        setStorageWarning("This PDF was already deleted.");
        return;
      }
      const updated = { ...pdf, filename: nextName, updatedAt: Date.now() };
      await updatePdf(updated);
      setSavedPdfs((current) => current.map((item) => item.id === pdf.id ? updated : item));
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not rename the PDF: ${detail}`);
    }
  };
  const deletePdfRecord = async (pdf: PdfRecord) => {
    if (!window.confirm(`Delete "${pdf.filename}"? Saved mocks and attempts will remain available.`)) return;
    try {
      await deletePdf(pdf.id);
      setSavedPdfs((current) => current.filter((item) => item.id !== pdf.id));
      if (savedPdfId === pdf.id) setSavedPdfId(null);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not delete the PDF: ${detail}`);
    }
  };
  const renameMock = async (mock: MockTestRecord) => {
    const nextName = window.prompt("Rename saved mock", mock.name)?.trim();
    if (!nextName || nextName === mock.name) return;
    try {
      if (!await getMockTest(mock.id)) {
        setSavedMocks((current) => current.filter((item) => item.id !== mock.id));
        setStorageWarning("This saved mock was already deleted.");
        return;
      }
      const updated = { ...mock, name: nextName, updatedAt: Date.now() };
      await updateMockTest(updated);
      setSavedMocks((current) => current.map((item) => item.id === mock.id ? updated : item));
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not rename the saved mock: ${detail}`);
    }
  };
  const deleteMockRecord = async (mock: MockTestRecord) => {
    if (!window.confirm(`Delete "${mock.name}"? Completed attempts and their history will remain available.`)) return;
    try {
      await deleteMockTest(mock.id);
      savedMockOpenSequenceRef.current += 1;
      setSavedMocks((current) => current.filter((item) => item.id !== mock.id));
      if (currentMockId === mock.id) setCurrentMockId(null);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not delete the saved mock: ${detail}`);
    }
  };
  const discardUnfinishedAttempt = async (attemptId: string) => {
    if (!window.confirm("Discard this unfinished attempt? Completed attempts will not be removed.")) return;
    try {
      await deleteAttempt(attemptId);
      setUnfinishedAttempts((current) => current.filter((attempt) => attempt.id !== attemptId));
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not discard the unfinished attempt: ${detail}`);
    }
  };
  const resumeUnfinishedAttempt = async (attempt: AttemptRecord) => {
    if (activeAttemptIdRef.current) {
      setStorageWarning("Finish or leave the current attempt before resuming another.");
      return;
    }
    try {
      let storedQuestions = attempt.questions;
      if (!storedQuestions?.length) {
        const mock = await getMockTest(attempt.mockTestId);
        if (!mock) throw new Error("The source mock was deleted and this attempt has no saved question snapshot.");
        storedQuestions = mock.questions;
      }
      if (!storedQuestions?.length) throw new Error("This unfinished attempt has no restorable question data.");
      const orderedIds = attempt.questionOrder?.length
        ? attempt.questionOrder
        : storedQuestions.map((question) => question.id);
      const orderedQuestions = orderedIds
        .map((questionId) => storedQuestions?.find((question) => question.id === questionId))
        .filter((question): question is StoredQuestion => Boolean(question));
      const remaining = storedQuestions.filter((question) => !orderedIds.includes(question.id));
      const states = attempt.questionStates?.length ? attempt.questionStates : attempt.answers;
      const stateById = new Map(states.map((state) => [state.questionId, state]));
      const runtimeQuestions: Question[] = [...orderedQuestions, ...remaining].map((question) => {
        const state = stateById.get(question.id);
        return {
          id: question.id,
          questionText: question.questionText,
          options: [...question.options],
          correctOptionIndex: question.correctOptionIndex,
          passageText: question.passageText,
          selectedOption: state?.selectedOption,
          visited: state?.visited ?? false,
          marked: state?.marked ?? false,
          timeSpentSeconds: state?.timeSpentSeconds ?? 0,
        };
      });
      const exam = attempt.exam;
      if (exam) {
        setSettings({
          ...exam,
          subject: exam.subject,
          selectedSubjects: [...exam.selectedSubjects],
        });
      }
      setQuestions(runtimeQuestions);
      setActiveIndex(Math.max(0, Math.min(attempt.activeQuestionIndex, runtimeQuestions.length - 1)));
      activeQuestionRef.current = Math.max(0, Math.min(attempt.activeQuestionIndex, runtimeQuestions.length - 1));
      setElapsedSeconds(attempt.elapsedSeconds);
      latestElapsedRef.current = attempt.elapsedSeconds;
      setSecondsLeft(attempt.exam?.untimed ? 0 : attempt.remainingSeconds);
      latestRemainingRef.current = attempt.exam?.untimed ? 0 : attempt.remainingSeconds;
      setCurrentMockId(attempt.mockTestId);
      activeAttemptIdRef.current = attempt.id;
      activeAttemptStartedAtRef.current = attempt.startedAt;
      activeAttemptMockTestIdRef.current = attempt.mockTestId;
      activeAttemptSnapshotRef.current = attempt;
      untrackedPracticeRef.current = false;
      setUntrackedPractice(false);
      submittedRef.current = false;
      examInitializedRef.current = true;
      autosavePausedRef.current = false;
      setWarning("");
      setStorageWarning("");
      setUnfinishedAttempts((current) => current.filter((item) => item.id !== attempt.id));
      setView("exam");
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not resume this unfinished attempt: ${detail}`);
    }
  };
  const saveActiveAttemptCheckpoint = (): Promise<void> => {
    const attemptId = activeAttemptIdRef.current;
    if (!attemptId || untrackedPracticeRef.current || autosavePausedRef.current) return Promise.resolve();
    const operation = autosaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!activeAttemptIdRef.current || activeAttemptIdRef.current !== attemptId) return;
        const snapshot = activeAttemptSnapshotRef.current;
        if (!snapshot) return;
        const now = Date.now();
        const currentSettings = latestSettingsRef.current;
        const currentQuestions = latestQuestionsRef.current;
        const states: AttemptQuestionState[] = currentQuestions.map((question) => ({
          questionId: question.id,
          selectedOption: question.selectedOption,
          visited: question.visited,
          marked: question.marked,
          timeSpentSeconds: question.timeSpentSeconds,
        }));
        const checkpoint: AttemptRecord = {
          ...snapshot,
          status: "in-progress",
          mockName: snapshot.mockName ?? (currentSettings.sectionName || (currentSettings.tier === "Tier 1" ? `${currentSettings.examName} Tier 1` : currentSettings.subject)),
          exam: {
            tier: currentSettings.tier,
            examName: currentSettings.examName,
            subject: currentSettings.subject,
            selectedSubjects: [...currentSettings.selectedSubjects],
            expectedQuestions: currentSettings.expectedQuestions,
            positiveMarks: currentSettings.positiveMarks,
            negativeMarks: currentSettings.negativeMarks,
            timerMinutes: currentSettings.timerMinutes,
            untimed: currentSettings.untimed,
            sectionName: currentSettings.sectionName,
            navigationRules: {
              allowPrevious: true,
              allowNext: true,
              allowMarkForReview: true,
            },
          },
          answers: states,
          questionStates: states,
          activeQuestionIndex: latestActiveIndexRef.current,
          remainingSeconds: currentSettings.untimed ? 0 : latestRemainingRef.current,
          elapsedSeconds: latestElapsedRef.current,
          perQuestionTiming: Object.fromEntries(currentQuestions.map((question) => [question.id, question.timeSpentSeconds])),
          updatedAt: now,
        };
        try {
          await updateAttempt(checkpoint);
          activeAttemptSnapshotRef.current = checkpoint;
          setStorageWarning("");
        } catch (reason) {
          if (activeAttemptIdRef.current !== attemptId) return;
          const detail = reason instanceof Error ? reason.message : String(reason);
          setStorageWarning(`Could not autosave this attempt. Your current exam remains usable; retry by continuing or submitting. ${detail}`);
        }
      });
    autosaveQueueRef.current = operation;
    return operation;
  };
  const openSavedMock = async (mockTestId: string) => {
    const openSequence = ++savedMockOpenSequenceRef.current;
    try {
      const mock = await getMockTest(mockTestId);
      if (savedMockOpenSequenceRef.current !== openSequence) return;
      if (!mock) {
        setStorageWarning("This saved mock could not be found.");
        return;
      }
      const orderedQuestions = mock.questionOrder
        .map((questionId) => mock.questions.find((question) => question.id === questionId))
        .filter((question): question is StoredQuestion => Boolean(question));
      const remainingQuestions = mock.questions.filter((question) =>
        !mock.questionOrder.includes(question.id),
      );
      const runtimeQuestions: Question[] = [...orderedQuestions, ...remainingQuestions].map((question) => ({
        id: question.id,
        questionText: question.questionText,
        options: [...question.options],
        correctOptionIndex: question.correctOptionIndex,
        passageText: question.passageText,
        visited: false,
        marked: false,
        timeSpentSeconds: 0,
      }));
      setSettings({
        ...mock.exam,
        subject: mock.exam.subject,
        selectedSubjects: [...mock.exam.selectedSubjects],
      });
      setQuestions(runtimeQuestions);
      setActiveIndex(0);
      activeQuestionRef.current = 0;
      setQuestionZoom(100);
      setElapsedSeconds(0);
      setSecondsLeft(mock.exam.untimed ? 0 : mock.exam.timerMinutes * 60);
      setCurrentMockId(mock.id);
      untrackedPracticeRef.current = false;
      setUntrackedPractice(false);
      activeAttemptIdRef.current = null;
      activeAttemptStartedAtRef.current = null;
      activeAttemptMockTestIdRef.current = null;
      activeAttemptSnapshotRef.current = null;
      autosavePausedRef.current = false;
      examInitializedRef.current = false;
      submittedRef.current = false;
      setWarning("");
      setStorageWarning("");
      setView("ready");
    } catch (reason) {
      if (savedMockOpenSequenceRef.current !== openSequence) return;
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStorageWarning(`Could not open this saved mock: ${detail}`);
    }
  };
  const getTier1Structure = (subjects: string[]) => ({
    expectedQuestions: subjects.length * 25,
    timerMinutes: subjects.length * 15,
  });
  const createAttemptAndEnter = async (questionSet: Question[], mockTestId: string | null) => {
    if (attemptCreationInFlightRef.current) return;
    attemptCreationInFlightRef.current = true;
    if (!mockTestId) {
      activeAttemptIdRef.current = null;
      activeAttemptStartedAtRef.current = null;
      activeAttemptMockTestIdRef.current = null;
      untrackedPracticeRef.current = true;
      setUntrackedPractice(true);
      const freshQuestions = questionSet.map((question) => ({
        ...question,
        selectedOption: undefined,
        visited: false,
        marked: false,
        timeSpentSeconds: 0,
      }));
      freshQuestions[0] = { ...freshQuestions[0], visited: true };
      examInitializedRef.current = true;
      setActiveIndex(0);
      activeQuestionRef.current = 0;
      setQuestionZoom(100);
      setElapsedSeconds(0);
      setSecondsLeft(settings.untimed ? 0 : settings.timerMinutes * 60);
      setQuestions(freshQuestions);
      submittedRef.current = false;
      setWarning("Untracked Practice — this session will not appear in saved attempt history.");
      setView("exam");
      attemptCreationInFlightRef.current = false;
      setStartingAttempt(false);
      return;
    }
    setStartingAttempt(true);
    setWarning("");
    untrackedPracticeRef.current = false;
    setUntrackedPractice(false);
    activeAttemptIdRef.current = null;
    activeAttemptStartedAtRef.current = null;
    activeAttemptMockTestIdRef.current = null;
    try {
      const now = Date.now();
      const freshQuestions = questionSet.map((question) => ({
        ...question,
        selectedOption: undefined,
        visited: false,
        marked: false,
        timeSpentSeconds: 0,
      }));
      freshQuestions[0] = { ...freshQuestions[0], visited: true };
      const questionStates: AttemptQuestionState[] = freshQuestions.map((question) => ({
        questionId: question.id,
        selectedOption: undefined,
        visited: question.visited,
        marked: question.marked,
        timeSpentSeconds: question.timeSpentSeconds,
      }));
      const storedQuestionSnapshot: StoredQuestion[] = freshQuestions.map((question, index) => ({
        id: question.id,
        order: index,
        subject: settings.tier === "Tier 2" ? settings.subject : undefined,
        questionText: question.questionText,
        options: [...question.options],
        correctOptionIndex: question.correctOptionIndex,
        passageText: question.passageText,
        formatVersion: 1,
      }));
      const attempt: AttemptRecord = {
        id: createStableId("attempt"),
        mockTestId,
        status: "in-progress",
        startedAt: now,
        mockName: settings.sectionName || (settings.tier === "Tier 1" ? `${settings.examName} Tier 1` : settings.subject),
        exam: {
          tier: settings.tier,
          examName: settings.examName,
          subject: settings.subject,
          selectedSubjects: [...settings.selectedSubjects],
          expectedQuestions: settings.expectedQuestions,
          positiveMarks: settings.positiveMarks,
          negativeMarks: settings.negativeMarks,
          timerMinutes: settings.timerMinutes,
          untimed: settings.untimed,
          sectionName: settings.sectionName,
          navigationRules: {
            allowPrevious: true,
            allowNext: true,
            allowMarkForReview: true,
          },
        },
        answers: questionStates,
        questionStates,
        questions: storedQuestionSnapshot,
        questionOrder: storedQuestionSnapshot.map((question) => question.id),
        activeQuestionIndex: 0,
        remainingSeconds: settings.untimed ? 0 : settings.timerMinutes * 60,
        elapsedSeconds: 0,
        perQuestionTiming: Object.fromEntries(freshQuestions.map((question) => [question.id, 0])),
        createdAt: now,
        updatedAt: now,
      };
      const savedAttempt = await addAttempt(attempt);
      activeAttemptIdRef.current = savedAttempt.id;
      activeAttemptStartedAtRef.current = savedAttempt.startedAt;
      activeAttemptMockTestIdRef.current = mockTestId;
      activeAttemptSnapshotRef.current = savedAttempt;
      examInitializedRef.current = true;
      setActiveIndex(0);
      activeQuestionRef.current = 0;
      setQuestionZoom(100);
      setElapsedSeconds(0);
      setSecondsLeft(settings.untimed ? 0 : settings.timerMinutes * 60);
      setQuestions(freshQuestions);
      submittedRef.current = false;
      setWarning("");
      setView("exam");
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setWarning(`Could not create a tracked attempt. Please retry. ${detail}`);
    } finally {
      attemptCreationInFlightRef.current = false;
      setStartingAttempt(false);
    }
  };
  const startExam = async () => {
    if (view !== "ready" || questions.length === 0 || examInitializedRef.current || startingAttempt) return;
    await createAttemptAndEnter(questions, currentMockId);
  };
  const applyTier = (tier: Tier) => {
    if (tier === "Tier 1") {
      const structure = getTier1Structure(settings.selectedSubjects);
      patchSettings({ tier, positiveMarks: 2, negativeMarks: 0.5, ...structure });
    } else {
      const subject = SUBJECTS.find((item) => item.name === settings.subject) ?? SUBJECTS[0];
      patchSettings({ tier, positiveMarks: 3, negativeMarks: 1, expectedQuestions: subject.questions, timerMinutes: subject.minutes });
    }
  };
  const applyExamName = (examName: ExamName) => {
    patchSettings({ examName });
  };
  const toggleTier1Subject = (subjectName: string) => {
    setSettings((current) => {
      const selectedSubjects = current.selectedSubjects.includes(subjectName)
        ? current.selectedSubjects.filter((subject) => subject !== subjectName)
        : TIER1_SUBJECTS.filter((subject) => subject === subjectName || current.selectedSubjects.includes(subject));
      const structure = getTier1Structure(selectedSubjects);
      return {
        ...current,
        selectedSubjects,
        ...(customOverride ? {} : structure),
      };
    });
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

  const persistPdfLocally = async (selected: File, pageCountLoaded: number, uploadSequence: number) => {
    const operation = pdfPersistenceQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (pdfUploadSequenceRef.current !== uploadSequence) return;
        const now = Date.now();
        try {
          const record: PdfRecord = {
            id: createStableId("pdf"),
            filename: selected.name,
            size: selected.size,
            pageCount: pageCountLoaded,
            lastModified: selected.lastModified,
            blob: selected,
            createdAt: now,
            updatedAt: now,
          };

          const savedRecord = await savePdfRecord(record);
          if (pdfUploadSequenceRef.current !== uploadSequence) return;
          setSavedPdfId(savedRecord.id);
          setStorageWarning("");
        } catch (reason) {
          if (pdfUploadSequenceRef.current !== uploadSequence) return;
          setSavedPdfId(null);
          const detail = reason instanceof Error ? reason.message : String(reason);
          const quotaError = reason instanceof DOMException &&
            (reason.name === "QuotaExceededError" || reason.name === "NS_ERROR_DOM_QUOTA_REACHED");
          setStorageWarning(
            quotaError
              ? "The PDF is available for this session, but local storage is full and could not save it."
              : `The PDF is available for this session, but could not be saved locally: ${detail}`,
          );
        }
      });
    pdfPersistenceQueueRef.current = operation;
    await operation;
  };

  const loadFile = async (selected: File | undefined) => {
    if (!selected) return;
    const uploadSequence = ++pdfUploadSequenceRef.current;
    setError("");
    setWarning("");
    setStorageWarning("");
    setFile(null);
    setSavedPdfId(null);
    setPageCount(0);
    if (selected.size > 50 * 1024 * 1024) {
      if (pdfUploadSequenceRef.current === uploadSequence) {
        setError("This PDF is larger than 50 MB. Choose a smaller response sheet.");
      }
      return;
    }
    if (selected.type !== "application/pdf" && !selected.name.toLowerCase().endsWith(".pdf")) {
      if (pdfUploadSequenceRef.current === uploadSequence) {
        setError("Please choose a PDF response sheet.");
      }
      return;
    }
    try {
      const data = await selected.arrayBuffer();
      const pdfjsLib = await loadPdfJs();
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      if (pdfUploadSequenceRef.current !== uploadSequence) return;
      setFile(selected);
      setPageCount(pdf.numPages);
      setStartPage(1);
      setEndPage(Math.min(pdf.numPages, 5));
      void persistPdfLocally(selected, pdf.numPages, uploadSequence);
    } catch (reason) {
      if (pdfUploadSequenceRef.current === uploadSequence) {
        setError(`Could not read this PDF: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
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
    const tier1Scope = settings.tier === "Tier 1"
      ? ` Only extract questions from these selected subjects/modules: ${settings.selectedSubjects.join(", ")}.`
      : "";
    const prompt = `You are extracting questions from an SSC competitive exam candidate response sheet. Only include questions belonging to section "${settings.sectionName || settings.subject}" from the provided pages.${tier1Scope} Skip ads and promotional pages. Return ONLY valid JSON matching {"questions":[{"questionText":"...","options":["...","...","...","..."],"correctOptionIndex":1,"passageText":"..."}]}. correctOptionIndex is 1, 2, 3, or 4 based on the green official correct-answer tick (not the candidate's chosen answer). Scrub every checkmark, red cross, Question ID, Option ID, Status, Chosen Option, Adda247 and Google Play artifact from question/option text. Keep question and options clean. Express math in LaTeX with $...$ inline and $$...$$ display; preserve structured frequency tables as Markdown tables. Wrap any underlined English text in <u>...</u>. Attach the exact same passageText to every sub-question sharing a comprehension/cloze passage. Each question must have exactly four options. Do not invent missing content.`;
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
    if (settings.tier === "Tier 1" && settings.selectedSubjects.length === 0) {
      setError("Select at least one subject to generate a Tier 1 mock.");
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
    setCurrentMockId(null);
    untrackedPracticeRef.current = false;
    setUntrackedPractice(false);
    activeAttemptIdRef.current = null;
    activeAttemptStartedAtRef.current = null;
    activeAttemptMockTestIdRef.current = null;
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
      const extractedForStructure = settings.tier === "Tier 1"
        ? extracted.slice(0, settings.expectedQuestions)
        : extracted;
      const normalized: Question[] = extractedForStructure.map((question) => ({
        id: createStableId("question"),
        questionText: scrubArtifacts(question.questionText),
        options: question.options.slice(0, 4).map(scrubArtifacts),
        correctOptionIndex: question.correctOptionIndex,
        passageText: question.passageText ? scrubArtifacts(question.passageText) : undefined,
        visited: false,
        marked: false,
        timeSpentSeconds: 0,
      }));
      if (normalized.length !== settings.expectedQuestions) {
        setWarning(`Expected ${settings.expectedQuestions} questions, but found ${normalized.length}. Review the section before starting.`);
      }
      let savedExtractionId: string | undefined;
      if (!controller.signal.aborted) {
        const passageIds = new Map<string, string>();
        const storedQuestions: StoredQuestion[] = normalized.map((question, index) => {
          let passageId: string | undefined;
          if (question.passageText) {
            const existingPassageId = passageIds.get(question.passageText);
            passageId = existingPassageId ?? `passage-${passageIds.size + 1}`;
            if (!existingPassageId) passageIds.set(question.passageText, passageId);
          }
          return {
            id: question.id,
            order: index,
            subject: settings.tier === "Tier 2" ? settings.subject : undefined,
            questionText: question.questionText,
            options: question.options,
            correctOptionIndex: question.correctOptionIndex,
            passageId,
            passageText: question.passageText,
            clozeGroupId: passageId,
            formatVersion: 1,
          };
        });
        const extraction: ExtractionRecord = {
          id: createStableId("extraction"),
          sourcePdfId: savedPdfId ?? undefined,
          sourcePdfFilename: file.name,
          startPage,
          endPage,
          provider: "Server AI",
          selectedSubjects: settings.tier === "Tier 1" ? [...settings.selectedSubjects] : [settings.subject],
          examName: settings.examName,
          tier: settings.tier,
          sectionName: settings.sectionName,
          questions: storedQuestions,
          warning: normalized.length !== settings.expectedQuestions
            ? `Expected ${settings.expectedQuestions} questions, but found ${normalized.length}.`
            : undefined,
          createdAt: Date.now(),
        };
        try {
          await addExtraction(extraction);
          savedExtractionId = extraction.id;
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : String(reason);
          const storageMessage = `The extraction is available for this session, but could not be saved locally: ${detail}`;
          setStorageWarning(storageMessage);
          setWarning((current) => current ? `${current} ${storageMessage}` : storageMessage);
        }

        const now = Date.now();
        const mockName = settings.sectionName
          ? settings.sectionName
          : settings.tier === "Tier 1"
            ? `${settings.examName} Tier 1 · ${normalized.length} questions`
            : `${settings.subject} · ${normalized.length} questions`;
        const mockTest: MockTestRecord = {
          id: createStableId("mock"),
          name: mockName,
          exam: {
            tier: settings.tier,
            examName: settings.examName,
            subject: settings.subject,
            selectedSubjects: [...settings.selectedSubjects],
            expectedQuestions: settings.expectedQuestions,
            positiveMarks: settings.positiveMarks,
            negativeMarks: settings.negativeMarks,
            timerMinutes: settings.timerMinutes,
            untimed: settings.untimed,
            sectionName: settings.sectionName,
            navigationRules: {
              allowPrevious: true,
              allowNext: true,
              allowMarkForReview: true,
            },
          },
          questions: storedQuestions,
          questionOrder: storedQuestions.map((question) => question.id),
          sourcePdfId: savedPdfId ?? undefined,
          sourceExtractionId: savedExtractionId,
          createdAt: now,
          updatedAt: now,
        };
        try {
          await addMockTest(mockTest);
          setCurrentMockId(mockTest.id);
          untrackedPracticeRef.current = false;
          setUntrackedPractice(false);
          activeAttemptIdRef.current = null;
          activeAttemptStartedAtRef.current = null;
          activeAttemptMockTestIdRef.current = mockTest.id;
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : String(reason);
          const storageMessage = `The mock is available for this session, but could not be saved locally: ${detail}`;
          setCurrentMockId(null);
          untrackedPracticeRef.current = true;
          setUntrackedPractice(true);
          activeAttemptIdRef.current = null;
          activeAttemptStartedAtRef.current = null;
          activeAttemptMockTestIdRef.current = null;
          setStorageWarning(storageMessage);
          setWarning((current) => current ? `${current} ${storageMessage}` : storageMessage);
        }
      }
      setQuestions(normalized);
      setActiveIndex(0);
      activeQuestionRef.current = 0;
      submittedRef.current = false;
      examInitializedRef.current = false;
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
    localStorage.removeItem("mockforge.gemini-api-key");
    return () => extractionControllerRef.current?.abort();
  }, []);

  const finishAttempt = useCallback(async () => {
    if (submittedRef.current || questions.length === 0) return;
    submittedRef.current = true;
    const completedAt = Date.now();
    const untracked = untrackedPracticeRef.current;
    if (!untracked && activeAttemptIdRef.current) {
      autosavePausedRef.current = true;
      await saveActiveAttemptCheckpoint();
    }
    const attempt: Attempt = {
      id: untracked ? "" : activeAttemptIdRef.current ?? "",
      completedAt: new Date(completedAt).toISOString(),
      sectionName: settings.sectionName || settings.subject,
      tier: settings.tier,
      positiveMarks: settings.positiveMarks,
      negativeMarks: settings.negativeMarks,
      elapsedSeconds,
      questions,
      untracked,
    };
    const score = getScore(attempt);
    const attemptScore: AttemptScore = {
      correct: score.correct,
      wrong: score.wrong,
      attempted: score.attempted,
      unattempted: score.unattempted,
      positiveEarned: score.positiveEarned,
      negativeLost: score.negativeLost,
      net: score.net,
      max: score.max,
      accuracy: score.accuracy,
      totalTime: score.totalTime,
      averageTime: score.averageTime,
    };
    const questionStates: AttemptQuestionState[] = questions.map((question) => ({
      questionId: question.id,
      selectedOption: question.selectedOption,
      visited: question.visited,
      marked: question.marked,
      timeSpentSeconds: question.timeSpentSeconds,
    }));
    const persistentAttempt: AttemptRecord | null = activeAttemptIdRef.current
      ? {
          id: activeAttemptIdRef.current,
          mockTestId: activeAttemptMockTestIdRef.current ?? "",
          status: "completed",
          startedAt: activeAttemptStartedAtRef.current ?? completedAt - elapsedSeconds * 1000,
          completedAt,
          mockName: settings.sectionName || (settings.tier === "Tier 1" ? `${settings.examName} Tier 1` : settings.subject),
          exam: {
            tier: settings.tier,
            examName: settings.examName,
            subject: settings.subject,
            selectedSubjects: [...settings.selectedSubjects],
            expectedQuestions: settings.expectedQuestions,
            positiveMarks: settings.positiveMarks,
            negativeMarks: settings.negativeMarks,
            timerMinutes: settings.timerMinutes,
            untimed: settings.untimed,
            sectionName: settings.sectionName,
            navigationRules: {
              allowPrevious: true,
              allowNext: true,
              allowMarkForReview: true,
            },
          },
          answers: questionStates,
          questionStates,
          activeQuestionIndex: activeIndex,
          remainingSeconds: settings.untimed ? 0 : secondsLeft,
          elapsedSeconds,
          perQuestionTiming: Object.fromEntries(questions.map((question) => [question.id, question.timeSpentSeconds])),
          score: attemptScore,
          createdAt: activeAttemptStartedAtRef.current ?? completedAt - elapsedSeconds * 1000,
          updatedAt: completedAt,
        }
      : null;

    if (untracked) {
      activeAttemptIdRef.current = null;
      activeAttemptStartedAtRef.current = null;
      activeAttemptMockTestIdRef.current = null;
    } else if (persistentAttempt) {
      try {
        await updateAttempt(persistentAttempt);
      } catch (reason) {
        submittedRef.current = false;
        autosavePausedRef.current = false;
        const detail = reason instanceof Error ? reason.message : String(reason);
        setWarning(`Could not save this attempt result. Please submit again. ${detail}`);
        setSubmitModal(false);
        return;
      }
    } else {
      submittedRef.current = false;
      setWarning("Could not identify this attempt. Return to the mock and start a tracked attempt again.");
      setSubmitModal(false);
      return;
    }

    activeAttemptIdRef.current = null;
    activeAttemptStartedAtRef.current = null;
    activeAttemptMockTestIdRef.current = null;
    activeAttemptSnapshotRef.current = null;
    autosavePausedRef.current = false;
    untrackedPracticeRef.current = false;
    setUntrackedPractice(false);
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
  }, [activeIndex, elapsedSeconds, currentMockId, questions, secondsLeft, settings]);

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
    if (view !== "exam" || untrackedPracticeRef.current || !activeAttemptIdRef.current) return;
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void saveActiveAttemptCheckpoint();
    }, 350);
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [view, activeIndex, autosaveRevision]);

  useEffect(() => {
    if (view !== "exam" || untrackedPracticeRef.current || !activeAttemptIdRef.current) return;
    const interval = window.setInterval(() => {
      if (!autosavePausedRef.current) void saveActiveAttemptCheckpoint();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [view]);

  useEffect(() => {
    if (view === "exam" && !settings.untimed && secondsLeft === 0 && elapsedSeconds > 0) finishAttempt();
  }, [elapsedSeconds, finishAttempt, secondsLeft, settings.untimed, view]);

  const changeQuestion = (index: number) => {
    if (index < 0 || index >= questions.length) return;
    activeQuestionRef.current = index;
    setActiveIndex(index);
    setAutosaveRevision((revision) => revision + 1);
    setQuestions((current) => current.map((question, questionIndex) =>
      questionIndex === index ? { ...question, visited: true } : question,
    ));
    setMobilePaletteOpen(false);
  };

  const selectOption = (option: number) => {
    setQuestions((current) => current.map((question, index) =>
      index === activeIndex ? { ...question, selectedOption: option } : question,
    ));
    setAutosaveRevision((revision) => revision + 1);
  };

  const markAndNext = () => {
    setQuestions((current) => current.map((question, index) =>
      index === activeIndex ? { ...question, marked: true } : question,
    ));
    setAutosaveRevision((revision) => revision + 1);
    if (activeIndex < questions.length - 1) changeQuestion(activeIndex + 1);
  };

  const launchRetry = async () => {
    if (!currentAttempt) return;
    const retry = currentAttempt.questions.filter((question) =>
      question.selectedOption !== question.correctOptionIndex ||
      question.timeSpentSeconds > 90,
    ).map((question, index) => ({
      ...question,
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
    examInitializedRef.current = false;
    await createAttemptAndEnter(retry, activeAttemptMockTestIdRef.current ?? currentMockId);
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
            <div className="exam-title"><span>{settings.sectionName || (settings.tier === "Tier 1" ? `${settings.examName}: ${settings.selectedSubjects.join(", ")}` : settings.subject)}</span><b>{untrackedPractice ? "Untracked Practice" : settings.tier} <i>•</i> +{settings.positiveMarks} / -{settings.negativeMarks}</b></div>
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
                <span className="workspace-section-name">SECTION: {settings.sectionName || (settings.tier === "Tier 1" ? `${settings.examName} Tier 1` : settings.subject)}</span>
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
                <button className="btn btn-review" onClick={markAndNext}><ShieldCheck size={16} /><span>Mark for Review</span></button>
                <div className="control-spacer" />
                <button className="btn btn-light" onClick={() => changeQuestion(activeIndex - 1)} disabled={activeIndex === 0}><ArrowLeft size={16} /> Previous</button>
                <button className="btn btn-primary" onClick={() => activeIndex < questions.length - 1 ? changeQuestion(activeIndex + 1) : setSubmitModal(true)}>
                  Next <ArrowRight size={16} />
                </button>
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
                <button type="button" className="btn btn-submit palette-submit" onClick={() => setSubmitModal(true)}>Submit Section</button>
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
              <div><span className="section-kicker">YOUR MOCK TEST</span><h2 id="ready-test-name">{settings.sectionName || settings.subject}</h2></div>
              <span className="ready-tier">{untrackedPractice ? "Untracked Practice" : settings.tier}</span>
            </div>
            {warning && <div className="setup-warning"><CircleHelp size={17} /><span>{warning}</span><button onClick={() => setWarning("")} aria-label="Dismiss warning"><X size={15} /></button></div>}
            <div className="ready-details">
              <div className="ready-detail"><span>{settings.tier === "Tier 1" ? "Subjects" : "Subject"}</span><strong>{settings.tier === "Tier 1" ? settings.selectedSubjects.join(", ") : settings.subject}</strong></div>
              <div className="ready-detail"><span>Questions extracted</span><strong>{questions.length}</strong></div>
              <div className="ready-detail"><span>Expected questions</span><strong>{settings.expectedQuestions}</strong></div>
              <div className="ready-detail"><span>Duration</span><strong>{settings.untimed ? "Untimed practice" : `${settings.timerMinutes} minutes`}</strong></div>
              <div className="ready-detail"><span>Correct answer</span><strong>+{settings.positiveMarks} marks</strong></div>
              <div className="ready-detail"><span>Incorrect answer</span><strong>−{settings.negativeMarks} marks</strong></div>
            </div>
            <div className="ready-note"><Clock3 size={16} /><span>The exam timer and question timing start when you begin the mock.</span></div>
            <div className="ready-actions">
              <button className="btn btn-light" onClick={() => setView("setup")}><ArrowLeft size={16} />Back to Setup</button>
              <button className="btn btn-light" onClick={() => void openLibrary()}><History size={16} />Saved Mocks</button>
              <button className="btn btn-primary" onClick={() => void startExam()} disabled={questions.length === 0 || examInitializedRef.current || startingAttempt}>
                {startingAttempt ? "Creating attempt..." : untrackedPractice ? "Start Untracked Practice" : "Start Mock Test"}
                <ArrowRight size={16} />
              </button>
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

  if (view === "library") {
    return (
      <div className="app-shell">
        <header className="site-header">
          <a className="brand-lockup" href="#" onClick={(event) => event.preventDefault()}><div className="brand-mark"><Layers3 size={19} /></div><span>MockForge</span></a>
          <nav className="header-nav"><span><BookOpen size={15} /> PYQ Mock Test Studio</span><button className="api-settings" onClick={() => void openLibrary()}><History size={15} />Saved Mocks</button><ThemeToggle theme={theme} onToggle={toggleTheme} /><button className="api-settings" onClick={() => setApiModal(true)}><KeyRound size={15} /> API Settings</button></nav>
        </header>
        <main className="library-main">
          <div className="library-heading">
            <div><div className="section-kicker">SAVED MOCKS</div><h1>Your mock library</h1><p>Open a saved mock and start whenever you are ready.</p></div>
            <button className="btn btn-light" onClick={() => setView("setup")}><ArrowLeft size={16} />Back to Setup</button>
          </div>
          {storageWarning && <div className="setup-warning"><CircleHelp size={17} /><span>{storageWarning}</span><button onClick={() => setStorageWarning("")} aria-label="Dismiss warning"><X size={15} /></button></div>}
          {libraryLoading ? (
            <div className="library-empty"><LoaderCircle size={19} className="spin" /><span>Loading saved mocks...</span></div>
          ) : savedMocks.length === 0 ? (
            <div className="library-empty"><History size={20} /><span><strong>No saved mocks yet</strong><small>Generate a mock to add it to this library.</small></span></div>
          ) : (
            <div className="library-grid">
              {savedMocks.map((mock) => (
                <article className="library-card" key={mock.id}>
                  <div className="library-card-top">
                    <span className="library-tier">{mock.exam.examName} · {mock.exam.tier}</span>
                    <span className="library-status">{completedAttemptCounts[mock.id] ? "Attempted" : "Never attempted"}</span>
                    {latestAttemptDates[mock.id] && (
                      <span className="library-status">{completedAttemptCounts[mock.id]} completed · Latest {new Date(latestAttemptDates[mock.id]).toLocaleDateString()}</span>
                    )}
                  </div>
                  <h2>{mock.name}</h2>
                  <div className="library-meta">
                    <span><FileText size={14} />{mock.questions.length} questions</span>
                    <span><Clock3 size={14} />{mock.exam.untimed ? "Untimed" : `${mock.exam.timerMinutes} minutes`}</span>
                  </div>
                  <div className="library-card-footer">
                    <span>{new Date(mock.createdAt).toLocaleDateString()}</span>
                    <div className="library-card-actions">
                      <button type="button" className="btn btn-light" onClick={() => void renameMock(mock)}>Rename</button>
                      <button type="button" className="btn btn-outline" onClick={() => void deleteMockRecord(mock)}>Delete</button>
                      <button className="btn btn-primary" onClick={() => void openSavedMock(mock.id)}>Open<ArrowRight size={15} /></button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand-lockup" href="#" onClick={(event) => event.preventDefault()}><div className="brand-mark"><Layers3 size={19} /></div><span>MockForge</span></a>
        <nav className="header-nav"><span><BookOpen size={15} /> PYQ Mock Test Studio</span><button className="api-settings" onClick={() => void openLibrary()}><History size={15} />Saved Mocks</button><ThemeToggle theme={theme} onToggle={toggleTheme} /><button className="api-settings" onClick={() => setApiModal(true)}><KeyRound size={15} /> API Settings</button></nav>
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

        {migrationStatus !== "idle" && migrationStatus !== "complete" && (
          <div className="migration-status" role="status">
            <CircleHelp size={16} />
            <span>{migrationStatus === "running" ? "Migrating legacy attempt history..." : "Legacy attempt history migration needs attention."}</span>
          </div>
        )}

        {savedPdfs.length > 0 && (
          <section className="pdf-library-section" aria-labelledby="saved-pdfs-title">
            <div className="pdf-library-heading"><div><div className="section-kicker">LOCAL PDFs</div><h2 id="saved-pdfs-title">Saved PDFs</h2></div><span>{savedPdfs.length}</span></div>
            <div className="pdf-library-list">
              {savedPdfs.map((pdf) => (
                <article className="pdf-library-row" key={pdf.id}>
                  <span className="pdf-library-icon"><FileText size={16} /></span>
                  <div className="pdf-library-meta"><strong>{pdf.filename}</strong><small>{pdf.pageCount} pages · Added {new Date(pdf.createdAt).toLocaleDateString()} · {(pdf.size / 1024 / 1024).toFixed(2)} MB</small></div>
                  <div className="pdf-library-actions"><button type="button" className="btn btn-light" onClick={() => void renamePdf(pdf)}>Rename</button><button type="button" className="btn btn-outline" onClick={() => void deletePdfRecord(pdf)}>Delete</button></div>
                </article>
              ))}
            </div>
          </section>
        )}

        {unfinishedAttempts.length > 0 && (
          <section className="recovery-section" aria-labelledby="unfinished-attempts-title">
            <div className="recovery-heading">
              <div><div className="section-kicker">RECOVER PRACTICE</div><h2 id="unfinished-attempts-title">Unfinished attempts</h2></div>
              <span>{unfinishedAttempts.length}</span>
            </div>
            <div className="recovery-list">
              {unfinishedAttempts.map((attempt) => (
                <article className="recovery-card" key={attempt.id}>
                  <div className="recovery-meta">
                    <strong>{attempt.mockName || attempt.exam?.sectionName || attempt.exam?.subject || "Saved mock attempt"}</strong>
                    <small>{attempt.exam ? `${attempt.exam.examName || "Exam"} · ${attempt.exam.tier} · ${attempt.exam.untimed ? "Untimed" : `${attempt.remainingSeconds}s remaining`}` : "Attempt snapshot"}</small>
                    <span>Last saved {new Date(attempt.updatedAt).toLocaleString()}</span>
                  </div>
                  <div className="recovery-actions">
                    <button type="button" className="btn btn-light" onClick={() => void discardUnfinishedAttempt(attempt.id)}>Discard</button>
                    <button type="button" className="btn btn-primary" onClick={() => void resumeUnfinishedAttempt(attempt)}>Resume<ArrowRight size={15} /></button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

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
              {file && <span className="pdf-chip" title={savedPdfId ? "Saved locally" : "Local save pending"}><FileText size={13} /> PDF</span>}
              {!file && <button className="browse-btn" type="button">Browse files</button>}
            </div>
            {storageWarning && (
              <div className="setup-warning">
                <CircleHelp size={17} />
                <span>{storageWarning}</span>
                <button onClick={() => setStorageWarning("")} aria-label="Dismiss local storage warning"><X size={15} /></button>
              </div>
            )}

            <div className="form-section">
              <div className="form-section-title"><span className="step-number">1</span><div><strong>Choose your exam preset</strong><small>We’ll set the marking scheme and timer for you.</small></div></div>
              <div className="tier-options">
                {(["Tier 1", "Tier 2"] as Tier[]).map((tier) => (
                  <button className={`tier-option ${settings.tier === tier ? "tier-active" : ""}`} onClick={() => applyTier(tier)} key={tier}>
                    <span className={`tier-radio ${settings.tier === tier ? "radio-active" : ""}`}>{settings.tier === tier && <i />}</span>
                    <span className="tier-info"><strong>{tier}</strong><small>{tier === "Tier 1" ? "+2.0 correct · −0.5 wrong" : "+3.0 correct · −1.0 wrong"}</small></span>
                    <span className="tier-time"><Clock3 size={13} />{tier === "Tier 1" ? "60 min" : "Subject based"}</span>
                  </button>
                ))}
              </div>
              {settings.tier === "Tier 1" && (
                <>
                  <div className="exam-name-options" role="group" aria-label="SSC exam">
                    {(["SSC CGL", "SSC CHSL"] as ExamName[]).map((examName) => (
                      <button
                        type="button"
                        key={examName}
                        className={`exam-name-option ${settings.examName === examName ? "exam-name-active" : ""}`}
                        aria-pressed={settings.examName === examName}
                        onClick={() => applyExamName(examName)}
                      >
                        {examName}
                      </button>
                    ))}
                  </div>
                  <fieldset className="tier1-subjects">
                    <legend>Subjects / modules</legend>
                    <div className="tier1-subject-grid">
                      {TIER1_SUBJECTS.map((subjectName) => {
                        const selected = settings.selectedSubjects.includes(subjectName);
                        return (
                          <label className={`tier1-subject-option ${selected ? "tier1-subject-selected" : ""}`} key={subjectName}>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleTier1Subject(subjectName)}
                            />
                            <span className="subject-checkbox">{selected && <Check size={12} />}</span>
                            <span>{subjectName}</span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                </>
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
            <button className="generate-btn" disabled={busy || !file || (settings.tier === "Tier 1" && settings.selectedSubjects.length === 0)} onClick={() => void generateMock()}>
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
            return <button className="history-row" key={attempt.id ? attempt.id : `untracked-${attempt.completedAt}`} onClick={() => { setCurrentAttempt(attempt); setReviewFilter("All"); setStorageWarning(""); setView("results"); setSettings((current) => ({ ...current, tier: attempt.tier, positiveMarks: attempt.positiveMarks, negativeMarks: attempt.negativeMarks, sectionName: attempt.sectionName, expectedQuestions: attempt.questions.length })); }}>
                <span className="history-file"><FileText size={17} /></span><span className="history-meta"><strong>{attempt.sectionName}</strong><small>{attempt.untracked ? "Untracked practice" : attempt.tier} · {new Date(attempt.completedAt).toLocaleDateString()} · {attempt.questions.length} questions</small></span><span className="history-score"><b>{score.net.toFixed(2)}</b><small>score</small></span><ArrowRight size={17} />
              </button>;
            })}</div>
          )}
        </section>
        <footer className="site-footer"><span>MockForge <i>·</i> Built for better practice</span><span><LockKeyhole size={12} /> Your attempts are saved on this device</span></footer>
      </main>
      {apiModal && <Modal title="Server AI settings" onClose={() => setApiModal(false)}>
        <p className="modal-copy">PDF pages are sent to this app’s server for extraction. Gemini and Lovable AI credentials stay in server environment variables and are never sent to the browser.</p>
        <div className="key-hint"><KeyRound size={14} /><span>Configure <code>GEMINI_API_KEY</code> and <code>GEMINI_MODEL</code> in the server .env. <code>LOVABLE_API_KEY</code> enables the server-side fallback.</span></div>
        <div className="modal-actions"><button className="btn btn-primary" onClick={() => setApiModal(false)}>Done</button></div>
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
        <div className="results-intro"><div className="eyebrow"><span className="eyebrow-dot" /> {attempt.untracked ? "UNTRACKED PRACTICE" : "SECTION COMPLETE"}</div><h1>Your practice, <span>decoded.</span></h1><p>{attempt.untracked && <><strong>Not saved to attempt history</strong> <i>·</i> </>}{attempt.sectionName} <i>·</i> {new Date(attempt.completedAt).toLocaleString()}</p></div>
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
