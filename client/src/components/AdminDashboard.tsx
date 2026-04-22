import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  assessmentsAPI,
  authAPI,
  batchesAPI,
  BatchJobsHealthResponse,
  CustomHomeworkTelemetryResponse,
  Department,
  FeatureFlags,
  GenerationJobDeadLettersResponse,
  GenerationJobsResponse,
  GenerationTelemetryResponse,
  ManagementPerformanceResponse,
  modulesAPI,
  Organisation,
  PromptRegistryResponse,
  resultsAPI,
  SubmissionIdentityConflictItem,
  SubmissionIdentityConflictResponse,
  SubmissionIdentityHealthResponse,
  systemAPI,
  SystemHealthResponse
} from '../services/api';
import { CheckCircle, XCircle, User, Mail, Clock, AlertCircle, Lock, Unlock, Trash2, Sparkles, Download, Video, BarChart3, TrendingUp } from 'lucide-react';

export interface UserFeatures {
  assessment_creation?: boolean;
  content_creation?: boolean;
  download_results?: boolean;
  feedback_video?: boolean;
}

type FeatureKey = keyof UserFeatures;
type FeatureDefinition = {
  key: FeatureKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const FEATURE_DEFINITIONS: FeatureDefinition[] = [
  { key: 'assessment_creation', label: 'Assessment creation', icon: Sparkles },
  { key: 'content_creation', label: 'Content creation', icon: BarChart3 },
  { key: 'download_results', label: 'Download results', icon: Download },
  { key: 'feedback_video', label: 'Video explaining feedback', icon: Video }
];

const isFeatureAllowed = (value?: boolean) => value !== false;
const getEffectiveFeatureValue = (userFeatures: UserFeatures | undefined, organisationFeatures: UserFeatures | undefined, key: FeatureKey) =>
  isFeatureAllowed(userFeatures?.[key]) && isFeatureAllowed(organisationFeatures?.[key]);

interface UserData {
  id: number;
  email: string;
  name: string | null;
  created_at: string;
  last_login?: string;
  email_verified: boolean;
  is_approved: boolean;
  role: string;
  is_active?: boolean;
  features?: UserFeatures;
  organisation_id?: number | null;
  organisation_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
}
type UserRole = 'management' | 'lecturer' | 'student';
const normalizeRole = (role?: string): UserRole => {
  const r = String(role || '').toLowerCase();
  if (r === 'admin') return 'management';
  if (r === 'student' || r === 'management' || r === 'lecturer') return r;
  return 'lecturer';
};

const AdminDashboard: React.FC = () => {
  const { token, user, impersonateUser } = useAuth();
  const [pendingUsers, setPendingUsers] = useState<UserData[]>([]);
  const [allUsers, setAllUsers] = useState<UserData[]>([]);
  const [activeTab, setActiveTab] = useState<'pending' | 'all' | 'performance' | 'system'>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [organisations, setOrganisations] = useState<Organisation[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [newOrganisationName, setNewOrganisationName] = useState('');
  const [newDepartmentName, setNewDepartmentName] = useState('');
  const [newDepartmentOrganisationId, setNewDepartmentOrganisationId] = useState<number | ''>('');
  const [systemHealth, setSystemHealth] = useState<SystemHealthResponse | null>(null);
  const [performance, setPerformance] = useState<ManagementPerformanceResponse | null>(null);
  const [batchJobsHealth, setBatchJobsHealth] = useState<BatchJobsHealthResponse | null>(null);
  const [submissionIdentityHealth, setSubmissionIdentityHealth] = useState<SubmissionIdentityHealthResponse | null>(null);
  const [submissionIdentityConflicts, setSubmissionIdentityConflicts] = useState<SubmissionIdentityConflictResponse | null>(null);
  const [customHomeworkTelemetry, setCustomHomeworkTelemetry] = useState<CustomHomeworkTelemetryResponse | null>(null);
  const [generationTelemetry, setGenerationTelemetry] = useState<GenerationTelemetryResponse | null>(null);
  const [generationJobs, setGenerationJobs] = useState<GenerationJobsResponse | null>(null);
  const [generationJobDeadLetters, setGenerationJobDeadLetters] = useState<GenerationJobDeadLettersResponse | null>(null);
  const [promptRegistry, setPromptRegistry] = useState<PromptRegistryResponse | null>(null);
  const [retryingGenerationJobId, setRetryingGenerationJobId] = useState<number | null>(null);
  const [identityBackfillBusy, setIdentityBackfillBusy] = useState(false);
  const [identityResolveBusy, setIdentityResolveBusy] = useState<number | null>(null);
  const [identityResolutionSelection, setIdentityResolutionSelection] = useState<Record<number, number>>({});
  const [showPolicyAffectedOnly, setShowPolicyAffectedOnly] = useState(false);

  useEffect(() => {
    console.log('AdminDashboard useEffect triggered:', { 
      hasToken: !!token, 
      hasUser: !!user, 
      userRole: user?.role,
      userEmail: user?.email 
    });
    
    if (token && user) {
      if (normalizeRole(user.role) === 'management') {
        console.log('User is admin, calling loadUsers...');
        loadUsers();
      } else {
        // If user is logged in but not admin, set loading to false
        console.log('User is not admin, role:', user.role);
        setLoading(false);
      }
    } else {
      // If no user or token, set loading to false
      console.log('No token or user, setting loading to false');
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user]);

  useEffect(() => {
    if (!submissionIdentityConflicts?.items) return;
    setIdentityResolutionSelection((prev) => {
      const next = { ...prev };
      submissionIdentityConflicts.items.forEach((item) => {
        if (!next[item.id] && item.candidates.length > 0) {
          next[item.id] = item.candidates[0].id;
        }
      });
      return next;
    });
  }, [submissionIdentityConflicts]);

  const loadUsers = async () => {
    if (!token) {
      console.error('No token available for loadUsers');
      setError('No authentication token');
      setLoading(false);
      return;
    }
    
    console.log('loadUsers called, token exists:', !!token);
    setLoading(true);
    setError(null);
    try {
      console.log('Fetching pending users and all users...');
      const [pending, all, orgs, depts, health, performanceData, jobsHealth, identityHealth, identityConflicts, homeworkTelemetry, allGenerationTelemetry, generationJobsRes, generationDeadLettersRes, promptRegistryRes] = await Promise.all([
        authAPI.getPendingUsers(token),
        authAPI.getAllUsers(token),
        authAPI.getOrganisations(token),
        authAPI.getDepartments(token),
        systemAPI.getHealth().catch(() => null),
        resultsAPI.getManagementPerformance().catch(() => null),
        batchesAPI.getJobsHealth().catch(() => null),
        assessmentsAPI.getSubmissionIdentityHealth().catch(() => null),
        assessmentsAPI.getSubmissionIdentityConflicts().catch(() => null),
        modulesAPI.getCustomHomeworkTelemetry().catch(() => null),
        modulesAPI.getGenerationTelemetry().catch(() => null),
        modulesAPI.getGenerationJobs({ limit: 25, scope: 'all' }).catch(() => null),
        modulesAPI.getGenerationJobDeadLetters({ limit: 25 }).catch(() => null),
        modulesAPI.getPromptRegistry({ scope: 'all', limit: 30 }).catch(() => null),
      ]);
      console.log('Users loaded successfully:', { 
        pendingCount: pending?.length || 0, 
        allCount: all?.length || 0,
        pending: pending,
        all: all
      });
      setPendingUsers(Array.isArray(pending) ? pending : []);
      setAllUsers(Array.isArray(all) ? all : []);
      setOrganisations(Array.isArray(orgs) ? orgs : []);
      setDepartments(Array.isArray(depts) ? depts : []);
      setSystemHealth(health?.data || null);
      setPerformance(performanceData?.data || null);
      setBatchJobsHealth(jobsHealth?.data || null);
      setSubmissionIdentityHealth(identityHealth?.data || null);
      setSubmissionIdentityConflicts(identityConflicts?.data || null);
      setCustomHomeworkTelemetry(homeworkTelemetry?.data || null);
      setGenerationTelemetry(allGenerationTelemetry?.data || null);
      setGenerationJobs(generationJobsRes?.data || null);
      setGenerationJobDeadLetters(generationDeadLettersRes?.data || null);
      setPromptRegistry(promptRegistryRes?.data || null);
    } catch (err: any) {
      console.error('Error loading users:', err);
      const errorMessage = err.response?.data?.error || err.message || 'Failed to load users';
      setError(errorMessage);
      console.error('Error details:', {
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
        message: err.message
      });
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (userId: number) => {
    if (!token) return;
    
    setActionLoading(userId);
    try {
      await authAPI.approveUser(token, userId);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to approve user');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (userId: number, deactivate: boolean = false) => {
    if (!token) return;
    
    if (!window.confirm(`Are you sure you want to ${deactivate ? 'reject and deactivate' : 'reject'} this user?`)) {
      return;
    }
    
    setActionLoading(userId);
    try {
      await authAPI.rejectUser(token, userId, deactivate);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to reject user');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRoleChange = async (userId: number, newRole: UserRole) => {
    if (!token) return;
    
    if (newRole !== 'management' && !window.confirm('Are you sure you want to remove management privileges from this user?')) {
      return;
    }
    
    setActionLoading(userId);
    try {
      await authAPI.updateUserRole(token, userId, newRole);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update user role');
    } finally {
      setActionLoading(null);
    }
  };

  const handleLock = async (userId: number, currentlyLocked: boolean) => {
    if (!token) return;
    setActionLoading(userId);
    try {
      await authAPI.lockUser(token, userId, !currentlyLocked);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update lock status');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (userId: number, userName: string) => {
    if (!token) return;
    if (!window.confirm(`Permanently delete user "${userName}"? This cannot be undone.`)) return;
    setActionLoading(userId);
    try {
      await authAPI.deleteUser(token, userId);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to delete user');
    } finally {
      setActionLoading(null);
    }
  };

  const handleImpersonate = async (userId: number) => {
    setActionLoading(userId);
    try {
      await impersonateUser(userId);
    } catch (err: any) {
      alert(err.response?.data?.error || err.message || 'Failed to impersonate user');
    } finally {
      setActionLoading(null);
    }
  };

  const handleFeaturesChange = async (userId: number, field: 'assessment_creation' | 'content_creation' | 'download_results' | 'feedback_video', value: boolean) => {
    if (!token) return;
    const userData = allUsers.find((u) => u.id === userId);
    if (!userData) return;
    const current = userData.features || {};
    setActionLoading(userId);
    try {
      await authAPI.updateUserFeatures(token, userId, {
        assessment_creation: field === 'assessment_creation' ? value : (current.assessment_creation !== false),
        content_creation: field === 'content_creation' ? value : (current.content_creation !== false),
        download_results: field === 'download_results' ? value : (current.download_results !== false),
        feedback_video: field === 'feedback_video' ? value : (current.feedback_video !== false)
      });
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update features');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateOrganisation = async () => {
    if (!token) return;
    const name = newOrganisationName.trim();
    if (!name) return;
    setActionLoading(-1);
    try {
      await authAPI.createOrganisation(token, name);
      setNewOrganisationName('');
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to create organisation');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateDepartment = async () => {
    if (!token) return;
    if (!isSuperAdmin && !user?.organisation_id) return;
    const name = newDepartmentName.trim();
    if (!name) return;
    setActionLoading(-2);
    try {
      await authAPI.createDepartment(
        token,
        name,
        newDepartmentOrganisationId === '' ? undefined : Number(newDepartmentOrganisationId)
      );
      setNewDepartmentName('');
      if (user?.organisation_id != null && !isSuperAdmin) {
        setNewDepartmentOrganisationId(user.organisation_id);
      } else {
        setNewDepartmentOrganisationId('');
      }
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to create department');
    } finally {
      setActionLoading(null);
    }
  };

  const handleOrganisationFeatureChange = async (
    organisationId: number,
    field: keyof FeatureFlags,
    value: boolean
  ) => {
    if (!token) return;
    const organisation = organisations.find((item) => item.id === organisationId);
    if (!organisation) return;
    const current = organisation.features || {};
    const nextFeatures: FeatureFlags = {
      assessment_creation: field === 'assessment_creation' ? value : current.assessment_creation !== false,
      content_creation: field === 'content_creation' ? value : current.content_creation !== false,
      download_results: field === 'download_results' ? value : current.download_results !== false,
      feedback_video: field === 'feedback_video' ? value : current.feedback_video !== false
    };
    setActionLoading(1000000 + organisationId);
    try {
      await authAPI.updateOrganisationFeatures(token, organisationId, nextFeatures);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update organisation features');
    } finally {
      setActionLoading(null);
    }
  };

  const handleOrganisationChange = async (userId: number, organisationId: number | null) => {
    if (!token) return;
    setActionLoading(userId);
    try {
      await authAPI.updateUserOrganisation(token, userId, organisationId);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to assign organisation');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDepartmentChange = async (userId: number, departmentId: number | null) => {
    if (!token) return;
    setActionLoading(userId);
    try {
      await authAPI.updateUserDepartment(token, userId, departmentId);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to assign department');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRunIdentityBackfill = async () => {
    if (!token || identityBackfillBusy) return;
    setIdentityBackfillBusy(true);
    try {
      const result = await assessmentsAPI.runSubmissionIdentityBackfill();
      const updated = Number(result?.data?.updated_submissions || 0);
      alert(`Submission identity backfill complete. Updated ${updated} submission${updated === 1 ? '' : 's'}.`);
      const refreshed = await assessmentsAPI.getSubmissionIdentityHealth().catch(() => null);
      setSubmissionIdentityHealth(refreshed?.data || null);
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to run submission identity backfill');
    } finally {
      setIdentityBackfillBusy(false);
    }
  };

  const handleResolveIdentityConflict = async (item: SubmissionIdentityConflictItem) => {
    if (!token) return;
    const selectedStudentId = identityResolutionSelection[item.id];
    if (!selectedStudentId) {
      alert('Select a student before resolving this conflict.');
      return;
    }
    setIdentityResolveBusy(item.id);
    try {
      await assessmentsAPI.resolveSubmissionIdentityConflict(item.id, selectedStudentId);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to resolve submission identity conflict');
    } finally {
      setIdentityResolveBusy(null);
    }
  };

  const handleRetryGenerationJob = async (jobId: number) => {
    setRetryingGenerationJobId(jobId);
    try {
      await modulesAPI.retryGenerationJob(jobId);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to retry generation job');
    } finally {
      setRetryingGenerationJobId(null);
    }
  };

  // Show loading if user data is still being fetched
  if (!user) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading user information...</p>
        </div>
      </div>
    );
  }

  if (!user.role) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center">
            <AlertCircle className="h-5 w-5 text-yellow-600 mr-2" />
            <div>
              <p className="text-yellow-800">User role not loaded. Please refresh the page.</p>
              <p className="text-yellow-600 text-sm mt-2">User ID: {user.id}, Email: {user.email}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (normalizeRole(user.role) !== 'management') {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center">
            <AlertCircle className="h-5 w-5 text-red-600 mr-2" />
            <div>
              <p className="text-red-800">Access denied. Admin privileges required.</p>
              <p className="text-red-600 text-sm mt-2">Your role: {user.role || 'not set'}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isSuperAdmin = user.email?.toLowerCase() === 'kkativu@gmail.com';
  const defaultDepartmentOrgId =
    newDepartmentOrganisationId === ''
      ? (isSuperAdmin ? null : user.organisation_id ?? null)
      : Number(newDepartmentOrganisationId);
  const currentDepartmentChoices = defaultDepartmentOrgId == null
    ? []
    : departments.filter((department) => Number(department.organisation_id) === Number(defaultDepartmentOrgId));
  const topLecturers = performance?.lecturer_performance?.slice(0, 8) || [];
  const topStudents = performance?.student_performance?.slice(0, 10) || [];
  const filteredUsers = allUsers.filter((userData) => {
    if (!showPolicyAffectedOnly) return true;
    const organisationFeatures = organisations.find((org) => org.id === userData.organisation_id)?.features || {};
    return FEATURE_DEFINITIONS.some(({ key }) => {
      const userAllowed = isFeatureAllowed(userData.features?.[key]);
      const effectiveAllowed = getEffectiveFeatureValue(userData.features, organisationFeatures, key);
      return userAllowed !== effectiveAllowed;
    });
  });

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Admin Dashboard</h1>
        <p className="text-gray-600">Manage user registrations and permissions</p>
        {/* Debug info - remove in production */}
        {import.meta.env.DEV && (
          <div className="mt-2 text-xs text-gray-500">
            Debug: Loading={loading.toString()}, Error={error || 'none'}, 
            Pending={pendingUsers.length}, All={allUsers.length}, 
            Role={user?.role || 'none'}
          </div>
        )}
      </div>

      <div className="mb-6 bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-800 mb-1">Organisation and department management</h3>
          <p className="text-xs text-gray-600">
            {isSuperAdmin
              ? 'The super admin can create organisations and departments across the platform.'
              : 'Organisation admins can create departments inside their own organisation.'}
          </p>
        </div>

        {isSuperAdmin && (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">Create organisation</label>
            <div className="flex flex-col md:flex-row gap-2">
              <input
                type="text"
                value={newOrganisationName}
                onChange={(e) => setNewOrganisationName(e.target.value)}
                placeholder="Add organisation name"
                className="w-full md:w-80 border border-gray-300 rounded-md px-3 py-2 text-sm"
              />
              <button
                onClick={handleCreateOrganisation}
                disabled={actionLoading === -1 || !newOrganisationName.trim()}
                className="px-3 py-2 text-sm rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {actionLoading === -1 ? 'Adding...' : 'Add organisation'}
              </button>
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">Create department</label>
          <div className="flex flex-col lg:flex-row gap-2">
            <input
              type="text"
              value={newDepartmentName}
              onChange={(e) => setNewDepartmentName(e.target.value)}
              placeholder="Add department name"
              className="w-full lg:w-80 border border-gray-300 rounded-md px-3 py-2 text-sm"
            />
            {isSuperAdmin ? (
              <select
                value={newDepartmentOrganisationId}
                onChange={(e) => setNewDepartmentOrganisationId(e.target.value ? Number(e.target.value) : '')}
                className="w-full lg:w-64 border border-gray-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">Select organisation</option>
                {organisations.map((organisation) => (
                  <option key={organisation.id} value={organisation.id}>
                    {organisation.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="w-full lg:w-64 border border-gray-200 bg-white rounded-md px-3 py-2 text-sm text-gray-700">
                {user.organisation_name || 'No organisation assigned'}
              </div>
            )}
            <button
              onClick={handleCreateDepartment}
              disabled={
                actionLoading === -2 ||
                !newDepartmentName.trim() ||
                (isSuperAdmin && defaultDepartmentOrgId == null) ||
                (!isSuperAdmin && !user.organisation_id)
              }
              className="px-3 py-2 text-sm rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {actionLoading === -2 ? 'Adding...' : 'Add department'}
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-2">
            {isSuperAdmin
              ? `Total organisations: ${organisations.length}. Total departments: ${departments.length}.`
              : `Departments in your organisation: ${departments.length}.`}
          </p>
          {!isSuperAdmin && !user.organisation_id && (
            <p className="text-xs text-amber-700 mt-2">Assign this admin to an organisation before creating departments.</p>
          )}
          {currentDepartmentChoices.length > 0 && (
            <p className="text-xs text-gray-500 mt-1">
              Existing departments: {currentDepartmentChoices.map((department) => department.name).join(', ')}
            </p>
          )}
        </div>

        {isSuperAdmin && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-medium text-gray-700">Organisation management</label>
              <span className="text-xs text-gray-500">Organisation-level settings override user-level access.</span>
            </div>
            <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Organisation</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Assessment Creation</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Content Creation</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Result Downloads</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Feedback Video</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {organisations.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No organisations available yet.</td>
                    </tr>
                  ) : organisations.map((organisation) => {
                    const organisationFeatures = organisation.features || {};
                    const rowLoading = actionLoading === 1000000 + organisation.id;
                    return (
                      <tr key={organisation.id}>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">{organisation.name}</td>
                        <td className="px-4 py-3">
                          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                            <input
                              type="checkbox"
                              checked={organisationFeatures.assessment_creation !== false}
                              onChange={(e) => handleOrganisationFeatureChange(organisation.id, 'assessment_creation', e.target.checked)}
                              disabled={rowLoading}
                              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            />
                            Enabled
                          </label>
                        </td>
                        <td className="px-4 py-3">
                          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                            <input
                              type="checkbox"
                              checked={organisationFeatures.content_creation !== false}
                              onChange={(e) => handleOrganisationFeatureChange(organisation.id, 'content_creation', e.target.checked)}
                              disabled={rowLoading}
                              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            />
                            Enabled
                          </label>
                        </td>
                        <td className="px-4 py-3">
                          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                            <input
                              type="checkbox"
                              checked={organisationFeatures.download_results !== false}
                              onChange={(e) => handleOrganisationFeatureChange(organisation.id, 'download_results', e.target.checked)}
                              disabled={rowLoading}
                              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            />
                            Enabled
                          </label>
                        </td>
                        <td className="px-4 py-3">
                          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                            <input
                              type="checkbox"
                              checked={organisationFeatures.feedback_video !== false}
                              onChange={(e) => handleOrganisationFeatureChange(organisation.id, 'feedback_video', e.target.checked)}
                              disabled={rowLoading}
                              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            />
                            Enabled
                          </label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab('pending')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'pending'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Pending Approvals ({pendingUsers.length})
          </button>
          <button
            onClick={() => setActiveTab('all')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'all'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            All Users ({filteredUsers.length})
          </button>
          <button
            onClick={() => setActiveTab('performance')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'performance'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Performance
          </button>
          <button
            onClick={() => setActiveTab('system')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'system'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            System Health
          </button>
        </nav>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center">
            <AlertCircle className="h-5 w-5 text-red-600 mr-2" />
            <div className="flex-1">
              <p className="text-red-800 font-medium">Error loading users</p>
              <p className="text-red-600 text-sm mt-1">{error}</p>
            </div>
            <button
              onClick={loadUsers}
              className="ml-4 px-4 py-2 text-sm font-medium text-red-700 bg-red-100 hover:bg-red-200 rounded-md transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading users...</p>
        </div>
      ) : activeTab === 'performance' ? (
        <div className="space-y-6">
          {!performance ? (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-yellow-800">Performance analytics are unavailable right now.</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
                <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-600">Marked Scripts</span>
                    <BarChart3 className="h-4 w-4 text-blue-500" />
                  </div>
                  <div className="text-2xl font-bold text-gray-900 mt-2">{performance.summary.total_results}</div>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-600">Lecturers Active</span>
                    <User className="h-4 w-4 text-emerald-500" />
                  </div>
                  <div className="text-2xl font-bold text-gray-900 mt-2">{performance.summary.lecturer_count}</div>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-600">Students Tracked</span>
                    <User className="h-4 w-4 text-violet-500" />
                  </div>
                  <div className="text-2xl font-bold text-gray-900 mt-2">{performance.summary.student_count}</div>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-600">Average %</span>
                    <TrendingUp className="h-4 w-4 text-amber-500" />
                  </div>
                  <div className="text-2xl font-bold text-gray-900 mt-2">{performance.summary.average_percentage.toFixed(1)}%</div>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-600">Queued for Review</span>
                    <AlertCircle className="h-4 w-4 text-rose-500" />
                  </div>
                  <div className="text-2xl font-bold text-gray-900 mt-2">{performance.summary.reviewed_or_flagged_results}</div>
                </div>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">Submission Identity Health</h3>
                    <p className="text-xs text-gray-500 mt-1">Tracks how many assessment submissions are linked to canonical student users.</p>
                  </div>
                  <button
                    onClick={handleRunIdentityBackfill}
                    disabled={identityBackfillBusy}
                    className="px-3 py-2 text-sm rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
                  >
                    {identityBackfillBusy ? 'Running...' : 'Run Backfill'}
                  </button>
                </div>

                {!submissionIdentityHealth ? (
                  <div className="mt-3 text-sm text-gray-600">Identity health metrics are unavailable right now.</div>
                ) : (
                  <>
                    <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div className="rounded border border-gray-200 p-3">
                        <div className="text-xs text-gray-500">Total submissions</div>
                        <div className="text-xl font-semibold text-gray-900 mt-1">{submissionIdentityHealth.summary.total_submissions}</div>
                      </div>
                      <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
                        <div className="text-xs text-emerald-700">Resolved</div>
                        <div className="text-xl font-semibold text-emerald-900 mt-1">{submissionIdentityHealth.summary.resolved_submissions}</div>
                      </div>
                      <div className="rounded border border-amber-200 bg-amber-50 p-3">
                        <div className="text-xs text-amber-700">Unresolved</div>
                        <div className="text-xl font-semibold text-amber-900 mt-1">{submissionIdentityHealth.summary.unresolved_submissions}</div>
                      </div>
                      <div className="rounded border border-blue-200 bg-blue-50 p-3">
                        <div className="text-xs text-blue-700">Potential backfill matches</div>
                        <div className="text-xl font-semibold text-blue-900 mt-1">{submissionIdentityHealth.summary.potential_backfill_matches}</div>
                      </div>
                    </div>

                    <div className="mt-4 overflow-x-auto border border-gray-200 rounded-lg">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Submission</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Student Name</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Potential Match</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Submitted</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {submissionIdentityHealth.unresolved_samples.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No unresolved submissions in this scope.</td>
                            </tr>
                          ) : submissionIdentityHealth.unresolved_samples.map((sample) => (
                            <tr key={sample.id}>
                              <td className="px-4 py-3 text-sm text-gray-700">{sample.submission_code}</td>
                              <td className="px-4 py-3 text-sm text-gray-700">{sample.student_name}</td>
                              <td className="px-4 py-3 text-sm text-gray-700">{sample.status}</td>
                              <td className="px-4 py-3 text-sm">
                                <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${sample.potential_match ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                                  {sample.potential_match ? 'Yes' : 'No'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-700">
                                {sample.submitted_at ? new Date(sample.submitted_at).toLocaleDateString() : 'Unknown'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-4">
                      <div className="flex items-center justify-between gap-4 mb-2">
                        <h4 className="text-sm font-semibold text-gray-900">Unresolved Identity Conflict Queue</h4>
                        {submissionIdentityConflicts?.summary && (
                          <div className="text-xs text-gray-600">
                            Single-candidate: {submissionIdentityConflicts.summary.single_candidate_submissions} | Multi-candidate: {submissionIdentityConflicts.summary.multi_candidate_submissions} | No-candidate: {submissionIdentityConflicts.summary.no_candidate_submissions}
                          </div>
                        )}
                      </div>
                      {!submissionIdentityConflicts ? (
                        <div className="text-sm text-gray-600">Conflict queue is unavailable right now.</div>
                      ) : (
                        <div className="overflow-x-auto border border-gray-200 rounded-lg">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Submission</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Student Name</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Candidates</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Assign To</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {submissionIdentityConflicts.items.length === 0 ? (
                                <tr>
                                  <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No unresolved identity conflicts.</td>
                                </tr>
                              ) : submissionIdentityConflicts.items.map((item) => (
                                <tr key={item.id}>
                                  <td className="px-4 py-3 text-sm text-gray-700">
                                    <div>{item.submission_code}</div>
                                    <div className="text-xs text-gray-500">{item.assessment_code}</div>
                                  </td>
                                  <td className="px-4 py-3 text-sm text-gray-700">{item.student_name}</td>
                                  <td className="px-4 py-3 text-sm text-gray-700">
                                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${item.candidate_count > 1 ? 'bg-amber-100 text-amber-800' : item.candidate_count === 1 ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-700'}`}>
                                      {item.candidate_count}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-sm text-gray-700 min-w-[260px]">
                                    <select
                                      value={identityResolutionSelection[item.id] || ''}
                                      onChange={(event) => setIdentityResolutionSelection((prev) => ({
                                        ...prev,
                                        [item.id]: Number(event.target.value)
                                      }))}
                                      className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                                      disabled={item.candidates.length === 0}
                                    >
                                      {item.candidates.length === 0 ? (
                                        <option value="">No candidates</option>
                                      ) : item.candidates.map((candidate) => (
                                        <option key={candidate.id} value={candidate.id}>
                                          {candidate.name} ({candidate.match_reason})
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="px-4 py-3 text-sm text-gray-700">
                                    <button
                                      onClick={() => handleResolveIdentityConflict(item)}
                                      disabled={item.candidates.length === 0 || identityResolveBusy === item.id}
                                      className="px-3 py-1.5 rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
                                    >
                                      {identityResolveBusy === item.id ? 'Resolving...' : 'Resolve'}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-200">
                    <h3 className="text-sm font-semibold text-gray-900">Lecturer Performance</h3>
                    <p className="text-xs text-gray-500 mt-1">Per-marker volume, average attainment, and review load.</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Lecturer</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Scripts</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Average %</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Review Queue</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Activity</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {topLecturers.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No lecturer performance data yet.</td>
                          </tr>
                        ) : topLecturers.map((lecturer) => (
                          <tr key={lecturer.lecturer_id}>
                            <td className="px-4 py-3">
                              <div className="text-sm font-medium text-gray-900">{lecturer.lecturer_name}</div>
                              <div className="text-xs text-gray-500">{lecturer.lecturer_email}</div>
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-700">
                              <div>{lecturer.total_results}</div>
                              <div className="text-xs text-gray-500">{lecturer.assignments_marked} assignments</div>
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-700">{lecturer.average_percentage.toFixed(1)}%</td>
                            <td className="px-4 py-3 text-sm text-gray-700">{lecturer.review_queue_count}</td>
                            <td className="px-4 py-3 text-sm text-gray-700">
                              {lecturer.last_marked_at ? new Date(lecturer.last_marked_at).toLocaleDateString() : 'No activity'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-200">
                    <h3 className="text-sm font-semibold text-gray-900">Student Performance</h3>
                    <p className="text-xs text-gray-500 mt-1">Per-student attainment across marked scripts in this scope.</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Student</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Scripts</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Average %</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pass Rate</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Range</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {topStudents.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No student performance data yet.</td>
                          </tr>
                        ) : topStudents.map((studentPerf) => (
                          <tr key={studentPerf.student_key}>
                            <td className="px-4 py-3">
                              <div className="text-sm font-medium text-gray-900">{studentPerf.student_name}</div>
                              <div className="text-xs text-gray-500">{studentPerf.lecturers_involved} lecturer(s)</div>
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-700">{studentPerf.total_results}</td>
                            <td className="px-4 py-3 text-sm text-gray-700">{studentPerf.average_percentage.toFixed(1)}%</td>
                            <td className="px-4 py-3 text-sm text-gray-700">{studentPerf.pass_rate.toFixed(0)}%</td>
                            <td className="px-4 py-3 text-sm text-gray-700">
                              {studentPerf.min_percentage.toFixed(0)}% - {studentPerf.max_percentage.toFixed(0)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      ) : activeTab === 'system' ? (
        <div className="space-y-4">
          {!systemHealth ? (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-yellow-800">System health is unavailable right now.</p>
            </div>
          ) : (
            <>
              <div className={`rounded-lg border p-4 ${
                systemHealth.status === 'healthy'
                  ? 'bg-green-50 border-green-200'
                  : systemHealth.status === 'degraded'
                  ? 'bg-yellow-50 border-yellow-200'
                  : 'bg-red-50 border-red-200'
              }`}>
                <h3 className="text-lg font-semibold text-gray-900">Overall Status: {systemHealth.status}</h3>
                {systemHealth.warnings.length > 0 && (
                  <ul className="mt-3 space-y-1 text-sm text-gray-700">
                    {systemHealth.warnings.map((warning) => (
                      <li key={warning}>- {warning}</li>
                    ))}
                  </ul>
                )}
              </div>
              {batchJobsHealth && (
                <div className={`rounded-lg border p-4 ${
                  batchJobsHealth.status === 'healthy'
                    ? 'bg-green-50 border-green-200'
                    : 'bg-yellow-50 border-yellow-200'
                }`}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">Batch Marking Pipeline: {batchJobsHealth.status}</h3>
                      <p className="text-sm text-gray-700 mt-1">
                        Scope: {batchJobsHealth.scope === 'all' ? 'all jobs' : 'your jobs'} | Stuck threshold: {batchJobsHealth.stuck_threshold_minutes} min
                      </p>
                    </div>
                    <div className="text-right text-sm text-gray-700">
                      <div>Running: {batchJobsHealth.summary.running_jobs + batchJobsHealth.summary.submitted_jobs + batchJobsHealth.summary.finalizing_jobs}</div>
                      <div>Retrying: {batchJobsHealth.retrying_jobs.length}</div>
                      <div>Failed: {batchJobsHealth.summary.failed_jobs}</div>
                    </div>
                  </div>
                  {(batchJobsHealth.stuck_jobs.length > 0 || batchJobsHealth.recent_failures.length > 0) && (
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                      <div className="bg-white border border-gray-200 rounded p-3">
                        <div className="font-semibold text-gray-900 mb-1">Stuck Jobs</div>
                        {batchJobsHealth.stuck_jobs.length === 0 ? (
                          <div className="text-gray-600">No stuck jobs detected.</div>
                        ) : (
                          <div className="space-y-1">
                            {batchJobsHealth.stuck_jobs.slice(0, 5).map((job) => (
                              <div key={job.id} className="text-gray-700">
                                Job #{job.id} ({job.batch_name}) - {job.status}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="bg-white border border-gray-200 rounded p-3">
                        <div className="font-semibold text-gray-900 mb-1">Recent Failures</div>
                        {batchJobsHealth.recent_failures.length === 0 ? (
                          <div className="text-gray-600">No recent failed jobs.</div>
                        ) : (
                          <div className="space-y-1">
                            {batchJobsHealth.recent_failures.slice(0, 5).map((job) => (
                              <div key={job.id} className="text-gray-700">
                                Job #{job.id} ({job.batch_name}) retries {job.retry_count ?? 0}/{job.max_retries ?? 0}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {generationTelemetry ? (
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">AI Generation Telemetry</h3>
                      <p className="text-sm text-gray-600 mt-1">Cross-feature reliability and cost view for content, assessment, homework, and video generation.</p>
                    </div>
                    <button
                      onClick={loadUsers}
                      className="px-3 py-2 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
                    >
                      Refresh
                    </button>
                  </div>
                  <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
                    <div className="rounded border border-gray-200 p-3">
                      <div className="text-xs text-gray-500">Total</div>
                      <div className="text-xl font-semibold text-gray-900 mt-1">{generationTelemetry.summary.total_events}</div>
                    </div>
                    <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
                      <div className="text-xs text-emerald-700">Success</div>
                      <div className="text-xl font-semibold text-emerald-900 mt-1">{generationTelemetry.summary.success_events}</div>
                    </div>
                    <div className="rounded border border-rose-200 bg-rose-50 p-3">
                      <div className="text-xs text-rose-700">Errors</div>
                      <div className="text-xl font-semibold text-rose-900 mt-1">{generationTelemetry.summary.error_events}</div>
                    </div>
                    <div className="rounded border border-amber-200 bg-amber-50 p-3">
                      <div className="text-xs text-amber-700">Error Rate</div>
                      <div className="text-xl font-semibold text-amber-900 mt-1">{generationTelemetry.summary.error_rate_percent.toFixed(1)}%</div>
                    </div>
                    <div className="rounded border border-blue-200 bg-blue-50 p-3">
                      <div className="text-xs text-blue-700">Avg Duration</div>
                      <div className="text-xl font-semibold text-blue-900 mt-1">{Math.round(generationTelemetry.summary.average_duration_ms)} ms</div>
                    </div>
                    <div className="rounded border border-violet-200 bg-violet-50 p-3">
                      <div className="text-xs text-violet-700">Estimated Cost</div>
                      <div className="text-xl font-semibold text-violet-900 mt-1">${generationTelemetry.summary.total_estimated_cost_usd.toFixed(4)}</div>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div className="rounded border border-gray-200">
                      <div className="px-4 py-3 border-b border-gray-200">
                        <h4 className="text-sm font-semibold text-gray-900">By Generation Type</h4>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Errors</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Error %</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Cost</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {generationTelemetry.by_type.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No generation telemetry yet.</td>
                              </tr>
                            ) : generationTelemetry.by_type.map((item) => (
                              <tr key={item.generation_type}>
                                <td className="px-4 py-2 text-sm text-gray-700">{item.generation_type}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{item.total_events}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{item.error_events}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{item.error_rate_percent.toFixed(1)}%</td>
                                <td className="px-4 py-2 text-sm text-gray-700">${item.total_estimated_cost_usd.toFixed(4)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div className="rounded border border-gray-200">
                      <div className="px-4 py-3 border-b border-gray-200">
                        <h4 className="text-sm font-semibold text-gray-900">Recent Generation Events</h4>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">When</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Owner</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {generationTelemetry.recent_events.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No generation events yet.</td>
                              </tr>
                            ) : generationTelemetry.recent_events.slice(0, 12).map((eventItem) => (
                              <tr key={eventItem.id}>
                                <td className="px-4 py-2 text-sm text-gray-700">{new Date(eventItem.created_at).toLocaleString()}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{eventItem.generation_type}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{eventItem.status}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{eventItem.duration_ms} ms</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{eventItem.owner.name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-yellow-800">Generation telemetry is unavailable right now.</p>
                </div>
              )}
              {generationJobs ? (
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">Generation Job Timeline</h3>
                      <p className="text-sm text-gray-600 mt-1">State machine timeline across generation jobs (scheduled, processing, completed, failed).</p>
                    </div>
                    <button
                      onClick={loadUsers}
                      className="px-3 py-2 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
                    >
                      Refresh
                    </button>
                  </div>
                  <div className="mt-3 overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">When</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Retries</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Timeline</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {generationJobs.items.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-4 py-6 text-sm text-gray-500 text-center">No generation jobs yet.</td>
                          </tr>
                        ) : generationJobs.items.map((item) => (
                          <tr key={item.id}>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.created_at ? new Date(item.created_at).toLocaleString() : 'n/a'}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.job_type}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.status}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.retry_count}/{item.max_retries}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">
                              {item.timeline.length === 0
                                ? 'n/a'
                                : item.timeline
                                    .map((t) => `${t.status} (${new Date(t.at).toLocaleTimeString()})`)
                                    .join(' -> ')}
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-700">
                              {item.status === 'failed' && item.retry_count < item.max_retries ? (
                                <button
                                  onClick={() => handleRetryGenerationJob(item.id)}
                                  disabled={retryingGenerationJobId === item.id}
                                  className="px-2 py-1 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
                                >
                                  {retryingGenerationJobId === item.id ? 'Retrying...' : 'Retry'}
                                </button>
                              ) : (
                                <span className="text-xs text-gray-500">n/a</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-yellow-800">Generation jobs timeline is unavailable right now.</p>
                </div>
              )}
              {generationJobDeadLetters ? (
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">Generation Dead-Letter Queue</h3>
                      <p className="text-sm text-gray-600 mt-1">Jobs that exhausted retries and require manual intervention.</p>
                    </div>
                    <button
                      onClick={loadUsers}
                      className="px-3 py-2 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
                    >
                      Refresh
                    </button>
                  </div>
                  <div className="mt-3 overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">When</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Owner</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Retries</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reason</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {generationJobDeadLetters.items.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No dead-lettered generation jobs.</td>
                          </tr>
                        ) : generationJobDeadLetters.items.map((item) => (
                          <tr key={item.id}>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.created_at ? new Date(item.created_at).toLocaleString() : 'n/a'}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.job_type}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.owner_name}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.retry_count}/{item.max_retries}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.dead_letter_reason || 'max_retries_exhausted'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-yellow-800">Generation dead-letter queue is unavailable right now.</p>
                </div>
              )}
              {promptRegistry ? (
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">Prompt Registry</h3>
                      <p className="text-sm text-gray-600 mt-1">Versioned prompt governance for generation pipelines.</p>
                    </div>
                    <button
                      onClick={loadUsers}
                      className="px-3 py-2 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
                    >
                      Refresh
                    </button>
                  </div>
                  <div className="mt-3 overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">When</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Key</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Version</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Model</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Scope</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {promptRegistry.items.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-4 py-6 text-sm text-gray-500 text-center">No prompt versions registered yet.</td>
                          </tr>
                        ) : promptRegistry.items.map((item) => (
                          <tr key={item.id}>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.created_at ? new Date(item.created_at).toLocaleString() : 'n/a'}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.generation_type}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.prompt_key}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">v{item.version}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.model || 'n/a'}</td>
                            <td className="px-4 py-2 text-sm text-gray-700">{item.user_id == null ? 'Global' : 'User'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-yellow-800">Prompt registry is unavailable right now.</p>
                </div>
              )}
              {customHomeworkTelemetry ? (
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">Custom Homework Telemetry</h3>
                      <p className="text-sm text-gray-600 mt-1">Operational snapshot for custom homework generation reliability and cost.</p>
                    </div>
                    <button
                      onClick={loadUsers}
                      className="px-3 py-2 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
                    >
                      Refresh
                    </button>
                  </div>

                  <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
                    <div className="rounded border border-gray-200 p-3">
                      <div className="text-xs text-gray-500">Total</div>
                      <div className="text-xl font-semibold text-gray-900 mt-1">{customHomeworkTelemetry.summary.total_events}</div>
                    </div>
                    <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
                      <div className="text-xs text-emerald-700">Success</div>
                      <div className="text-xl font-semibold text-emerald-900 mt-1">{customHomeworkTelemetry.summary.success_events}</div>
                    </div>
                    <div className="rounded border border-rose-200 bg-rose-50 p-3">
                      <div className="text-xs text-rose-700">Errors</div>
                      <div className="text-xl font-semibold text-rose-900 mt-1">{customHomeworkTelemetry.summary.error_events}</div>
                    </div>
                    <div className="rounded border border-amber-200 bg-amber-50 p-3">
                      <div className="text-xs text-amber-700">Fallback Mode</div>
                      <div className="text-xl font-semibold text-amber-900 mt-1">{customHomeworkTelemetry.summary.fallback_events}</div>
                    </div>
                    <div className="rounded border border-blue-200 bg-blue-50 p-3">
                      <div className="text-xs text-blue-700">Avg Duration</div>
                      <div className="text-xl font-semibold text-blue-900 mt-1">{Math.round(customHomeworkTelemetry.summary.average_duration_ms)} ms</div>
                    </div>
                    <div className="rounded border border-violet-200 bg-violet-50 p-3">
                      <div className="text-xs text-violet-700">Estimated Cost</div>
                      <div className="text-xl font-semibold text-violet-900 mt-1">${customHomeworkTelemetry.summary.total_estimated_cost_usd.toFixed(4)}</div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded border border-amber-200 bg-amber-50 p-3">
                      <div className="text-xs text-amber-700">Review Backlog</div>
                      <div className="text-xl font-semibold text-amber-900 mt-1">
                        {customHomeworkTelemetry.workflow_metrics?.review_backlog_count ?? 0}
                      </div>
                    </div>
                    <div className="rounded border border-indigo-200 bg-indigo-50 p-3">
                      <div className="text-xs text-indigo-700">Avg Publish Latency</div>
                      <div className="text-xl font-semibold text-indigo-900 mt-1">
                        {Math.round(customHomeworkTelemetry.workflow_metrics?.average_publish_latency_hours ?? 0)}h
                      </div>
                    </div>
                    <div className="rounded border border-teal-200 bg-teal-50 p-3">
                      <div className="text-xs text-teal-700">Completion Rate</div>
                      <div className="text-xl font-semibold text-teal-900 mt-1">
                        {(customHomeworkTelemetry.workflow_metrics?.published_completion_rate_percent ?? 0).toFixed(1)}%
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div className="rounded border border-gray-200">
                      <div className="px-4 py-3 border-b border-gray-200">
                        <h4 className="text-sm font-semibold text-gray-900">Last 14 Days</h4>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Success</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Errors</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Fallback</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {customHomeworkTelemetry.daily_trend.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No telemetry trends yet.</td>
                              </tr>
                            ) : customHomeworkTelemetry.daily_trend.map((item) => (
                              <tr key={item.date}>
                                <td className="px-4 py-2 text-sm text-gray-700">{new Date(item.date).toLocaleDateString()}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{item.total_events}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{item.success_events}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{item.error_events}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{item.fallback_events}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="rounded border border-gray-200">
                      <div className="px-4 py-3 border-b border-gray-200">
                        <h4 className="text-sm font-semibold text-gray-900">Recent Events</h4>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">When</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Mode</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Owner</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {customHomeworkTelemetry.recent_events.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No telemetry events yet.</td>
                              </tr>
                            ) : customHomeworkTelemetry.recent_events.slice(0, 12).map((eventItem) => (
                              <tr key={eventItem.id}>
                                <td className="px-4 py-2 text-sm text-gray-700">{new Date(eventItem.created_at).toLocaleString()}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{eventItem.status}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{eventItem.assessment_generation_mode || 'n/a'}</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{eventItem.duration_ms} ms</td>
                                <td className="px-4 py-2 text-sm text-gray-700">{eventItem.owner.name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded border border-gray-200">
                    <div className="px-4 py-3 border-b border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-900">Workflow Audit Events</h4>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">When</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Target Status</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Updated</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Skipped</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Owner</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {(customHomeworkTelemetry.workflow_recent_events || []).length === 0 ? (
                            <tr>
                              <td colSpan={6} className="px-4 py-6 text-sm text-gray-500 text-center">No workflow audit events yet.</td>
                            </tr>
                          ) : (customHomeworkTelemetry.workflow_recent_events || []).slice(0, 12).map((eventItem) => (
                            <tr key={eventItem.id}>
                              <td className="px-4 py-2 text-sm text-gray-700">{new Date(eventItem.created_at).toLocaleString()}</td>
                              <td className="px-4 py-2 text-sm text-gray-700">{eventItem.action}</td>
                              <td className="px-4 py-2 text-sm text-gray-700">{eventItem.status || 'n/a'}</td>
                              <td className="px-4 py-2 text-sm text-gray-700">{eventItem.updated_count}/{eventItem.target_count}</td>
                              <td className="px-4 py-2 text-sm text-gray-700">{eventItem.skipped_count}</td>
                              <td className="px-4 py-2 text-sm text-gray-700">{eventItem.owner.name}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-yellow-800">Custom homework telemetry is unavailable right now.</p>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.entries(systemHealth.checks).map(([key, value]) => (
                  <div key={key} className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-semibold text-gray-800 capitalize">{key.replace(/_/g, ' ')}</h4>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${value.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                        {value.ok ? 'Ready' : 'Needs attention'}
                      </span>
                    </div>
                    <div className="space-y-1 text-sm text-gray-600">
                      {Object.entries(value)
                        .filter(([childKey]) => childKey !== 'ok')
                        .map(([childKey, childValue]) => (
                          <div key={childKey}>
                            <span className="font-medium text-gray-700">{childKey.replace(/_/g, ' ')}:</span>{' '}
                            <span>{String(childValue)}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : activeTab === 'pending' ? (
        <div>
          {pendingUsers.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 rounded-lg">
              <CheckCircle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">No pending user approvals</p>
            </div>
          ) : (
            <div className="bg-white shadow rounded-lg overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      User
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Registered
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {pendingUsers.map((pendingUser) => (
                    <tr key={pendingUser.id}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-10 w-10 rounded-full bg-primary-100 flex items-center justify-center">
                            <User className="h-6 w-6 text-primary-600" />
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-gray-900">
                              {pendingUser.name || 'No name'}
                            </div>
                            <div className="text-sm text-gray-500 flex items-center">
                              <Mail className="h-4 w-4 mr-1" />
                              {pendingUser.email}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(pendingUser.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-yellow-100 text-yellow-800">
                          <Clock className="h-3 w-3 mr-1" />
                          Pending Approval
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex justify-end items-center gap-2">
                          <button
                            onClick={() => handleApprove(pendingUser.id)}
                            disabled={actionLoading === pendingUser.id}
                            className="inline-flex items-center px-3 py-1 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50"
                          >
                            <CheckCircle className="h-4 w-4 mr-1" />
                            Approve
                          </button>
                          <button
                            onClick={() => handleReject(pendingUser.id)}
                            disabled={actionLoading === pendingUser.id}
                            className="inline-flex items-center px-3 py-1 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                          >
                            <XCircle className="h-4 w-4 mr-1" />
                            Reject
                          </button>
                          {pendingUser.id !== user?.id && (
                            <>
                              <button
                                onClick={() => handleLock(pendingUser.id, pendingUser.is_active === false)}
                                disabled={actionLoading === pendingUser.id}
                                title={pendingUser.is_active === false ? 'Unlock' : 'Lock'}
                                className="p-1.5 rounded text-gray-500 hover:text-amber-600 hover:bg-amber-50 disabled:opacity-50"
                              >
                                {pendingUser.is_active === false ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                              </button>
                              <button
                                onClick={() => handleDelete(pendingUser.id, pendingUser.name || pendingUser.email)}
                                disabled={actionLoading === pendingUser.id}
                                title="Delete"
                                className="p-1.5 rounded text-gray-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">User Access Audit</h3>
              <p className="text-xs text-gray-600">Review user-level overrides alongside organisation policy.</p>
            </div>
            {isSuperAdmin && (
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={showPolicyAffectedOnly}
                  onChange={(e) => setShowPolicyAffectedOnly(e.target.checked)}
                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                Show only users affected by organisation policy
              </label>
            )}
          </div>
          {filteredUsers.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 rounded-lg">
              <User className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">
                {showPolicyAffectedOnly ? 'No users are currently affected by organisation-level feature policy.' : 'No users found'}
              </p>
            </div>
          ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Organisation / Department
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Features
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Registered
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredUsers.map((userData) => {
                const feat = userData.features || {};
                const organisationFeatures = organisations.find((org) => org.id === userData.organisation_id)?.features || {};
                return (
                <tr key={userData.id}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="flex-shrink-0 h-10 w-10 rounded-full bg-primary-100 flex items-center justify-center">
                        <User className="h-6 w-6 text-primary-600" />
                      </div>
                      <div className="ml-4">
                        <div className="text-sm font-medium text-gray-900">
                          {userData.name || 'No name'}
                        </div>
                        <div className="text-sm text-gray-500">{userData.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <select
                      value={normalizeRole(userData.role)}
                      onChange={(e) => handleRoleChange(userData.id, e.target.value as UserRole)}
                      disabled={actionLoading === userData.id || userData.id === user?.id}
                      className="text-sm border-gray-300 rounded-md focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
                    >
                      <option value="student">Student</option>
                      <option value="lecturer">Lecturer</option>
                      <option value="management">Management</option>
                    </select>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex flex-col gap-2 min-w-[220px]">
                      {isSuperAdmin ? (
                        <select
                          value={userData.organisation_id || ''}
                          onChange={(e) => handleOrganisationChange(userData.id, e.target.value ? Number(e.target.value) : null)}
                          disabled={actionLoading === userData.id}
                          className="text-sm border-gray-300 rounded-md focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
                        >
                          <option value="">No organisation</option>
                          {organisations.map((org) => (
                            <option key={org.id} value={org.id}>{org.name}</option>
                          ))}
                        </select>
                      ) : (
                        <div className="text-sm text-gray-700">
                          {userData.organisation_name || 'No organisation'}
                        </div>
                      )}
                      <select
                        value={userData.department_id || ''}
                        onChange={(e) => handleDepartmentChange(userData.id, e.target.value ? Number(e.target.value) : null)}
                        disabled={actionLoading === userData.id || !userData.organisation_id}
                        className="text-sm border-gray-300 rounded-md focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
                      >
                        <option value="">{userData.organisation_id ? 'No department' : 'Assign organisation first'}</option>
                        {departments
                          .filter((department) => Number(department.organisation_id) === Number(userData.organisation_id))
                          .map((department) => (
                            <option key={department.id} value={department.id}>{department.name}</option>
                          ))}
                      </select>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex flex-col gap-3 text-xs min-w-[280px]">
                      {FEATURE_DEFINITIONS.map(({ key, label, icon: Icon }) => {
                        const organisationAllowed = isFeatureAllowed(organisationFeatures[key]);
                        const userAllowed = isFeatureAllowed(feat[key]);
                        const effectiveAllowed = getEffectiveFeatureValue(feat, organisationFeatures, key);
                        const orgStatusLabel = organisationAllowed ? 'Organisation enabled' : 'Organisation disabled';
                        const userStatusLabel = userAllowed ? 'User enabled' : 'User disabled';

                        return (
                          <div key={key} className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 text-gray-700">
                                <Icon className="h-3.5 w-3.5 text-gray-500" />
                                <span>{label}</span>
                              </div>
                              <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${effectiveAllowed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                {effectiveAllowed ? 'Effective: enabled' : 'Effective: disabled'}
                              </span>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={userAllowed}
                                  onChange={(e) => handleFeaturesChange(userData.id, key, e.target.checked)}
                                  disabled={actionLoading === userData.id || userData.id === user?.id}
                                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                />
                                <span className={`${userAllowed ? 'text-gray-700' : 'text-red-700'}`}>{userStatusLabel}</span>
                              </label>
                              <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${organisationAllowed ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}`}>
                                {orgStatusLabel}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex flex-col space-y-1">
                      {userData.is_approved ? (
                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                          Approved
                        </span>
                      ) : (
                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-yellow-100 text-yellow-800">
                          Pending
                        </span>
                      )}
                      {userData.is_active === false && (
                        <span className="px-2 inline-flex items-center text-xs leading-5 font-semibold rounded-full bg-gray-200 text-gray-800">
                          <Lock className="h-3 w-3 mr-1" />
                          Locked
                        </span>
                      )}
                      {!userData.email_verified && (
                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800">
                          Unverified
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(userData.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="flex justify-end items-center gap-2 flex-wrap">
                      {!userData.is_approved && userData.email_verified && (
                        <button
                          onClick={() => handleApprove(userData.id)}
                          disabled={actionLoading === userData.id}
                          className="text-green-600 hover:text-green-900 disabled:opacity-50"
                        >
                          Approve
                        </button>
                      )}
                      {userData.id !== user?.id && (
                        <>
                          {normalizeRole(userData.role) !== 'management' && (
                            <button
                              onClick={() => handleImpersonate(userData.id)}
                              disabled={actionLoading === userData.id}
                              title="Impersonate user"
                              className="px-2 py-1 rounded text-xs font-medium text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                            >
                              Impersonate
                            </button>
                          )}
                          <button
                            onClick={() => handleLock(userData.id, userData.is_active === false)}
                            disabled={actionLoading === userData.id}
                            title={userData.is_active === false ? 'Unlock user' : 'Lock user'}
                            className="p-1.5 rounded text-gray-500 hover:text-amber-600 hover:bg-amber-50 disabled:opacity-50"
                          >
                            {userData.is_active === false ? (
                              <Unlock className="h-4 w-4" />
                            ) : (
                              <Lock className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            onClick={() => handleDelete(userData.id, userData.name || userData.email)}
                            disabled={actionLoading === userData.id}
                            title="Delete user"
                            className="p-1.5 rounded text-gray-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
          )}
        </div>
      )}
    </div>
  );
};

export default AdminDashboard;
