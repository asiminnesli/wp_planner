import React, { useState, useEffect } from 'react';
import { loginAdmin, getAdminUsers, updateAdminUser } from '../services/admin.api';
import { Shield, Users, Edit2, Check, X } from 'lucide-react';

export const AdminPage: React.FC = () => {
  const [token, setToken] = useState<string | null>(localStorage.getItem('adminToken'));
  const [password, setPassword] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', email: '', phone: '', newPassword: '' });

  useEffect(() => {
    if (token) {
      loadUsers();
    }
  }, [token]);

  const loadUsers = async () => {
    try {
      const data = await getAdminUsers();
      setUsers(data);
    } catch (err: any) {
      setError('Kullanıcılar yüklenemedi: ' + (err.response?.data?.error || err.message));
      if (err.response?.status === 401 || err.response?.status === 403) {
        handleLogout();
      }
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const data = await loginAdmin(password);
      localStorage.setItem('adminToken', data.token);
      setToken(data.token);
      setError('');
    } catch (err: any) {
      setError('Geçersiz şifre');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    setToken(null);
    setUsers([]);
  };

  const startEditing = (user: any) => {
    setEditingUserId(user.id);
    setEditForm({ name: user.name, email: user.email, phone: user.phone || '', newPassword: '' });
  };

  const handleUpdate = async (id: string) => {
    try {
      await updateAdminUser(id, {
        name: editForm.name,
        email: editForm.email,
        phone: editForm.phone,
        ...(editForm.newPassword ? { password: editForm.newPassword } : {})
      });
      setEditingUserId(null);
      loadUsers();
    } catch (err: any) {
      alert('Güncelleme başarısız: ' + (err.response?.data?.error || err.message));
    }
  };

  if (!token) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: 'var(--bg-primary)' }}>
        <div style={{ background: 'var(--bg-secondary)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--bg-card)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
            <Shield size={24} color="var(--accent-primary)" />
            <h2 style={{ margin: 0, color: 'var(--text-primary)' }}>Admin Paneli</h2>
          </div>
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <input
              type="password"
              placeholder="Admin Şifresi"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ padding: '10px', borderRadius: '8px', background: 'var(--bg-tertiary)', border: '1px solid var(--text-muted)', color: 'var(--text-primary)' }}
            />
            {error && <div style={{ color: 'var(--accent-danger)' }}>{error}</div>}
            <button type="submit" style={{ padding: '10px', borderRadius: '8px', background: 'var(--accent-primary)', color: 'white', border: 'none', cursor: 'pointer' }}>Giriş Yap</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Users size={28} color="var(--accent-primary)" />
          <h1 style={{ margin: 0, color: 'var(--text-primary)' }}>Kullanıcı Yönetimi</h1>
        </div>
        <button onClick={handleLogout} style={{ padding: '8px 16px', borderRadius: '8px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--text-muted)', cursor: 'pointer' }}>Çıkış Yap</button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', color: 'var(--text-primary)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bg-card)' }}>
              <th style={{ padding: '12px' }}>İsim</th>
              <th style={{ padding: '12px' }}>Email</th>
              <th style={{ padding: '12px' }}>Telefon</th>
              <th style={{ padding: '12px' }}>Kayıt Tarihi</th>
              <th style={{ padding: '12px' }}>İşlemler</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <React.Fragment key={user.id}>
                <tr style={{ borderBottom: '1px solid var(--bg-card)' }}>
                  <td style={{ padding: '12px' }}>{user.name}</td>
                  <td style={{ padding: '12px' }}>{user.email}</td>
                  <td style={{ padding: '12px' }}>{user.phone || '-'}</td>
                  <td style={{ padding: '12px' }}>{new Date(user.createdAt).toLocaleDateString()}</td>
                  <td style={{ padding: '12px' }}>
                    <button
                      onClick={() => editingUserId === user.id ? setEditingUserId(null) : startEditing(user)}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--accent-secondary)' }}
                    >
                      {editingUserId === user.id ? <X size={20} /> : <Edit2 size={20} />}
                    </button>
                  </td>
                </tr>
                {editingUserId === user.id && (
                  <tr>
                    <td colSpan={5} style={{ padding: '20px', background: 'var(--bg-secondary)' }}>
                      <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
                        <input
                          placeholder="İsim"
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          style={{ padding: '8px', borderRadius: '6px', border: '1px solid var(--text-muted)', background: 'var(--bg-tertiary)', color: 'white' }}
                        />
                        <input
                          placeholder="Email"
                          value={editForm.email}
                          onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                          style={{ padding: '8px', borderRadius: '6px', border: '1px solid var(--text-muted)', background: 'var(--bg-tertiary)', color: 'white' }}
                        />
                        <input
                          placeholder="Telefon"
                          value={editForm.phone}
                          onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                          style={{ padding: '8px', borderRadius: '6px', border: '1px solid var(--text-muted)', background: 'var(--bg-tertiary)', color: 'white' }}
                        />
                        <input
                          placeholder="Yeni Şifre (boş bırakılırsa değişmez)"
                          type="password"
                          value={editForm.newPassword}
                          onChange={(e) => setEditForm({ ...editForm, newPassword: e.target.value })}
                          style={{ padding: '8px', borderRadius: '6px', border: '1px solid var(--text-muted)', background: 'var(--bg-tertiary)', color: 'white' }}
                        />
                        <button
                          onClick={() => handleUpdate(user.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 16px', borderRadius: '6px', background: 'var(--accent-primary)', color: 'white', border: 'none', cursor: 'pointer' }}
                        >
                          <Check size={16} /> Kaydet
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
