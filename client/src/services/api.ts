import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for logging
api.interceptors.request.use(
  (config) => {
    console.log(`Making ${config.method?.toUpperCase()} request to ${config.url}`);
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
  created_at: string;
}

export interface MarkingScore {
  criterion_name: string;
  points_awarded: number;
  max_points: number;
  feedback: string;
  confidence?: number; // 0-100 confidence level for this criterion
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
  }) => api.post('/mark/multiple', data),

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
  }) => api.post('/rubric-generator/save', data),
};

export default api;
