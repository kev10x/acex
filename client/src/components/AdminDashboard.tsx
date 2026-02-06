import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authAPI } from '../services/api';
import { CheckCircle, XCircle, User, Mail, Clock, Shield, AlertCircle } from 'lucide-react';

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
}

const AdminDashboard: React.FC = () => {
  const { token, user } = useAuth();
  const [pendingUsers, setPendingUsers] = useState<UserData[]>([]);
  const [allUsers, setAllUsers] = useState<UserData[]>([]);
  const [activeTab, setActiveTab] = useState<'pending' | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  useEffect(() => {
    console.log('AdminDashboard useEffect triggered:', { 
      hasToken: !!token, 
      hasUser: !!user, 
      userRole: user?.role,
      userEmail: user?.email 
    });
    
    if (token && user) {
      if (user.role === 'admin') {
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
      const [pending, all] = await Promise.all([
        authAPI.getPendingUsers(token),
        authAPI.getAllUsers(token)
      ]);
      console.log('Users loaded successfully:', { 
        pendingCount: pending?.length || 0, 
        allCount: all?.length || 0,
        pending: pending,
        all: all
      });
      setPendingUsers(Array.isArray(pending) ? pending : []);
      setAllUsers(Array.isArray(all) ? all : []);
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

  const handleRoleChange = async (userId: number, newRole: 'admin' | 'user') => {
    if (!token) return;
    
    if (newRole === 'user' && !window.confirm('Are you sure you want to remove admin privileges from this user?')) {
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

  if (user.role !== 'admin') {
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

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Admin Dashboard</h1>
        <p className="text-gray-600">Manage user registrations and permissions</p>
        {/* Debug info - remove in production */}
        {process.env.NODE_ENV === 'development' && (
          <div className="mt-2 text-xs text-gray-500">
            Debug: Loading={loading.toString()}, Error={error || 'none'}, 
            Pending={pendingUsers.length}, All={allUsers.length}, 
            Role={user?.role || 'none'}
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
            All Users ({allUsers.length})
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
                        <div className="flex justify-end space-x-2">
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
          {allUsers.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 rounded-lg">
              <User className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">No users found</p>
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
              {allUsers.map((userData) => (
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
                      value={userData.role}
                      onChange={(e) => handleRoleChange(userData.id, e.target.value as 'admin' | 'user')}
                      disabled={actionLoading === userData.id || userData.id === user?.id}
                      className="text-sm border-gray-300 rounded-md focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
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
                    {!userData.is_approved && userData.email_verified && (
                      <button
                        onClick={() => handleApprove(userData.id)}
                        disabled={actionLoading === userData.id}
                        className="text-green-600 hover:text-green-900 disabled:opacity-50"
                      >
                        Approve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
      )}
    </div>
  );
};

export default AdminDashboard;
