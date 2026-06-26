import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
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
  /** Called by the Axios interceptor when a silent refresh succeeds */
  _updateToken: (token: string, refreshToken: string) => void;
  /** Called by the Axios interceptor when refresh fails — forces logout */
  _forceLogout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const IMPERSONATION_BACKUP_KEY = 'impersonation_backup_v1';

// ── Storage helpers ───────────────────────────────────────────────────────────
function storeSession(token: string, refreshToken: string, user: User) {
  localStorage.setItem('token', token);
  localStorage.setItem('refreshToken', refreshToken);
  localStorage.setItem('user', JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem('token');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
  localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
}

function readImpersonationBackup(): { token: string; refreshToken: string; user: User } | null {
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

// ── Provider ──────────────────────────────────────────────────────────────────
export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [impersonation, setImpersonation] = useState<ImpersonationState | null>(null);
  // Keep a ref so the Axios interceptor can always read the current token
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');

    if (storedToken && storedUser) {
      setToken(storedToken);
      try {
        setUser(JSON.parse(storedUser));
        const backup = readImpersonationBackup();
        setImpersonation(backup ? {
          active: true,
          admin_id: backup.user.id,
          admin_email: backup.user.email,
          admin_name: backup.user.name,
        } : null);

        authAPI.getCurrentUser(storedToken)
          .then((userData) => {
            setUser(userData);
            localStorage.setItem('user', JSON.stringify(userData));
          })
          .catch(() => {
            // Access token may already be expired — interceptor will handle refresh on next real request.
            // For the initial load, just clear if we can't recover.
            const storedRefresh = localStorage.getItem('refreshToken');
            if (!storedRefresh) {
              clearSession();
              setToken(null);
              setUser(null);
              setImpersonation(null);
            }
          })
          .finally(() => setLoading(false));
      } catch {
        clearSession();
        setToken(null);
        setUser(null);
        setImpersonation(null);
        setLoading(false);
      }
    } else {
      setLoading(false);
    }
    // ── Listen for events emitted by the Axios interceptor ──────────────────
    const onTokenRefreshed = (e: Event) => {
      const detail = (e as CustomEvent).detail as { token: string; refreshToken: string };
      if (detail?.token) {
        setToken(detail.token);
        if (detail.refreshToken) localStorage.setItem('refreshToken', detail.refreshToken);
      }
    };
    const onSessionExpired = () => {
      setToken(null);
      setUser(null);
      setImpersonation(null);
      clearSession();
    };
    window.addEventListener('ax:token-refreshed', onTokenRefreshed);
    window.addEventListener('ax:session-expired', onSessionExpired);
    return () => {
      window.removeEventListener('ax:token-refreshed', onTokenRefreshed);
      window.removeEventListener('ax:session-expired', onSessionExpired);
    };
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────
  const login = async (email: string, password: string) => {
    const response = await authAPI.login(email, password);
    const refreshToken = (response as any).refreshToken || '';
    localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
    setToken(response.token);
    setUser(response.user);
    setImpersonation(null);
    storeSession(response.token, refreshToken, response.user);
  };

  const register = async (
    email: string, password: string, name?: string,
    accountType?: 'individual' | 'organisation', organisationName?: string
  ) => {
    const response = await authAPI.register(email, password, name, accountType, organisationName);
    if (response.token) {
      localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
      setToken(response.token);
      setUser(response.user);
      setImpersonation(null);
      storeSession(response.token, '', response.user);
    }
    return response;
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    setImpersonation(null);
    clearSession();
    authAPI.logout().catch(() => {});
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
    const storedRefresh = localStorage.getItem('refreshToken') || '';
    localStorage.setItem(IMPERSONATION_BACKUP_KEY, JSON.stringify({ token, refreshToken: storedRefresh, user }));
    try {
      const response = await authAPI.impersonateUser(token, userId);
      setToken(response.token);
      setUser(response.user);
      setImpersonation({ active: true, admin_id: user.id, admin_email: user.email, admin_name: user.name });
      storeSession(response.token, '', response.user);
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
    storeSession(backup.token, backup.refreshToken || '', backup.user);
    localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
    try {
      const refreshedUser = await authAPI.getCurrentUser(backup.token);
      setUser(refreshedUser);
      localStorage.setItem('user', JSON.stringify(refreshedUser));
    } catch (_) {}
  };

  // ── Called by Axios interceptor on silent refresh success ─────────────────
  const _updateToken = (newToken: string, newRefreshToken: string) => {
    setToken(newToken);
    localStorage.setItem('token', newToken);
    if (newRefreshToken) localStorage.setItem('refreshToken', newRefreshToken);
  };

  // ── Called by Axios interceptor when refresh itself fails ─────────────────
  const _forceLogout = () => {
    setToken(null);
    setUser(null);
    setImpersonation(null);
    clearSession();
  };

  return (
    <AuthContext.Provider value={{
      user, token, loading, impersonation,
      login, register, logout,
      updateProfile, changePassword,
      impersonateUser, stopImpersonation,
      _updateToken, _forceLogout,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
