import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { authAPI } from '../services/api';

interface User {
  id: number;
  email: string;
  name: string | null;
  account_type?: 'individual' | 'organisation';
  organisation_name?: string | null;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string, accountType?: 'individual' | 'organisation', organisationName?: string) => Promise<void>;
  logout: () => void;
  updateProfile: (name?: string, email?: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load token and user from localStorage on mount
  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');
    
    if (storedToken && storedUser) {
      setToken(storedToken);
      try {
        setUser(JSON.parse(storedUser));
        // Verify token is still valid
        authAPI.getCurrentUser(storedToken)
          .then((userData) => {
            setUser(userData);
          })
          .catch(() => {
            // Token invalid, clear storage
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            setToken(null);
            setUser(null);
          })
          .finally(() => setLoading(false));
      } catch (error) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setToken(null);
        setUser(null);
        setLoading(false);
      }
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    const response = await authAPI.login(email, password);
    setToken(response.token);
    setUser(response.user);
    localStorage.setItem('token', response.token);
    localStorage.setItem('user', JSON.stringify(response.user));
  };

  const register = async (email: string, password: string, name?: string, accountType?: 'individual' | 'organisation', organisationName?: string) => {
    const response = await authAPI.register(email, password, name, accountType, organisationName);
    setToken(response.token);
    setUser(response.user);
    localStorage.setItem('token', response.token);
    localStorage.setItem('user', JSON.stringify(response.user));
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
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

  return (
    <AuthContext.Provider value={{
      user,
      token,
      loading,
      login,
      register,
      logout,
      updateProfile,
      changePassword
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
