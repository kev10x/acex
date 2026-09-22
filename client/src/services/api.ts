import axios from 'axios';

// App is always deployed at /tools (vite.config base: '/tools/').
// Dev uses a direct localhost URL; production always uses /tools/api.
const API_BASE_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_API_URL || 'http://localhost:3001/api')
  : (import.meta.env.VITE_API_URL?.replace(/\/$/, '') || '/tools/api');

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

const stripHtml = (value: string): string =>
  String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const extractBlobErrorMessage = async (data: unknown): Promise<string | null> => {
  if (typeof Blob === 'undefined' || !(data instanceof Blob)) return null;
  const mime = String(data.type || '').toLowerCase();
  if (!mime.includes('text') && !mime.includes('json') && !mime.includes('html')) return null;
  try {
    const text = await data.text();
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (mime.includes('json') || trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      const message = String(parsed?.error || parsed?.message || '').trim();
      if (message) return message;
    }
    const clean = stripHtml(trimmed);
    if (clean) return clean.slice(0, 280);
  } catch (_) {
    return null;
  }
  return null;
};

export const getApiErrorMessage = (error: any, fallback = 'Request failed'): string => {
  return String(
    error?.userMessage ||
    error?.response?.data?.error ||
    error?.response?.data?.message ||
    error?.message ||
    fallback
  ).trim();
};

// Request interceptor for logging and adding auth token
api.interceptors.request.use(
  (config) => {
    console.log(`Making ${config.method?.toUpperCase()} request to ${config.url}`);
    // Add auth token if available
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error) => {
    const blobMessage = await extractBlobErrorMessage(error?.response?.data);
    if (blobMessage) {
      error.userMessage = blobMessage;
      if (error?.response?.status) {
        error.userMessage = `HTTP ${error.response.status}: ${blobMessage}`;
      }
    }
    console.error('API Error:', error.userMessage || error.response?.data || error.message);

    // Handle 401 unauthorized - clear auth and redirect to login
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      // Don't redirect here - let components handle it
    }
    
    // Provide more detailed error logging
    if (error.code === 'ERR_NETWORK' || error.message?.includes('Network Error')) {
      console.error('Network Error Details:', {
        url: error.config?.url,
        baseURL: error.config?.baseURL,
        message: 'Cannot connect to server. Is the server running?'
      });
    }
    
    return Promise.reject(error);
  }
);

// Types
export interface Assignment {
  id: number;
  filename: string;
  file_path?: string;
  file_size: number;
  uploaded_at: string;
  status: 'uploaded' | 'processing' | 'completed' | 'error';
  batch_id?: number | null;
  extracted_text?: string | null; // Only returned by endpoints that explicitly need extracted text.
}

export interface Batch {
  id: number;
  name: string;
  description?: string | null;
  created_at: string;
  assignment_count?: number;
}

export interface BatchSummaryScript {
  assignment_id: number;
  filename: string;
  student_name: string;
  status: 'marked' | 'failed' | 'processing' | 'unmarked';
  score: number | null;
  total_points: number | null;
  percent: number | null;
  rubric_name: string | null;
  marked_at: string | null;
  failure_reason: string | null;
}

export interface BatchSummary {
  success: boolean;
  batch: { id: number; name: string };
  counts: { total: number; marked: number; failed: number; processing: number; unmarked: number };
  stats: {
    average_score: number | null;
    average_percent: number | null;
    median_score: number | null;
    highest_score: number | null;
    lowest_score: number | null;
  };
  scripts: BatchSummaryScript[];
}

export interface MarkingJob {
  id: number;
  batch_id: number;
  rubric_id: number;
  user_id: number;
  status: 'scheduled' | 'submitted' | 'running' | 'finalizing' | 'completed' | 'completed_with_errors' | 'failed';
  provider?: string;
  processing_mode?: string;
  scheduled_for?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  request_count?: number;
  retry_count?: number;
  max_retries?: number;
  next_retry_at?: string | null;
  last_status_at?: string | null;
  total_count: number;
  processed_count: number;
  success_count: number;
  failed_count: number;
  openai_batch_id?: string | null;
  last_error?: string | null;
  created_at: string;
  batch_name?: string;
  rubric_name?: string;
}

export interface BatchJobHealthSummary {
  total_jobs: number;
  scheduled_jobs: number;
  submitted_jobs: number;
  running_jobs: number;
  finalizing_jobs: number;
  completed_jobs: number;
  completed_with_errors_jobs: number;
  failed_jobs: number;
  retried_jobs: number;
}

export interface BatchJobHealthItem {
  id: number;
  status: string;
  retry_count?: number;
  max_retries?: number;
  last_error?: string | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  last_status_at?: string | null;
  next_retry_at?: string | null;
  batch_id: number;
  batch_name?: string;
  user_id: number;
  owner_email?: string;
}

export interface BatchJobsHealthResponse {
  success: boolean;
  status: 'healthy' | 'degraded';
  scope: 'all' | 'own';
  stuck_threshold_minutes: number;
  summary: BatchJobHealthSummary;
  stuck_jobs: BatchJobHealthItem[];
  retrying_jobs: BatchJobHealthItem[];
  recent_failures: BatchJobHealthItem[];
}

export interface RubricCriterion {
  name: string;
  max_points: number;
  description: string;
}

export interface Rubric {
  id: number;
  name: string;
  criteria: RubricCriterion[];
  total_points: number;
  rubric_type?: 'rubric' | 'answer_key';
  created_at: string;
}

export interface MarkingScore {
  criterion_name: string;
  points_awarded: number;
  max_points: number;
  rubric_basis?: string; // which rubric descriptor/level drove this score
  feedback: string;
  confidence?: number; // 0-100 confidence level for this criterion
}

export interface Correction {
  type: 'correction' | 'suggestion';
  criterion_name: string;
  location: string;
  issue: string;
  correction: string;
  reason: string;
}

export interface LanguageError {
  location: string;
  error_text: string;
  error_type: 'grammar' | 'spelling' | 'reference' | 'punctuation' | 'style';
  correction: string;
  explanation: string;
}

export interface MarkingResult {
  id: number;
  assignment_id: number;
  rubric_id: number;
  student_name?: string;
  scores: MarkingScore[];
  feedback: string;
  total_score: number;
  marked_at: string;
  filename?: string;
  rubric_name?: string;
  max_points?: number;
  overall_confidence?: number; // 0-100 overall confidence in the assessment
  confidence_level?: 'low' | 'medium' | 'high'; // Categorized confidence level
  needs_review?: boolean; // Flag indicating if human review is recommended
  min_criterion_confidence?: number; // Minimum confidence across all criteria
  has_low_criterion_confidence?: boolean; // Flag if any criterion has low confidence
  handwriting_recognition_confidence?: number | null; // 0-100 for handwritten/image submissions: how legible the handwriting was
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  estimated_cost_usd?: number | null;
  corrections?: Correction[]; // Array of corrections and suggestions with location information
  language_errors?: LanguageError[]; // Array of grammar, spelling, and reference errors
  feedback_type?: 'standard' | 'prescriptive' | 'reflective' | 'critical' | 'genie';
  feedback_verbosity?: 'brief' | 'standard' | 'comprehensive';
  prescriptive_table?: Array<{ criterion: string; issue: string; location: string; fix: string; priority: string }>;
  reflective_questions?: Array<{ criterion: string; question: string }>;
  critical_table?: Array<{ criterion: string; weakness: string; impact: string; evidence: string; severity: string }>;
  genie_output?: Array<{ criterion: string; original_excerpt: string; corrected_version: string; changes_made: string }>;
  improvement_forecast?: string | null;
  comparative_insight?: string | null;
  criterion_feedback_types?: Record<string, string> | null;
  flagged_for_moderation?: boolean;
  moderation_reason?: string | null;
  moderation_updated_by?: number | null;
  moderation_updated_by_name?: string | null;
  moderation_updated_by_email?: string | null;
  moderation_updated_at?: string | null;
  custom_feedback?: string | null;
  override_total_score?: number | null;
  effective_feedback?: string;
  effective_total_score?: number;
  folder_name?: string | null;
  review_status?: 'none' | 'queued' | 'reviewed';
  review_reasons?: string[];
  custom_name?: string | null;
}

export interface FeatureFlags {
  assessment_creation?: boolean;
  content_creation?: boolean;
  download_results?: boolean;
  feedback_video?: boolean;
}

export interface LecturerPerformance {
  lecturer_id: number;
  lecturer_name: string;
  lecturer_email: string;
  organisation_name?: string | null;
  total_results: number;
  assignments_marked: number;
  average_score: number;
  average_percentage: number;
  review_queue_count: number;
  active_days: number;
  last_marked_at?: string | null;
}

export interface StudentPerformance {
  student_key: string;
  student_name: string;
  total_results: number;
  lecturers_involved: number;
  average_score: number;
  average_percentage: number;
  min_percentage: number;
  max_percentage: number;
  pass_rate: number;
  last_marked_at?: string | null;
}

export interface ManagementPerformanceSummary {
  total_results: number;
  lecturer_count: number;
  student_count: number;
  average_percentage: number;
  reviewed_or_flagged_results: number;
}

export interface ManagementPerformanceResponse {
  success: boolean;
  summary: ManagementPerformanceSummary;
  lecturer_performance: LecturerPerformance[];
  student_performance: StudentPerformance[];
}

export interface Organisation {
  id: number;
  name: string;
  features?: FeatureFlags;
  created_at?: string;
}

export interface Department {
  id: number;
  name: string;
  organisation_id: number;
  organisation_name?: string;
  created_at?: string;
}

// Upload API
export const uploadAPI = {
  uploadSingle: (file: File, batch_id?: number) => {
    const formData = new FormData();
    formData.append('pdf', file);
    if (batch_id) formData.append('batch_id', String(batch_id));
    return api.post('/upload/single', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },

  uploadMultiple: (files: File[], batch_id?: number) => {
    const formData = new FormData();
    files.forEach((file) => {
      formData.append('pdfs', file);
    });
    if (batch_id) formData.append('batch_id', String(batch_id));
    return api.post('/upload/multiple', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },

  getAssignments: () => api.get('/upload'),
  deleteAssignment: (id: number) => api.delete(`/upload/${id}`),
  
  uploadZip: (file: File, batch_id?: number) => {
    const formData = new FormData();
    formData.append('zip', file);
    if (batch_id) formData.append('batch_id', String(batch_id));
    return api.post('/upload/zip', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },
};

// Rubrics API
export const rubricsAPI = {
  createRubric: (rubric: Omit<Rubric, 'id' | 'created_at'>) =>
    api.post('/rubrics', rubric),
  getRubrics: () => api.get('/rubrics'),
  getRubric: (id: number) => api.get(`/rubrics/${id}`),
  updateRubric: (id: number, rubric: Omit<Rubric, 'id' | 'created_at'>) =>
    api.put(`/rubrics/${id}`, rubric),
  deleteRubric: (id: number) => api.delete(`/rubrics/${id}`),
};

// Marking API
export type MarkingOutputType = 'annotate' | 'report' | 'word_comments';
export type MarkingAssessmentType = 'assignment' | 'test' | 'exam' | 'code' | 'project_proposal' | 'treatise' | 'thesis';

export const markingAPI = {
  markSingle: (data: {
    assignment_id: number;
    rubric_id: number;
    student_name?: string;
    output_type?: MarkingOutputType;
    assessment_type?: MarkingAssessmentType;
    level?: string;
    provider?: 'openai' | 'anthropic';
    strictness_level?: 'very_strict' | 'strict' | 'moderate' | 'lenient';
    mark_as_image?: boolean;
    feedback_type?: 'standard' | 'prescriptive' | 'reflective' | 'critical' | 'genie';
    feedback_verbosity?: 'brief' | 'standard' | 'comprehensive';
    criterion_feedback_types?: Record<string, string> | null;
  }) => api.post('/mark/single', data),

  markMultiple: (data: {
    assignment_ids: number[];
    rubric_id: number;
    student_names?: (string | null)[];
    output_type?: MarkingOutputType;
    assessment_type?: MarkingAssessmentType;
    level?: string;
    provider?: 'openai' | 'anthropic';
    strictness_level?: 'very_strict' | 'strict' | 'moderate' | 'lenient';
    mark_as_image?: boolean;
    feedback_type?: 'standard' | 'prescriptive' | 'reflective' | 'critical' | 'genie';
    feedback_verbosity?: 'brief' | 'standard' | 'comprehensive';
    criterion_feedback_types?: Record<string, string> | null;
  }, signal?: AbortSignal) => api.post('/mark/multiple', data, { signal }),

  markManual: (data: {
    assignment_id: number;
    rubric_id: number;
    student_name: string;
    scores: MarkingScore[];
    overall_feedback?: string;
  }) => api.post('/mark/manual', data),

  getRubric: (id: number) => api.get(`/mark/rubric/${id}`),
};

// Results API
export const resultsAPI = {
  getResults: () => api.get('/results'),
  getReviewQueue: () => api.get('/results/review-queue'),
  getResult: (id: number) => api.get(`/results/${id}`),
  getResultsByAssignment: (assignmentId: number) =>
    api.get(`/results/assignment/${assignmentId}`),
  getResultsByRubric: (rubricId: number) =>
    api.get(`/results/rubric/${rubricId}`),
  exportCSV: () => api.get('/results/export/csv', { responseType: 'blob' }),
  getStats: () => api.get('/results/stats/overview'),
  deleteResult: (id: number) => api.delete(`/results/${id}`),
  deleteAllResults: () => api.delete('/results'),
  downloadAll: () => api.get('/results/download/all', { responseType: 'blob' }),
  downloadCSV: () => api.get('/results/download/csv', { responseType: 'blob' }),
  getAnnotatedPDF: (resultId: number) => api.get(`/results/annotated-pdf/${resultId}`, { responseType: 'blob' }),
  getCommentedDocx: (resultId: number) => api.get(`/results/commented-docx/${resultId}`, { responseType: 'blob' }),
  getOriginalDocument: (resultId: number) => api.get(`/results/original/${resultId}`, { responseType: 'blob' }),
  getAnalyticsOverview: () => api.get('/results/analytics/overview'),
  getManagementPerformance: () => api.get<ManagementPerformanceResponse>('/results/analytics/management-performance'),
  getCriteriaAnalytics: (rubricId: number) => api.get(`/results/analytics/criteria/${rubricId}`),
  getCommonIssues: () => api.get('/results/analytics/common-issues'),
  getMarkingHistory: (assignmentId: number) => api.get(`/mark/history/${assignmentId}`),
  restoreMarkingVersion: (resultId: number) => api.post(`/mark/history/${resultId}/restore`),
  compareMarkingVersions: (resultId1: number, resultId2: number) => api.get(`/mark/history/compare/${resultId1}/${resultId2}`),
  createFeedbackVideo: (resultId: number) => api.post(`/results/feedback-video/${resultId}`),
  getFeedbackVideoStatus: (resultId: number) => api.get(`/results/feedback-video/${resultId}/status`),
  getFeedbackVideoContent: (resultId: number) => api.get(`/results/feedback-video/${resultId}/content`, { responseType: 'blob' }),
  setModerationFlag: (id: number, data: { flagged: boolean; moderation_reason?: string }) =>
    api.post(`/results/${id}/moderation-flag`, data),
  saveLecturerOverride: (id: number, data: { custom_feedback?: string | null; override_total_score?: number | null; moderation_reason?: string | null }) =>
    api.put(`/results/${id}/lecturer-override`, data),
  chat: (id: number, data: { question: string; history?: Array<{ role: string; content: string }> }) =>
    api.post<{ answer: string }>(`/results/${id}/chat`, data),
  renameResult: (id: number, name: string) =>
    api.put<{ success: boolean; custom_name: string | null }>(`/results/${id}/rename`, { name }),
};

export interface SystemHealthCheck {
  ok: boolean;
  [key: string]: any;
}

export interface SystemHealthResponse {
  success: boolean;
  status: 'healthy' | 'degraded' | 'unhealthy';
  warnings: string[];
  checks: Record<string, SystemHealthCheck>;
}

export const systemAPI = {
  getHealth: () => api.get<SystemHealthResponse>('/system/health'),
};

// Reports API
export const reportsAPI = {
  generatePDF: (resultId: number) => 
    api.get(`/reports/pdf/${resultId}`, { responseType: 'blob' }),
  generateBatchPDF: (resultIds: number[]) => 
    api.post('/reports/pdf/batch', { resultIds }, { responseType: 'blob' }),
  listReports: () => api.get('/reports/list'),
  cleanupReports: (maxAge?: number) => api.post('/reports/cleanup', { maxAge }),
};

// Training API
export interface TrainingStats {
  total_results: number;
  unique_assignments: number;
  unique_rubrics: number;
  unique_strictness_levels: number;
  unique_providers: number;
  avg_score: number;
  min_score: number;
  max_score: number;
}

export interface TrainingFile {
  filename: string;
  size: number;
  size_mb: string;
  created: string;
  modified: string;
  format: 'json' | 'jsonl' | 'unknown';
}

export const trainingAPI = {
  getStats: () => api.get('/training/stats'),
  getFiles: () => api.get('/training/files'),
  exportData: (
    format: 'json' | 'openai' | 'anthropic',
    data: {
      includeText?: boolean;
      onlyCurrentVersions?: boolean;
      minScoreCount?: number;
      strictnessLevels?: string[] | null;
      providers?: string[] | null;
    }
  ) => api.post(`/training/export/${format}`, data),
  downloadFile: (filename: string) =>
    api.get(`/training/download/${encodeURIComponent(filename)}`, { responseType: 'blob' }),
  deleteFile: (filename: string) => api.delete(`/training/files/${encodeURIComponent(filename)}`),
};

// MCQ API
export const mcqAPI = {
  process: (data: {
    answer_key: Record<string, string>;
    assignment_ids: number[];
    student_names: (string | null)[];
  }) => api.post('/mcq/process', data),
};

// Rubric Generator API
export const rubricGeneratorAPI = {
  generateFromPDF: (data: {
    assignment_id: number;
    rubric_name?: string;
    rubric_type?: 'auto' | 'rubric' | 'answer_key' | 'memorandum';
  }) => api.post('/rubric-generator/from-pdf', data),
  
  saveGenerated: (data: {
    name: string;
    criteria: RubricCriterion[];
    total_points: number;
    rubric_type?: 'rubric' | 'answer_key';
  }) => api.post('/rubric-generator/save', data),
};

// Batches API
export const batchesAPI = {
  getBatches: () => api.get('/batches'),
  getBatch: (id: number) => api.get(`/batches/${id}`),
  getBatchSummary: (id: number) => api.get<BatchSummary>(`/batches/${id}/summary`),
  createBatch: (data: { name: string; description?: string }) => api.post('/batches', data),
  updateBatch: (id: number, data: { name: string; description?: string }) => api.put(`/batches/${id}`, data),
  deleteBatch: (id: number) => api.delete(`/batches/${id}`),
  assignToBatch: (id: number, assignment_ids: number[]) => api.post(`/batches/${id}/assign`, { assignment_ids }),
  unassignFromBatch: (id: number, assignment_ids: number[]) => api.post(`/batches/${id}/unassign`, { assignment_ids }),
  scheduleMarking: (id: number, data: { rubric_id: number; scheduled_for?: string; strictness_level?: string; feedback_type?: string; feedback_verbosity?: string }) =>
    api.post(`/batches/${id}/schedule-marking`, data),
  getAllJobs: () => api.get('/batches/jobs/all'),
  getJobsHealth: () => api.get<BatchJobsHealthResponse>('/batches/jobs/health'),
  runJobNow: (jobId: number) => api.post(`/batches/jobs/${jobId}/run-now`),
  retryJob: (jobId: number) => api.post(`/batches/jobs/${jobId}/retry`),
};

// Assessments API
export type AssessmentQuestionType = 'essay' | 'multiple_choice' | 'short_answer' | 'problem' | 'mix_and_match';
export interface AssessmentQuestion {
  number: number;
  type: AssessmentQuestionType;
  question: string;
  points: number;
  options?: string[]; // MCQ: choice texts
  correct_answer?: string; // MCQ: e.g. "A" or "1"
  left_column?: string[]; // mix_and_match
  right_column?: string[];
  correct_pairings?: { left_index: number; right_index: number }[] | string[];
  hints?: string[];
  related_criteria?: string[];
}

export interface SuggestedRubricCriterion {
  name: string;
  max_points: number;
  description: string;
}

export interface GeneratedAssessment {
  title: string;
  topic: string;
  difficulty_level: string;
  assessment_type: string;
  instructions: string;
  questions: AssessmentQuestion[];
  total_points: number;
  estimated_time: string;
  suggested_rubric_criteria?: SuggestedRubricCriterion[];
  rubric_alignment?: string; // Explanation of how assessment aligns with rubric
}

export interface PracticalProcedureStep {
  step: number;
  title: string;
  instructions: string;
  expected_outcome?: string;
  teacher_notes?: string;
  code_example?: {
    language: string;
    code: string;
    explanation?: string;
  };
}

export interface PracticalAssessmentCriterion {
  name: string;
  description: string;
  max_points: number;
}

export interface PracticalCodeExample {
  title: string;
  language: string;
  code: string;
  explanation?: string;
}

export interface GeneratedPractical {
  title: string;
  topic: string;
  practical_type: string;
  mode: 'guide' | 'assessment';
  delivery_mode?: 'computer_based' | 'hands_on';
  digital_environment?: string[];
  estimated_duration_minutes: number;
  overview: string;
  learning_objectives: string[];
  materials: string[];
  safety_notes: string[];
  preparation_checklist: string[];
  procedure_steps: PracticalProcedureStep[];
  code_examples?: PracticalCodeExample[];
  reflection_questions: string[];
  optional_assessment: null | {
    submission_instructions: string;
    evidence_requirements: string[];
    rubric_criteria: PracticalAssessmentCriterion[];
    total_points: number;
  };
}

export interface PublishedAssessmentItem {
  id: number;
  code: string;
  title: string;
  link: string;
  created_at: string;
  batch_id?: number | null;
}

export interface AssessmentHistoryItem {
  id: number;
  title: string;
  assessment: GeneratedAssessment;
  input?: any;
  generation_trace?: GenerationTrace | null;
  created_at: string;
}

export interface GenerationTrace {
  prompt_registry_id: number;
  generation_type: string;
  prompt_key: string;
  prompt_version: number;
  provider?: string | null;
  model?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
  source?: 'global' | 'user' | string;
}

export interface AssessmentSubmissionResult {
  total_score: number;
  feedback?: string;
  scores?: any[];
  marked_at?: string | null;
}

export interface AssessmentSubmissionStatus {
  submission_code: string;
  student_name: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  submitted_at: string;
  completed_at?: string | null;
  failure_reason?: string | null;
  result?: AssessmentSubmissionResult | null;
}

export interface SubmissionIdentityHealthSummary {
  total_submissions: number;
  resolved_submissions: number;
  unresolved_submissions: number;
  potential_backfill_matches: number;
}

export interface SubmissionIdentityHealthSample {
  id: number;
  submission_code: string;
  student_name: string;
  status: string;
  submitted_at: string;
  assessment_code: string;
  lecturer_user_id: number;
  potential_match: boolean;
}

export interface SubmissionIdentityHealthResponse {
  success: boolean;
  summary: SubmissionIdentityHealthSummary;
  unresolved_samples: SubmissionIdentityHealthSample[];
}

export interface SubmissionIdentityBackfillResponse {
  success: boolean;
  updated_submissions: number;
}

export interface SubmissionIdentityConflictCandidate {
  id: number;
  name: string;
  email: string | null;
  module_id: number;
  module_name: string | null;
  match_reason: 'name' | 'email' | 'email_local' | 'heuristic' | string;
}

export interface SubmissionIdentityConflictItem {
  id: number;
  submission_code: string;
  student_name: string;
  status: string;
  submitted_at: string;
  assessment_code: string;
  lecturer: {
    id: number;
    name: string;
    email: string | null;
  };
  candidate_count: number;
  candidates: SubmissionIdentityConflictCandidate[];
}

export interface SubmissionIdentityConflictSummary {
  unresolved_submissions: number;
  single_candidate_submissions: number;
  multi_candidate_submissions: number;
  no_candidate_submissions: number;
}

export interface SubmissionIdentityConflictResponse {
  success: boolean;
  summary: SubmissionIdentityConflictSummary;
  items: SubmissionIdentityConflictItem[];
}

export interface SubmissionIdentityResolveResponse {
  success: boolean;
  item: {
    id: number;
    submission_code: string;
    student_name: string;
    status: string;
    submitted_at: string;
    student_user_id: number;
    resolved_student_name: string | null;
    resolved_student_email: string | null;
  };
}

export const assessmentsAPI = {
  generate: (data: {
    rubric_id?: number; // optional when custom_topics is provided
    custom_topics?: string; // topic list (one per line or comma-separated)
    level?: string | null; // e.g. Grade 10, Undergraduate
    difficulty_level?: 'beginner' | 'moderate' | 'advanced';
    question_count?: number;
    assessment_type?: 'assignment' | 'exam' | 'quiz' | 'essay';
    use_existing_patterns?: boolean;
    topic?: string | null;
    question_types?: ('mcq' | 'essay' | 'short_answer' | 'mix_and_match' | 'mix')[];
    content_id?: number;
  }) => api.post<{ success: boolean; assessment: GeneratedAssessment; generation_trace?: GenerationTrace | null }>('/assessments/generate', data),
  generatePractical: (data: {
    topic: string;
    level?: string | null;
    practical_type?: string;
    mode?: 'guide' | 'assessment';
    delivery_mode?: 'computer_based' | 'hands_on';
    include_code_examples?: boolean;
    programming_language?: string | null;
    platform_tools?: string[];
    include_detailed_instructions?: boolean;
    duration_minutes?: number;
    learning_objectives?: string[];
    required_materials?: string[];
    safety_focus?: string[];
  }) => api.post<{ success: boolean; practical: GeneratedPractical; input?: any }>('/assessments/generate-practical', data),
  getStats: () => api.get('/assessments/stats'),
  publish: (data: { assessment: GeneratedAssessment; rubric_id: number; module_id?: number; module_name?: string }) =>
    api.post('/assessments/publish', data),
  getByCode: (code: string) => api.get(`/assessments/take/${code}`),
  submit: (data: { code: string; student_name: string; answers: { question_number: number; value: string }[] }) =>
    api.post('/assessments/submit', data),
  getQuestionAudio: (code: string, questionIndex: number, voiceId = 'eve', language = 'en') =>
    api.get(`/assessments/audio/${code}/${questionIndex}`, {
      params: { voice_id: voiceId, language },
      responseType: 'blob'
    }),
  getSubmissionStatus: (submissionCode: string) => api.get(`/assessments/submission-status/${submissionCode}`),
  getSubmissionIdentityHealth: () =>
    api.get<SubmissionIdentityHealthResponse>('/assessments/admin/submission-identity-health'),
  runSubmissionIdentityBackfill: () =>
    api.post<SubmissionIdentityBackfillResponse>('/assessments/admin/submission-identity-backfill'),
  getSubmissionIdentityConflicts: (params?: { limit?: number }) =>
    api.get<SubmissionIdentityConflictResponse>('/assessments/submission-identity-conflicts', { params }),
  resolveSubmissionIdentityConflict: (submissionId: number, studentUserId: number) =>
    api.post<SubmissionIdentityResolveResponse>(
      `/assessments/submission-identity-conflicts/${submissionId}/resolve`,
      { student_user_id: studentUserId }
    ),
  /** Export as Moodle XML (includes answers). Returns blob. */
  exportMoodleXml: (assessment: GeneratedAssessment) =>
    api.post('/assessments/export/moodle-xml', { assessment }, { responseType: 'blob' }),
  /** Export as SCORM 1.2 ZIP (includes answer key). Returns blob. */
  exportScorm: (assessment: GeneratedAssessment) =>
    api.post('/assessments/export/scorm', { assessment }, { responseType: 'blob' }),
  /** List current user's published assessments (for reusability). */
  getPublished: () => api.get('/assessments/published'),
  /** Delete one published assessment owned by current user. */
  deletePublished: (id: number) => api.delete(`/assessments/published/${id}`),
  saveHistory: (data: { assessment: GeneratedAssessment; input?: any }) =>
    api.post<{ success: boolean; item: AssessmentHistoryItem }>('/assessments/history', data),
  getHistory: () => api.get<{ success: boolean; items: AssessmentHistoryItem[] }>('/assessments/history'),
  deleteHistoryItem: (id: number) => api.delete(`/assessments/history/${id}`),
  clearHistory: () => api.delete('/assessments/history'),
};

// Content generator API
export interface ContentSection {
  /** Assertion-evidence style: one complete sentence (main idea). */
  heading?: string;
  /** Legacy or fallback. */
  title?: string;
  /** One short supporting line for slides. */
  support?: string;
  body: string;
  raw_body?: string;
  body_html?: string;
  background_image_url?: string;
  visuals?: ContentVisual[];
  mascot?: ContentMascot | null;
}
export interface ContentVisual {
  kind: 'image' | 'illustration';
  title?: string;
  alt_text?: string;
  prompt?: string;
  image_url?: string;
}
export interface ContentMascot {
  title?: string;
  alt_text?: string;
  prompt?: string;
  image_url?: string;
}
export interface ContentQuizQuestion {
  number: number;
  type: string;
  question: string;
  points?: number;
  options?: string[];
  correct_answer?: string;
}
export interface GeneratedContent {
  title: string;
  instructions?: string;
  sections: ContentSection[];
  quiz?: { questions: ContentQuizQuestion[]; total_points?: number };
  tts_enabled?: boolean;
  template_id?: string;
  template_name?: string;
  template_images?: string[];
  theme?: {
    font_family?: string;
    bg_color?: string;
    surface_color?: string;
    heading_color?: string;
    text_color?: string;
    accent_color?: string;
  };
}
export interface ContentTemplate {
  id: string;
  name: string;
  kind?: 'builtin' | 'uploaded';
  uploaded_template_id?: number;
  created_at?: string;
  images?: string[];
  theme: {
    font_family?: string;
    bg_color?: string;
    surface_color?: string;
    heading_color?: string;
    text_color?: string;
    accent_color?: string;
  };
}
export interface ContentHistoryItem {
  id: number;
  title: string;
  content?: GeneratedContent | null;
  input?: any;
  generation_trace?: GenerationTrace | null;
  created_at: string;
}
export interface PublishedContentItem {
  id: number;
  code: string;
  title: string;
  sections?: Array<{ index: number; heading: string; preview: string }>;
  content?: GeneratedContent;
  rubric_id?: number | null;
  created_at: string;
}

export interface LearningModuleItem {
  id: number;
  module_id: number;
  item_type: 'content' | 'assessment';
  item_id: number;
  title: string;
  code: string;
  position: number;
  section_index: number; // -1 = whole item, 0+ = specific section
  created_at: string;
}

export interface LearningModuleStudent {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

export interface LearningModule {
  id: number;
  name: string;
  created_at: string;
  items: LearningModuleItem[];
  students: LearningModuleStudent[];
}
export interface HomeworkHistoryItem {
  homework_module_id: number;
  homework_module_name: string;
  homework_created_at: string;
  source_module_id: number | null;
  source_module_name: string;
  student: {
    id: number | null;
    name: string;
    email: string | null;
  };
  workflow: {
    status: 'draft' | 'reviewed' | 'published';
    review_notes: string | null;
    reason_summary: string | null;
    reason_payload: {
      source_module_name?: string;
      student_label?: string;
      submissions_analyzed?: number;
      weak_areas?: HomeworkWeakArea[];
      feedback_themes?: string[];
      rubric_alignment?: string | null;
      rubric_criteria?: Array<{ name: string; max_points: number }>;
      generated_at?: string;
    } | null;
    reviewed_at: string | null;
    published_at: string | null;
    publish_blockers?: string[];
  };
  content: {
    id: number | null;
    title: string;
    code: string | null;
  } | null;
  assessment: {
    id: number | null;
    title: string;
    code: string | null;
  } | null;
}
export interface HomeworkWeakAreaOutcome {
  criterion_name: string;
  baseline_percent: number;
  current_percent: number | null;
  delta_percent: number | null;
  status: 'improved' | 'unchanged' | 'declined' | 'unknown';
}
export interface HomeworkOutcomeItem {
  homework_module_id: number;
  homework_module_name: string;
  homework_created_at: string | null;
  student: {
    id: number | null;
    name: string;
    email: string | null;
  };
  assessment: {
    id: number | null;
    title: string | null;
  };
  attempts_total: number;
  completed_attempts: number;
  latest_completed_at: string | null;
  latest_score_percent: number | null;
  weak_area_outcomes: HomeworkWeakAreaOutcome[];
  summary: {
    improved_count: number;
    declined_count: number;
    unchanged_count: number;
    impact_percent?: number | null;
    impact_status?: 'positive' | 'neutral' | 'negative' | 'unknown' | string;
    follow_up_recommended: boolean;
  };
}
export interface HomeworkTrendTimelineItem {
  homework_module_id: number;
  homework_module_name: string;
  homework_created_at: string | null;
  student: {
    id: number | null;
    name: string;
    email: string | null;
  };
  latest_score_percent: number | null;
  latest_completed_at: string | null;
  impact_percent: number | null;
  impact_status: 'positive' | 'neutral' | 'negative' | 'unknown' | string;
  improved_count: number;
  unchanged_count: number;
  declined_count: number;
  follow_up_recommended: boolean;
}
export interface HomeworkTrendStudentSummary {
  student: {
    id: number | null;
    name: string;
    email: string | null;
  };
  cycles: number;
  latest_score_percent: number | null;
  avg_score_percent: number | null;
  avg_impact_percent: number | null;
  improved_cycles: number;
  declined_cycles: number;
  latest_completed_at: string | null;
}
export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  returned: number;
  has_more: boolean;
}
export interface HomeworkTrendsResponse {
  success: boolean;
  summary: {
    total_cycles: number;
    student_count: number;
    improved_cycles: number;
    declined_cycles: number;
    avg_impact_percent: number | null;
  };
  students: HomeworkTrendStudentSummary[];
  timeline: HomeworkTrendTimelineItem[];
  pagination?: PaginationMeta;
}
export interface HomeworkReviewQueueItem {
  homework_module_id: number;
  homework_module_name: string;
  workflow_status: 'draft' | 'reviewed';
  student: {
    id: number | null;
    name: string;
    email: string | null;
  };
  updated_at: string | null;
  age_days: number;
  needs_reminder: boolean;
  blockers: string[];
}
export interface HomeworkReviewQueueResponse {
  success: boolean;
  summary: {
    queue_count: number;
    reminder_count: number;
    older_than_days: number;
    reminder_days: number;
  };
  items: HomeworkReviewQueueItem[];
  pagination?: PaginationMeta;
}
export interface StudentHomeworkProgressItem {
  homework_module_id: number;
  homework_module_name: string;
  homework_created_at: string | null;
  assessment: {
    id: number | null;
    title: string | null;
  };
  attempts_total: number;
  completed_attempts: number;
  latest_completed_at: string | null;
  latest_score_percent: number | null;
  weak_area_outcomes: HomeworkWeakAreaOutcome[];
}
export interface HomeworkWeakArea {
  criterion_name: string;
  avg_percent: number;
  attempts: number;
}
export interface CustomHomeworkGenerationResponse {
  success: boolean;
  message: string;
  homework_module: { id: number; name: string };
  source_module: { id: number; name: string };
  student: { id: number; name: string; email: string };
  analysis: {
    submissions_analyzed: number;
    weak_areas: HomeworkWeakArea[];
    feedback_themes: string[];
  };
  generated: {
    content: { id: number; code: string; title: string; link: string };
    assessment: {
      id: number;
      code: string;
      title: string;
      rubric_id: number;
      generation_mode?: 'ai' | 'fallback';
      generation_warning?: string | null;
      link: string;
    };
  };
}
export interface CustomHomeworkTelemetrySummary {
  total_events: number;
  success_events: number;
  error_events: number;
  fallback_events: number;
  average_duration_ms: number;
  total_estimated_cost_usd: number;
}
export interface CustomHomeworkTelemetryTrendItem {
  date: string;
  total_events: number;
  success_events: number;
  error_events: number;
  fallback_events: number;
}
export interface CustomHomeworkTelemetryEvent {
  id: number;
  status: string;
  duration_ms: number;
  content_generation_ms: number | null;
  assessment_generation_ms: number | null;
  assessment_generation_mode: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  error_message: string | null;
  metadata: {
    source_module_id?: number | null;
    student_user_id?: number | null;
    level?: string | null;
    num_sections?: number | null;
    question_count?: number | null;
    include_diagrams?: boolean | null;
    include_images?: boolean | null;
    assessment_provider?: string | null;
    assessment_model?: string | null;
    assessment_generation_mode?: string | null;
    assessment_generation_warning?: string | null;
    submission_rows?: number | null;
    completed_rows?: number | null;
    weak_area_count?: number | null;
    generated_question_count?: number | null;
    homework_module_id?: number | null;
  };
  created_at: string;
  owner: { id: number; name: string; email: string | null };
}
export interface HomeworkWorkflowAuditEvent {
  id: number;
  action: string;
  status: string | null;
  target_count: number;
  updated_count: number;
  skipped_count: number;
  module_ids: number[];
  metadata: Record<string, any>;
  created_at: string;
  owner: { id: number; name: string; email: string | null };
}
export interface CustomHomeworkTelemetryResponse {
  success: boolean;
  summary: CustomHomeworkTelemetrySummary;
  daily_trend: CustomHomeworkTelemetryTrendItem[];
  recent_events: CustomHomeworkTelemetryEvent[];
  workflow_recent_events: HomeworkWorkflowAuditEvent[];
  workflow_metrics?: {
    review_backlog_count: number;
    average_publish_latency_hours: number;
    published_completion_rate_percent: number;
    published_modules: number;
  };
}
export interface GenerationTelemetrySummary {
  total_events: number;
  success_events: number;
  error_events: number;
  error_rate_percent: number;
  average_duration_ms: number;
  total_estimated_cost_usd: number;
}
export interface GenerationTelemetryTypeItem {
  generation_type: string;
  total_events: number;
  success_events: number;
  error_events: number;
  error_rate_percent: number;
  average_duration_ms: number;
  total_estimated_cost_usd: number;
}
export interface GenerationTelemetryTrendItem {
  date: string;
  total_events: number;
  success_events: number;
  error_events: number;
  total_estimated_cost_usd: number;
}
export interface GenerationTelemetryEvent {
  id: number;
  generation_type: string;
  status: string;
  provider: string | null;
  model: string | null;
  duration_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  error_type: string | null;
  error_message: string | null;
  metadata: Record<string, any>;
  created_at: string;
  owner: { id: number; name: string; email: string | null };
}
export interface GenerationTelemetryResponse {
  success: boolean;
  summary: GenerationTelemetrySummary;
  by_type: GenerationTelemetryTypeItem[];
  daily_trend: GenerationTelemetryTrendItem[];
  recent_events: GenerationTelemetryEvent[];
}
export interface BudgetGuardrailSummary {
  users_analyzed: number;
  users_at_or_above_budget: number;
  users_near_budget: number;
  total_spent_last_24h_usd: number;
  average_spent_last_24h_usd: number;
}
export interface BudgetGuardrailItem {
  user: { id: number; name: string; email: string | null };
  spent_last_24h_usd: number;
  daily_budget_usd: number;
  remaining_usd: number;
  usage_percent: number;
  at_or_above_budget: boolean;
  near_budget: boolean;
}
export interface BudgetGuardrailsResponse {
  success: boolean;
  config: {
    enabled: boolean;
    daily_budget_usd: number;
    warning_threshold_percent: number;
  };
  summary: BudgetGuardrailSummary;
  items: BudgetGuardrailItem[];
}
export interface GenerationJobTimelineEvent {
  status: string;
  at: string;
}
export interface GenerationJobItem {
  id: number;
  user_id: number;
  job_type: string;
  status: string;
  source_route: string | null;
  retry_count: number;
  max_retries: number;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  error_message: string | null;
  payload: Record<string, any> | null;
  result: Record<string, any> | null;
  timeline: GenerationJobTimelineEvent[];
}
export interface GenerationJobsResponse {
  success: boolean;
  items: GenerationJobItem[];
}
export interface GenerationJobDeadLetterItem {
  id: number;
  job_id: number;
  user_id: number;
  owner_name: string;
  owner_email: string | null;
  job_type: string;
  status: string;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  payload: Record<string, any> | null;
  result: Record<string, any> | null;
  dead_letter_reason: string | null;
  created_at: string | null;
}
export interface GenerationJobDeadLettersResponse {
  success: boolean;
  items: GenerationJobDeadLetterItem[];
}
export interface PromptRegistryItem {
  id: number;
  user_id: number | null;
  generation_type: string;
  prompt_key: string;
  version: number;
  prompt_text: string;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  max_tokens: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string | null;
}
export interface PromptRegistryResponse {
  success: boolean;
  items: PromptRegistryItem[];
}
export interface ContentPlannerJob {
  id: number;
  topics: string;
  level?: string | null;
  num_sections: number;
  template_id?: string | null;
  include_diagrams?: boolean | null;
  include_images?: boolean | null;
  include_mascot?: boolean | null;
  include_beautify_text?: boolean | null;
  rubric_id?: number | null;
  scheduled_for: string;
  status: 'scheduled' | 'processing' | 'completed' | 'failed' | 'cancelled';
  error_message?: string | null;
  published_content_id?: number | null;
  published_code?: string | null;
  created_at: string;
  updated_at: string;
}
export const contentAPI = {
  generate: (data: {
    topics: string;
    level?: string;
    num_sections?: number;
    rubric_id?: number;
    rubric_context?: string;
    template_id?: string;
    include_diagrams?: boolean;
    include_images?: boolean;
    include_mascot?: boolean;
    include_beautify_text?: boolean;
  }) => api.post<{ success: boolean; content: GeneratedContent; generation_trace?: GenerationTrace | null; generation_job_id?: number | null }>('/content/generate', data),
  publish: (data: { content: GeneratedContent; rubric_id?: number; include_video?: boolean; module_id?: number; module_name?: string }) =>
    api.post('/content/publish', data),
  getMy: () => api.get<{ success: boolean; items: PublishedContentItem[] }>('/content/my'),
  getMyItem: (id: number) => api.get<{ success: boolean; item: PublishedContentItem }>(`/content/my/${id}`),
  updateMy: (id: number, data: { content: GeneratedContent; rubric_id?: number | null }) =>
    api.put<{ success: boolean; item: PublishedContentItem }>(`/content/my/${id}`, data),
  deleteMy: (id: number) => api.delete(`/content/my/${id}`),
  getByCode: (code: string) => api.get(`/content/take/${code}`),
  regenerateVisual: (data: {
    visual: ContentVisual;
    content_title?: string;
    section_heading?: string;
    section_body?: string;
  }) => api.post<{ success: boolean; visual: ContentVisual }>('/content/regenerate-visual', data),
  regenerateMascot: (data: {
    mascot: ContentMascot;
    content_title?: string;
    section_heading?: string;
    section_body?: string;
  }) => api.post<{ success: boolean; mascot: ContentMascot }>('/content/regenerate-mascot', data),
  submitQuiz: (data: { code: string; student_name: string; answers: { question_number: number; value: string }[] }) =>
    api.post('/content/submit-quiz', data),
  getSectionAudio: (code: string, sectionIndex: number, voiceId = 'eve', language = 'en') =>
    api.get(`/content/audio/${code}/${sectionIndex}`, {
      params: { voice_id: voiceId, language },
      responseType: 'blob'
    }),
  getCheckpointQuestionAudio: (code: string, questionIndex: number, voiceId = 'eve', language = 'en') =>
    api.get(`/content/checkpoint-audio/${code}/${questionIndex}`, {
      params: { voice_id: voiceId, language },
      responseType: 'blob'
    }),
  getVideoStatus: (code: string) => api.get(`/content/video-status/${code}`),
  getVideoContent: (code: string) => api.get(`/content/video/${code}/content`, { responseType: 'blob' }),
  getVideoContentUrl: (code: string) => `${API_BASE_URL}/content/video/${encodeURIComponent(code)}/content`,
  exportPptx: (content: GeneratedContent, provider?: 'anthropic' | 'openai') =>
    api.post('/content/export/pptx', { content, provider }, { responseType: 'blob' }),
  exportLectureNotes: (content: GeneratedContent) =>
    api.post('/content/export/lecture-notes', { content }, { responseType: 'blob' }),
  exportScorm: (content: GeneratedContent) =>
    api.post('/content/export/scorm', { content }, { responseType: 'blob' }),
  getTemplates: () => api.get<{ success: boolean; templates: ContentTemplate[] }>('/content/templates'),
  uploadTemplate: (file: File) => {
    const form = new FormData();
    form.append('template', file);
    return api.post('/content/template', form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  deleteTemplate: (templateId: string) => api.delete(`/content/template/${encodeURIComponent(templateId)}`),
  uploadTopicsFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post<{
      success: boolean;
      topics: string;
      file_name?: string;
      suggested_sections?: number;
      detected_outline_items?: number;
      inference_note?: string;
      confidence?: 'high' | 'medium' | 'low';
      inference_method?: 'ai' | 'heuristic';
    }>('/content/topics/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  schedulePlanner: (data: {
    topics: string;
    level?: string;
    num_sections?: number;
    rubric_id?: number;
    rubric_context?: string;
    template_id?: string;
    scheduled_for: string;
    include_diagrams?: boolean;
    include_images?: boolean;
    include_mascot?: boolean;
    include_beautify_text?: boolean;
  }) => api.post('/content/planner/schedule', data),
  getPlannerJobs: () => api.get<{ success: boolean; jobs: ContentPlannerJob[] }>('/content/planner/jobs'),
  cancelPlannerJob: (id: number) => api.post(`/content/planner/${id}/cancel`),
  saveHistory: (data: { content: GeneratedContent; input?: any }) =>
    api.post<{ success: boolean; item: ContentHistoryItem }>('/content/history', data),
  updateHistoryItem: (id: number, data: { content: GeneratedContent; input?: any }) =>
    api.put<{ success: boolean; item: ContentHistoryItem }>(`/content/history/${id}`, data),
  getHistory: () => api.get<{ success: boolean; items: ContentHistoryItem[] }>('/content/history'),
  getHistoryItem: (id: number) => api.get<{ success: boolean; item: ContentHistoryItem }>(`/content/history/${id}`),
  deleteHistoryItem: (id: number) => api.delete(`/content/history/${id}`),
  clearHistory: () => api.delete('/content/history'),
  saveProgress: (data: {
    code: string;
    student_name: string;
    current_section?: number;
    checkpoint_answers?: Record<number, string>;
    progress?: any;
    completed?: boolean;
    score?: number | null;
  }) => api.post('/content/progress', data),
  getProgress: (code: string, studentName: string) =>
    api.get(`/content/progress/${code}`, { params: { student_name: studentName } }),
  streamJobProgress: (
    jobId: number,
    callbacks: {
      onProgress?: (data: { status: string; progress: any }) => void;
      onDone?: (status: string) => void;
      onError?: (message: string) => void;
    }
  ): (() => void) => {
    const token = localStorage.getItem('token');
    const url = `${API_BASE_URL}/content/jobs/${jobId}/progress-stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const es = new EventSource(url);

    es.addEventListener('connected', () => {});
    es.addEventListener('progress', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        callbacks.onProgress?.(data);
      } catch (_) {}
    });
    es.addEventListener('done', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        callbacks.onDone?.(data.status);
      } catch (_) {}
      es.close();
    });
    es.addEventListener('error', (e: MessageEvent) => {
      try {
        const data = JSON.parse((e as any).data || '{}');
        callbacks.onError?.(data.message || 'Stream error');
      } catch (_) {
        callbacks.onError?.('Stream error');
      }
      es.close();
    });
    es.onerror = () => {
      callbacks.onError?.('Connection lost');
      es.close();
    };

    return () => es.close();
  },
};

// ─── Batched PPTX job API ────────────────────────────────────────────────────


export interface PptxJobProgress {
  step?: 'extracting' | 'populating' | 'building' | 'merging' | 'done' | 'failed';
  chunk?: number;
  totalChunks?: number;
  turn?: number;
  totalTurns?: number;
  finalReady?: boolean;
}

export interface PptxJobStatus {
  id: number;
  status: 'processing' | 'completed' | 'failed' | 'scheduled' | 'queued' | 'retrying' | 'cancelled';
  progress: PptxJobProgress;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export const pptxJobsAPI = {
  create: (content: GeneratedContent, useAI = true) =>
    api.post<{ success: boolean; jobId: number }>('/pptx-jobs', { content, useAI }),
  getStatus: (jobId: number) =>
    api.get<PptxJobStatus & { success: boolean }>(`/pptx-jobs/${jobId}`),
  retry: (jobId: number) =>
    api.post<{ success: boolean }>(`/pptx-jobs/${jobId}/retry`),
  download: (jobId: number) =>
    api.get(`/pptx-jobs/${jobId}/download`, { responseType: 'blob' }),
  downloadPartial: (jobId: number) =>
    api.get(`/pptx-jobs/${jobId}/download-partial`, { responseType: 'blob' }),
};

export const modulesAPI = {
  list: () => api.get<{ success: boolean; modules: LearningModule[] }>('/modules'),
  listAvailableStudents: () => api.get<{ success: boolean; students: { id: number; name: string; email: string }[] }>('/modules/students/available'),
  create: (name: string) => api.post<{ success: boolean; module: LearningModule }>('/modules', { name }),
  update: (id: number, name: string) => api.put(`/modules/${id}`, { name }),
  remove: (id: number) => api.delete(`/modules/${id}`),
  addItem: (moduleId: number, itemType: 'content' | 'assessment', itemId: number, sectionIndex?: number) =>
    api.post(`/modules/${moduleId}/items`, { item_type: itemType, item_id: itemId, section_index: sectionIndex }),
  removeItem: (moduleId: number, moduleItemId: number) => api.delete(`/modules/${moduleId}/items/${moduleItemId}`),
  reorderItems: (moduleId: number, itemIds: number[]) => api.put(`/modules/${moduleId}/reorder`, { item_ids: itemIds }),
  addStudent: (moduleId: number, studentUserId: number) => api.post(`/modules/${moduleId}/students`, { student_user_id: studentUserId }),
  removeStudent: (moduleId: number, studentUserId: number) => api.delete(`/modules/${moduleId}/students/${studentUserId}`),
  getHomeworkHistory: (params?: { limit?: number; offset?: number; bypass_cache?: boolean }) =>
    api.get<{ success: boolean; items: HomeworkHistoryItem[]; pagination?: PaginationMeta }>('/modules/homework-history', { params }),
  getHomeworkReviewQueue: (params?: { status?: 'all' | 'draft' | 'reviewed'; older_than_days?: number; reminder_days?: number; limit?: number; offset?: number; bypass_cache?: boolean }) =>
    api.get<HomeworkReviewQueueResponse>('/modules/homework-review-queue', { params }),
  getHomeworkOutcomes: (params?: { limit?: number; offset?: number; bypass_cache?: boolean }) =>
    api.get<{ success: boolean; items: HomeworkOutcomeItem[]; pagination?: PaginationMeta }>('/modules/homework-outcomes', { params }),
  getHomeworkTrends: (params?: { student_id?: number; limit?: number; offset?: number; bypass_cache?: boolean }) =>
    api.get<HomeworkTrendsResponse>('/modules/homework-trends', { params }),
  updateHomeworkWorkflow: (
    moduleId: number,
    data: { status: 'draft' | 'reviewed' | 'published'; review_notes?: string | null }
  ) => api.put<{ success: boolean; workflow: any }>(`/modules/${moduleId}/homework-workflow`, data),
  bulkUpdateHomeworkWorkflow: (
    moduleIds: number[],
    data: { status: 'draft' | 'reviewed' | 'published' }
  ) => api.put<{
    success: boolean;
    updated_count: number;
    skipped_ids: number[];
    skipped_details?: Array<{ module_id: number; blockers: string[] }>;
  }>('/modules/homework-workflow/bulk', {
    module_ids: moduleIds,
    status: data.status,
  }),
  generateCustomHomework: (
    moduleId: number,
    data: {
      student_user_id: number;
      student_name?: string;
      level?: string;
      num_sections?: number;
      question_count?: number;
      include_diagrams?: boolean;
      include_images?: boolean;
    }
  ) => api.post<CustomHomeworkGenerationResponse>(`/modules/${moduleId}/custom-homework`, data),
  getCustomHomeworkTelemetry: () =>
    api.get<CustomHomeworkTelemetryResponse>('/modules/admin/custom-homework-telemetry'),
  getGenerationTelemetry: (params?: { days?: number; limit?: number }) =>
    api.get<GenerationTelemetryResponse>('/modules/admin/generation-telemetry', { params }),
  getBudgetGuardrails: (params?: { limit?: number; near_threshold_percent?: number }) =>
    api.get<BudgetGuardrailsResponse>('/modules/admin/budget-guardrails', { params }),
  getGenerationJobs: (params?: { limit?: number; scope?: 'mine' | 'all'; include_full_result?: boolean }) =>
    api.get<GenerationJobsResponse>('/modules/generation-jobs', { params }),
  getGenerationJobDeadLetters: (params?: { limit?: number }) =>
    api.get<GenerationJobDeadLettersResponse>('/modules/generation-jobs/dead-letters', { params }),
  retryGenerationJob: (id: number) =>
    api.post<{ success: boolean; message: string }>(`/modules/generation-jobs/${id}/retry`),
  getPromptRegistry: (params?: { generation_type?: string; scope?: 'mine' | 'all'; limit?: number }) =>
    api.get<PromptRegistryResponse>('/modules/admin/prompt-registry', { params }),
  createPromptRegistryVersion: (data: {
    generation_type: string;
    prompt_key?: string;
    prompt_text: string;
    provider?: string | null;
    model?: string | null;
    temperature?: number | null;
    max_tokens?: number | null;
    notes?: string | null;
    is_active?: boolean;
    is_global?: boolean;
  }) => api.post<{ success: boolean; item: PromptRegistryItem }>('/modules/admin/prompt-registry', data),
  getStudentModules: () => api.get<{ success: boolean; modules: LearningModule[] }>('/modules/student'),
  getStudentHomeworkProgress: () =>
    api.get<{ success: boolean; items: StudentHomeworkProgressItem[] }>('/modules/student/homework-progress'),
};

// ── Slide Template Populator (Labs) ──────────────────────────
export type SlideType =
  | 'title'
  | 'learning_objectives'
  | 'content'
  | 'question'
  | 'activity'
  | 'summary'
  | 'quiz'
  | 'transition'
  | 'unknown';

export interface GeneratedSlide {
  slideIndex: number;
  slideType: SlideType;
  title: string;
  bullets: string[];
  backgroundId?: string;
}

export interface TemplateBackground {
  id: string;
  label: string;
  isDark: boolean;
  previewCss: string;
  imageFilename: string | null;
  bgXml: string;
  sourceZipEntry?: string | null;
}

export interface TemplateImageAsset {
  id: string;
  label: string;
  filename: string;
  sourceZipEntry: string;
  mimeType: string;
  sizeBytes: number;
  usedAsBackground: boolean;
  vision?: {
    shortLabel?: string;
    description?: string;
    likelyBackground?: boolean;
  } | null;
}

export type DetailLevel = 'minimal' | 'standard' | 'detailed' | 'comprehensive';

export interface SlideBatchUnit {
  title: string;
  slideCount: number;
  includeQuiz: boolean;
}

export type SlideBatchJobStatus = 'scheduled' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface SlideBatchListItem {
  id: number;
  status: SlideBatchJobStatus;
  createdAt: string;
  scheduledFor: string | null;
  errorMessage: string | null;
  unitCount: number;
  units: { title: string; slideCount: number; includeQuiz: boolean }[];
  subject: string;
  level: string;
  detailLevel: string;
}

export interface SlideBatchStatus {
  id: number;
  status: SlideBatchJobStatus;
  scheduledFor: string | null;
  unitCount: number;
  errorMessage: string | null;
  progress: {
    completedUnits?: number;
    totalUnits?: number;
    contentReady?: boolean;
  };
}

export const slideGenAPI = {
  analyse: (file: File): Promise<{ sessionId: string; backgrounds: TemplateBackground[]; images?: TemplateImageAsset[] }> => {
    const form = new FormData();
    form.append('template', file);
    return api.post('/slide-gen/analyse', form, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((r) => r.data);
  },
  generateContent: (params: {
    topic: string;
    teachingGoal?: string;
    subject?: string;
    level?: string;
    slideCount?: number;
    detailLevel?: DetailLevel;
    backgrounds?: TemplateBackground[];
  }): Promise<{ content: GeneratedSlide[] }> => {
    return api.post('/slide-gen/generate-content', params).then((r) => r.data);
  },
  populate: (params: {
    sessionId: string;
    topic: string;
    subject?: string;
    level?: string;
    content: GeneratedSlide[];
    backgrounds: Record<number, string>;
    templateBgs: TemplateBackground[];
    templateImages?: TemplateImageAsset[];
    generateImages?: boolean;
  }): Promise<Blob> => {
    return api.post('/slide-gen/populate', params, { responseType: 'blob' })
      .then((r) => r.data as Blob);
  },
  createBatch: (params: {
    units: SlideBatchUnit[];
    subject?: string;
    level?: string;
    detailLevel?: DetailLevel;
    scheduledFor?: string | null;
    sessionId?: string;
    backgrounds?: TemplateBackground[];
    templateBgs?: TemplateBackground[];
    templateImages?: TemplateImageAsset[];
    generateImages?: boolean;
  }): Promise<{ success: boolean; jobId: number }> => {
    return api.post('/slide-gen/batch', params).then((r) => r.data);
  },
  listBatches: (limit?: number): Promise<{ success: boolean; jobs: SlideBatchListItem[] }> => {
    return api.get('/slide-gen/batch', { params: limit ? { limit } : {} }).then((r) => r.data);
  },
  getBatchStatus: (jobId: number): Promise<{ success: boolean } & SlideBatchStatus> => {
    return api.get(`/slide-gen/batch/${jobId}`).then((r) => r.data);
  },
  downloadBatch: (jobId: number): Promise<Blob> => {
    return api.get(`/slide-gen/batch/${jobId}/download`, { responseType: 'blob' })
      .then((r) => r.data as Blob);
  },
};

// ── Moodle integration API ─────────────────────────────────────
export interface MoodleConnection {
  moodle_url: string;
  site_name: string | null;
  moodle_user_id: number | null;
}

export interface MoodleCourse {
  id: number;
  fullname: string;
  shortname: string;
  summary: string;
}

export interface MoodleAssignment {
  id: number;
  cmid: number;
  name: string;
  duedate: number;
  nosubmissions: number;
}

export interface MoodleQuiz {
  id: number;
  coursemodule: number;
  name: string;
  intro: string;
  timelimit: number;
  sumgrades: number;
}

export interface MoodleUser {
  id: number;
  fullname: string;
  email: string;
  username: string;
}

export interface GradeEntry {
  moodle_user_id: number;
  grade: number;
  feedback?: string;
}

export const moodleAPI = {
  getSettings: () => api.get<{ success: boolean; connection: MoodleConnection | null }>('/moodle/settings'),
  saveSettings: (data: { moodle_url: string; moodle_token: string }) =>
    api.post<{ success: boolean; site_name: string; moodle_url: string; moodle_user_id: number | null }>('/moodle/settings', data),
  deleteSettings: () => api.delete('/moodle/settings'),
  getCourses: () => api.get<{ success: boolean; courses: MoodleCourse[] }>('/moodle/courses'),
  getAssignments: (courseId: number) =>
    api.get<{ success: boolean; assignments: MoodleAssignment[] }>(`/moodle/courses/${courseId}/assignments`),
  getQuizzes: (courseId: number) =>
    api.get<{ success: boolean; quizzes: MoodleQuiz[] }>(`/moodle/courses/${courseId}/quizzes`),
  getCourseUsers: (courseId: number) =>
    api.get<{ success: boolean; users: MoodleUser[] }>(`/moodle/courses/${courseId}/users`),
  pushGrades: (data: { assignment_cmid: number; grades: GradeEntry[] }) =>
    api.post<{ success: boolean; pushed: number }>('/moodle/grades/push', data),
  importXml: (xml: string) =>
    api.post<{ success: boolean; question_count: number; title: string; history_id: number }>('/moodle/import/xml', { xml }),
};

// Authentication API
export const authAPI = {
  register: async (
    email: string,
    password: string,
    name?: string,
    accountType?: 'individual' | 'organisation',
    organisationName?: string
  ) => {
    const response = await api.post('/auth/register', {
      email,
      password,
      name,
      account_type: accountType,
      organisation_name: organisationName
    });
    return {
      user: response.data.user,
      token: response.data.token || null,
      requiresVerification: response.data.requiresVerification || false,
      message: response.data.message,
      verificationUrl: response.data.verificationUrl
    };
  },
  
  login: async (email: string, password: string) => {
    const response = await api.post('/auth/login', { email, password });
    return {
      user: response.data.user,
      token: response.data.token
    };
  },
  
  logout: async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      // Ignore errors on logout
    }
  },
  
  getCurrentUser: async (token: string) => {
    const response = await api.get('/auth/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data.user;
  },
  
  updateProfile: async (token: string, name?: string, email?: string) => {
    const response = await api.put('/auth/profile', { name, email }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data.user;
  },
  
  changePassword: async (token: string, currentPassword: string, newPassword: string) => {
    await api.put('/auth/change-password', { currentPassword, newPassword }, {
      headers: { Authorization: `Bearer ${token}` }
    });
  },
  
  verifyEmail: async (token: string) => {
    const response = await api.get(`/auth/verify-email?token=${token}`);
    return response.data;
  },
  
  resendVerification: async (email: string) => {
    const response = await api.post('/auth/resend-verification', { email });
    return response.data;
  },
  
  // Admin endpoints
  getPendingUsers: async (token: string) => {
    const response = await api.get('/auth/admin/pending-users', {
      headers: { Authorization: `Bearer ${token}` }
    });
    return Array.isArray(response.data?.users) ? response.data.users : [];
  },
  
  getAllUsers: async (token: string) => {
    const response = await api.get('/auth/admin/users', {
      headers: { Authorization: `Bearer ${token}` }
    });
    return Array.isArray(response.data?.users) ? response.data.users : [];
  },

  getOrganisations: async (token: string) => {
    const response = await api.get('/auth/admin/organisations', {
      headers: { Authorization: `Bearer ${token}` }
    });
    return Array.isArray(response.data?.organisations) ? response.data.organisations : [];
  },

  getDepartments: async (token: string) => {
    const response = await api.get('/auth/admin/departments', {
      headers: { Authorization: `Bearer ${token}` }
    });
    return Array.isArray(response.data?.departments) ? response.data.departments : [];
  },

  createOrganisation: async (token: string, name: string) => {
    const response = await api.post('/auth/admin/organisations', { name }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },

  updateOrganisationFeatures: async (token: string, organisationId: number, features: FeatureFlags) => {
    const response = await api.put(`/auth/admin/organisations/${organisationId}/features`, { features }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },

  createDepartment: async (token: string, name: string, organisation_id?: number | null) => {
    const response = await api.post('/auth/admin/departments', { name, organisation_id }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },
  
  approveUser: async (token: string, userId: number) => {
    const response = await api.post(`/auth/admin/users/${userId}/approve`, {}, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },
  
  rejectUser: async (token: string, userId: number, deactivate?: boolean) => {
    const response = await api.post(`/auth/admin/users/${userId}/reject`, { deactivate }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },
  
  updateUserRole: async (token: string, userId: number, role: 'management' | 'lecturer' | 'student') => {
    const response = await api.put(`/auth/admin/users/${userId}/role`, { role }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },

  impersonateUser: async (token: string, userId: number) => {
    const response = await api.post(`/auth/admin/users/${userId}/impersonate`, {}, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },

  lockUser: async (token: string, userId: number, locked: boolean) => {
    const response = await api.put(`/auth/admin/users/${userId}/lock`, { locked }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },

  deleteUser: async (token: string, userId: number) => {
    const response = await api.delete(`/auth/admin/users/${userId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },

  updateUserFeatures: async (
    token: string,
    userId: number,
    features: { assessment_creation?: boolean; content_creation?: boolean; download_results?: boolean; feedback_video?: boolean }
  ) => {
    const response = await api.put(`/auth/admin/users/${userId}/features`, { features }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },

  updateUserOrganisation: async (token: string, userId: number, organisation_id: number | null) => {
    const response = await api.put(`/auth/admin/users/${userId}/organisation`, { organisation_id }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  },

  updateUserDepartment: async (token: string, userId: number, department_id: number | null) => {
    const response = await api.put(`/auth/admin/users/${userId}/department`, { department_id }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  }
};

// ─── Revision Tracking ──────────────────────────────────────────────────────

export interface RevisionCriterionChange {
  criterion: string;
  detail: string;
}

export interface RevisionComparison {
  improved_criteria: RevisionCriterionChange[];
  regressed_criteria: RevisionCriterionChange[];
  unchanged_criteria: RevisionCriterionChange[];
  narrative_summary: string;
  key_improvement: string;
  key_remaining_issue: string;
}

export interface RevisionScore {
  criterion_name: string;
  points_awarded: number;
  max_points: number;
  feedback: string;
  confidence?: number;
}

export interface RevisionSubmission {
  id: number;
  revision_number: number;
  progress_score: number;
  overall_feedback: string;
  total_score: number;
  scores: RevisionScore[];
  corrections: unknown[];
  comparison: RevisionComparison | null;
  filename: string;
  uploaded_at: string;
}

export interface RevisionSeries {
  id: number;
  name: string;
  student_name: string;
  rubric_id: number;
  rubric_name: string;
  total_points: number;
  criteria?: unknown[];
  created_at: string;
}

export interface RevisionSeriesListItem extends RevisionSeries {
  revision_count: number;
  latest_progress: number;
  last_uploaded: string | null;
}

export const revisionsApi = {
  createSeries: async (name: string, student_name: string, rubric_id: number) => {
    const response = await api.post('/revisions', { name, student_name, rubric_id });
    return response.data as { success: boolean; series: RevisionSeries };
  },

  listSeries: async () => {
    const response = await api.get('/revisions');
    return response.data as {
      series: RevisionSeriesListItem[];
      by_student: Record<string, RevisionSeriesListItem[]>;
    };
  },

  getSeriesDetail: async (id: number) => {
    const response = await api.get(`/revisions/${id}`);
    return response.data as { series: RevisionSeries; revisions: RevisionSubmission[] };
  },

  uploadRevision: async (seriesId: number, file: File, onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append('file', file);
    const response = await api.post(`/revisions/${seriesId}/upload`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: onProgress
        ? (e) => { if (e.total) onProgress(Math.round((e.loaded / e.total) * 100)); }
        : undefined
    });
    return response.data as {
      success: boolean;
      revision_number: number;
      progress_score: number;
      total_score: number;
      total_points: number;
      scores: RevisionScore[];
      overall_feedback: string;
      corrections: unknown[];
      comparison: RevisionComparison | null;
    };
  },

  deleteSeries: async (id: number) => {
    const response = await api.delete(`/revisions/${id}`);
    return response.data as { success: boolean };
  }
};

export interface UserSession {
  id: number;
  user_id: number;
  email: string;
  name: string | null;
  role: string;
  organisation_name: string | null;
  ip_address: string | null;
  user_agent: string | null;
  logged_in_at: string;
  last_seen_at: string;
}

export const sessionsApi = {
  getSessions: async () => {
    const response = await api.get('/auth/admin/sessions');
    return response.data as { sessions: UserSession[] };
  },

  revokeSession: async (id: number) => {
    const response = await api.delete(`/auth/admin/sessions/${id}`);
    return response.data as { success: boolean };
  }
};

export default api;
