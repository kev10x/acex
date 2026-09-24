import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { authAPI } from '../services/api';

export interface UserFeatures {
  assessment_creation?: boolean;
  content_creation?: boolean;
  download_results?: boolean;
  feedback_video?: boolean;
}

interface ImpersonationState {
  active: boolean;
  admin_id: number;
  admin_email: string;
  admin_name?: string | null;
}

interface User {
  id: number;
  email: string;
  name: string | null;
  account_type?: 'individual' | 'organisation';
  organisation_name?: string | null;
  organisation_id?: number | null;
  department_name?: string | null;
  department_id?: number | null;
  role?: string;
  is_approved?: boolean;
  is_super_admin?: boolean;
  features?: UserFeatures;
  impersonation?: {
    active: boolean;
    impersonated_by: number;
    impersonated_by_email?: string | null;
    impersonated_by_name?: string | null;
  } | null;
}

export interface RegisterResponse {
  user: User;
  token: string | null;
  requiresVerification: boolean;
  message: string;
  verificationUrl?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  impersonation: ImpersonationState | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string, accountType?: 'individual' | 'organisation', organisationName?: string) => Promise<RegisterResponse>;
  logout: () => void;
  updateProfile: (name?: string, email?: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  impersonateUser: (userId: number) => Promise<void>;
  stopImpersonation: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const IMPERSONATION_BACKUP_KEY = 'impersonation_backup_v1';

function readImpersonationBackup(): { token: string; user: User } | null {
  const raw = localStorage.getItem(IMPERSONATION_BACKUP_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.user) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [impersonation, setImpersonation] = useState<ImpersonationState | null>(null);

  // Load token and user from localStorage on mount
  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');
    
    if (storedToken && storedUser) {
      setToken(storedToken);
      try {
        const parsedUser = JSON.parse(storedUser);
        setUser(parsedUser);
        const backup = readImpersonationBackup();
        setImpersonation(backup ? {
          active: true,
          admin_id: backup.user.id,
          admin_email: backup.user.email,
          admin_name: backup.user.name
        } : null);
        // Verify token is still valid
        authAPI.getCurrentUser(storedToken)
          .then((userData) => {
            setUser(userData);
            const refreshedBackup = readImpersonationBackup();
            setImpersonation(refreshedBackup ? {
              active: true,
              admin_id: refreshedBackup.user.id,
              admin_email: refreshedBackup.user.email,
              admin_name: refreshedBackup.user.name
            } : null);
          })
          .catch(() => {
            // Token invalid, clear storage
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
            setToken(null);
            setUser(null);
            setImpersonation(null);
          })
          .finally(() => setLoading(false));
      } catch (error) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
        setToken(null);
        setUser(null);
        setImpersonation(null);
        setLoading(false);
      }
    } else {
      localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
      setImpersonation(null);
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    const response = await authAPI.login(email, password);
    localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
    setToken(response.token);
    setUser(response.user);
    setImpersonation(null);
    localStorage.setItem('token', response.token);
    localStorage.setItem('user', JSON.stringify(response.user));
  };

  const register = async (email: string, password: string, name?: string, accountType?: 'individual' | 'organisation', organisationName?: string) => {
    const response = await authAPI.register(email, password, name, accountType, organisationName);
    if (response.token) {
      localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
      setToken(response.token);
      setUser(response.user);
      setImpersonation(null);
      localStorage.setItem('token', response.token);
      localStorage.setItem('user', JSON.stringify(response.user));
    }
    return response;
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    setImpersonation(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
    authAPI.logout().catch(() => {
      // Ignore errors on logout
    });
  };

  const updateProfile = async (name?: string, email?: string) => {
    if (!token) throw new Error('Not authenticated');
    const updatedUser = await authAPI.updateProfile(token, name, email);
    setUser(updatedUser);
    localStorage.setItem('user', JSON.stringify(updatedUser));
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    if (!token) throw new Error('Not authenticated');
    await authAPI.changePassword(token, currentPassword, newPassword);
  };

  const impersonateUser = async (userId: number) => {
    if (!token || !user) throw new Error('Not authenticated');
    if ((user.role || '').toLowerCase() !== 'management' || impersonation?.active) {
      throw new Error('Impersonation is only available to signed-in admins');
    }
    localStorage.setItem(IMPERSONATION_BACKUP_KEY, JSON.stringify({ token, user }));
    try {
      const response = await authAPI.impersonateUser(token, userId);
      setToken(response.token);
      setUser(response.user);
      setImpersonation({
        active: true,
        admin_id: user.id,
        admin_email: user.email,
        admin_name: user.name
      });
      localStorage.setItem('token', response.token);
      localStorage.setItem('user', JSON.stringify(response.user));
    } catch (error) {
      localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
      throw error;
    }
  };

  const stopImpersonation = async () => {
    const backup = readImpersonationBackup();
    if (!backup) throw new Error('No impersonation session to restore');
    setToken(backup.token);
    setUser(backup.user);
    setImpersonation(null);
    localStorage.setItem('token', backup.token);
    localStorage.setItem('user', JSON.stringify(backup.user));
    localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
    try {
      const refreshedUser = await authAPI.getCurrentUser(backup.token);
      setUser(refreshedUser);
      localStorage.setItem('user', JSON.stringify(refreshedUser));
    } catch (_) {
      // Keep the restored session if refresh fails transiently.
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      token,
      loading,
      impersonation,
      login,
      register,
      logout,
      updateProfile,
      changePassword,
      impersonateUser,
      stopImpersonation
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
