export type Tier = "Tier 1" | "Tier 2";
export type ExamName = "SSC CGL" | "SSC CHSL";

export type StoredQuestion = {
  id: string;
  order: number;
  subject?: string;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  passageId?: string;
  passageText?: string;
  clozeGroupId?: string;
  formatVersion: 1;
};

export type ExamConfiguration = {
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
  navigationRules: {
    allowPrevious: true;
    allowNext: true;
    allowMarkForReview: true;
  };
};

export type PdfRecord = {
  id: string;
  filename: string;
  size: number;
  pageCount: number;
  lastModified?: number;
  blob: Blob;
  createdAt: number;
  updatedAt: number;
};

export type ExtractionRecord = {
  id: string;
  sourcePdfId?: string;
  sourcePdfFilename?: string;
  startPage: number;
  endPage: number;
  provider: string;
  model?: string;
  selectedSubjects: string[];
  examName: ExamName;
  tier: Tier;
  sectionName: string;
  questions: StoredQuestion[];
  warning?: string;
  createdAt: number;
};

export type MockTestRecord = {
  id: string;
  name: string;
  exam: ExamConfiguration;
  questions: StoredQuestion[];
  questionOrder: string[];
  sourcePdfId?: string;
  sourceExtractionId?: string;
  createdAt: number;
  updatedAt: number;
};

export type AttemptQuestionState = {
  questionId: string;
  selectedOption?: number;
  visited: boolean;
  marked: boolean;
  timeSpentSeconds: number;
};

export type AttemptScore = {
  correct: number;
  wrong: number;
  attempted: number;
  unattempted: number;
  positiveEarned: number;
  negativeLost: number;
  net: number;
  max: number;
  accuracy: number;
  totalTime: number;
  averageTime: number;
};

export type AttemptRecord = {
  id: string;
  mockTestId: string;
  status: "in-progress" | "completed";
  startedAt: number;
  completedAt?: number;
  mockName?: string;
  exam?: ExamConfiguration;
  questions?: StoredQuestion[];
  questionOrder?: string[];
  answers: AttemptQuestionState[];
  questionStates: AttemptQuestionState[];
  activeQuestionIndex: number;
  remainingSeconds: number;
  elapsedSeconds: number;
  perQuestionTiming: Record<string, number>;
  score?: AttemptScore;
  createdAt: number;
  updatedAt: number;
};

export type SettingRecord = {
  key: string;
  value: unknown;
  updatedAt: number;
};
