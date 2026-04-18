import axios from 'axios';

// Use /tools/api in production when app is at /tools, or localhost for development.
// Must match server API path so feedback-video and other /results routes resolve correctly.
const API_BASE_URL = import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? 'http://localhost:3001/api' : '/tools/api');

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

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
  (error) => {
    console.error('API Error:', error.response?.data || error.message);
    
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
  file_path: string;
  file_size: number;
  uploaded_at: string;
  status: 'uploaded' | 'processing' | 'completed' | 'error';
  batch_id?: number | null;
  extracted_text?: string | null; // PDF text extracted and stored in database
}

export interface Batch {
  id: number;
  name: string;
  description?: string | null;
  created_at: string;
  assignment_count?: number;
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
export const markingAPI = {
  markSingle: (data: {
    assignment_id: number;
    rubric_id: number;
    student_name?: string;
    output_type?: 'annotate' | 'report';
    assessment_type?: 'assignment' | 'test' | 'treatise' | 'thesis';
    level?: 'primary_school' | 'high_school' | 'undergraduate' | 'postgraduate';
    provider?: 'openai' | 'anthropic';
    strictness_level?: 'very_strict' | 'strict' | 'moderate' | 'lenient';
    mark_as_image?: boolean;
  }) => api.post('/mark/single', data),

  markMultiple: (data: {
    assignment_ids: number[];
    rubric_id: number;
    student_names?: (string | null)[];
    output_type?: 'annotate' | 'report';
    assessment_type?: 'assignment' | 'test' | 'treatise' | 'thesis';
    level?: 'primary_school' | 'high_school' | 'undergraduate' | 'postgraduate';
    provider?: 'openai' | 'anthropic';
    strictness_level?: 'very_strict' | 'strict' | 'moderate' | 'lenient';
    mark_as_image?: boolean;
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
  createBatch: (data: { name: string; description?: string }) => api.post('/batches', data),
  updateBatch: (id: number, data: { name: string; description?: string }) => api.put(`/batches/${id}`, data),
  deleteBatch: (id: number) => api.delete(`/batches/${id}`),
  assignToBatch: (id: number, assignment_ids: number[]) => api.post(`/batches/${id}/assign`, { assignment_ids }),
  unassignFromBatch: (id: number, assignment_ids: number[]) => api.post(`/batches/${id}/unassign`, { assignment_ids }),
  scheduleMarking: (id: number, data: { rubric_id: number; scheduled_for?: string }) =>
    api.post(`/batches/${id}/schedule-marking`, data),
  getAllJobs: () => api.get('/batches/jobs/all'),
  getJobsHealth: () => api.get<BatchJobsHealthResponse>('/batches/jobs/health'),
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
  created_at: string;
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
  }) => api.post('/assessments/generate', data),
  getStats: () => api.get('/assessments/stats'),
  publish: (data: { assessment: GeneratedAssessment; rubric_id: number }) =>
    api.post('/assessments/publish', data),
  getByCode: (code: string) => api.get(`/assessments/take/${code}`),
  submit: (data: { code: string; student_name: string; answers: { question_number: number; value: string }[] }) =>
    api.post('/assessments/submit', data),
  getSubmissionStatus: (submissionCode: string) => api.get(`/assessments/submission-status/${submissionCode}`),
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
  visuals?: ContentVisual[];
}
export interface ContentVisual {
  kind: 'image' | 'illustration';
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
  template_id?: string;
  template_name?: string;
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
  content: GeneratedContent;
  input?: any;
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
export interface ContentPlannerJob {
  id: number;
  topics: string;
  level?: string | null;
  num_sections: number;
  template_id?: string | null;
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
  }) => api.post('/content/generate', data),
  publish: (data: { content: GeneratedContent; rubric_id?: number; include_video?: boolean }) =>
    api.post('/content/publish', data),
  getMy: () => api.get('/content/my'),
  deleteMy: (id: number) => api.delete(`/content/my/${id}`),
  getByCode: (code: string) => api.get(`/content/take/${code}`),
  submitQuiz: (data: { code: string; student_name: string; answers: { question_number: number; value: string }[] }) =>
    api.post('/content/submit-quiz', data),
  getVideoStatus: (code: string) => api.get(`/content/video-status/${code}`),
  getVideoContent: (code: string) => api.get(`/content/video/${code}/content`, { responseType: 'blob' }),
  exportPptx: (content: GeneratedContent) =>
    api.post('/content/export/pptx', { content }, { responseType: 'blob' }),
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
  }) => api.post('/content/planner/schedule', data),
  getPlannerJobs: () => api.get<{ success: boolean; jobs: ContentPlannerJob[] }>('/content/planner/jobs'),
  cancelPlannerJob: (id: number) => api.post(`/content/planner/${id}/cancel`),
  saveHistory: (data: { content: GeneratedContent; input?: any }) =>
    api.post<{ success: boolean; item: ContentHistoryItem }>('/content/history', data),
  getHistory: () => api.get<{ success: boolean; items: ContentHistoryItem[] }>('/content/history'),
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

export default api;
