import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { env } from '../config/env';
import { adminMiddleware } from '../middlewares/admin.middleware';

const router = Router();

// Login for Admin
router.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== '11_Murat_11') {
      res.status(401).json({ error: 'Geçersiz şifre' });
      return;
    }
    const token = jwt.sign({ role: 'admin' }, env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token });
  } catch (error: any) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// List all users
router.get('/users', adminMiddleware, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(users);
  } catch (error: any) {
    res.status(500).json({ error: 'Kullanıcılar alınamadı' });
  }
});

// Update a user
router.put('/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, password } = req.body;

    const dataToUpdate: any = {};
    if (name) dataToUpdate.name = name;
    if (email) dataToUpdate.email = email;
    if (phone) dataToUpdate.phone = phone;
    if (password) {
      dataToUpdate.password = await bcrypt.hash(password, 12);
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: dataToUpdate,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
      }
    });

    res.json(updatedUser);
  } catch (error: any) {
    res.status(500).json({ error: 'Kullanıcı güncellenemedi', details: error.message });
  }
});

export default router;
