import axios from 'axios';

// Use /tools/api in production, or localhost for development
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
  corrections?: Correction[]; // Array of corrections and suggestions with location information
  language_errors?: LanguageError[]; // Array of grammar, spelling, and reference errors
}

// Upload API
export const uploadAPI = {
  uploadSingle: (file: File) => {
    const formData = new FormData();
    formData.append('pdf', file);
    return api.post('/upload/single', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },

  uploadMultiple: (files: File[]) => {
    const formData = new FormData();
    files.forEach((file) => {
      formData.append('pdfs', file);
    });
    return api.post('/upload/multiple', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },

  getAssignments: () => api.get('/upload'),
  deleteAssignment: (id: number) => api.delete(`/upload/${id}`),
  
  uploadZip: (file: File) => {
    const formData = new FormData();
    formData.append('zip', file);
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
    rubric_type?: 'auto' | 'rubric' | 'answer_key';
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
};

// Assessments API
export interface AssessmentQuestion {
  number: number;
  type: 'essay' | 'multiple_choice' | 'short_answer' | 'problem';
  question: string;
  points: number;
  hints?: string[];
  related_criteria?: string[]; // Rubric criteria this question assesses
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
    rubric_id: number; // Required: rubric to base assessment on
    difficulty_level?: 'beginner' | 'moderate' | 'advanced';
    question_count?: number;
    assessment_type?: 'assignment' | 'exam' | 'quiz' | 'essay';
    use_existing_patterns?: boolean;
    topic?: string | null; // Optional: specific topic/subject area
  }) => api.post('/assessments/generate', data),
  getStats: () => api.get('/assessments/stats'),
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
    return response.data.users;
  },
  
  getAllUsers: async (token: string) => {
    const response = await api.get('/auth/admin/users', {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data.users;
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
  
  updateUserRole: async (token: string, userId: number, role: 'admin' | 'user') => {
    const response = await api.put(`/auth/admin/users/${userId}/role`, { role }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  }
};

export default api;
