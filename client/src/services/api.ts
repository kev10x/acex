import axios from 'axios';

// Use /tools/api in production when app is at /tools, or localhost for development.
// Must match server API path so feedback-video and other /results routes resolve correctly.
const API_BASE_URL = process.env.REACT_APP_API_URL ||
  (process.env.NODE_ENV === 'production' ? '/tools/api' : 'http://localhost:3001/api');

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
  status: 'scheduled' | 'running' | 'completed' | 'completed_with_errors' | 'failed';
  scheduled_for?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  total_count: number;
  processed_count: number;
  success_count: number;
  failed_count: number;
  last_error?: string | null;
  created_at: string;
  batch_name?: string;
  rubric_name?: string;
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
  custom_feedback?: string | null;
  override_total_score?: number | null;
  effective_feedback?: string;
  effective_total_score?: number;
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

// Reports API
export const reportsAPI = {
  generatePDF: (resultId: number) => 
    api.get(`/reports/pdf/${resultId}`, { responseType: 'blob' }),
  generateBatchPDF: (resultIds: number[]) => 
    api.post('/reports/pdf/batch', { resultIds }, { responseType: 'blob' }),
  listReports: () => api.get('/reports/list'),
  cleanupReports: (maxAge?: number) => api.post('/reports/cleanup', { maxAge }),
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
  /** Export as Moodle XML (includes answers). Returns blob. */
  exportMoodleXml: (assessment: GeneratedAssessment) =>
    api.post('/assessments/export/moodle-xml', { assessment }, { responseType: 'blob' }),
  /** Export as SCORM 1.2 ZIP (includes answer key). Returns blob. */
  exportScorm: (assessment: GeneratedAssessment) =>
    api.post('/assessments/export/scorm', { assessment }, { responseType: 'blob' }),
  /** List current user's published assessments (for reusability). */
  getPublished: () => api.get('/assessments/published'),
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
}
export const contentAPI = {
  generate: (data: {
    topics: string;
    level?: string;
    num_sections?: number;
    rubric_id?: number;
    rubric_context?: string;
  }) => api.post('/content/generate', data),
  publish: (data: { content: GeneratedContent; rubric_id?: number; include_video?: boolean }) =>
    api.post('/content/publish', data),
  getMy: () => api.get('/content/my'),
  getByCode: (code: string) => api.get(`/content/take/${code}`),
  submitQuiz: (data: { code: string; student_name: string; answers: { question_number: number; value: string }[] }) =>
    api.post('/content/submit-quiz', data),
  getVideoStatus: (code: string) => api.get(`/content/video-status/${code}`),
  exportPptx: (content: GeneratedContent) =>
    api.post('/content/export/pptx', { content }, { responseType: 'blob' }),
  exportLectureNotes: (content: GeneratedContent) =>
    api.post('/content/export/lecture-notes', { content }, { responseType: 'blob' }),
  uploadTemplate: (file: File) => {
    const form = new FormData();
    form.append('template', file);
    return api.post('/content/template', form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
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
    features: { generate_assessments?: boolean; download_results?: boolean; feedback_video?: boolean }
  ) => {
    const response = await api.put(`/auth/admin/users/${userId}/features`, { features }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  }
};

export default api;
