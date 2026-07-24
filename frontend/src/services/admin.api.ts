import axios from 'axios';

const adminApi = axios.create({
  baseURL: '/api/admin',
  headers: {
    'Content-Type': 'application/json',
  },
});

adminApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('adminToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const loginAdmin = async (password: string) => {
  const { data } = await adminApi.post('/login', { password });
  return data;
};

export const getAdminUsers = async () => {
  const { data } = await adminApi.get('/users');
  return data;
};

export const updateAdminUser = async (id: string, updateData: { name?: string; email?: string; phone?: string; password?: string }) => {
  const { data } = await adminApi.put(`/users/${id}`, updateData);
  return data;
};
