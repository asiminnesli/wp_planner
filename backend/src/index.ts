import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { env } from './config/env';
import authRoutes from './routes/auth.routes';
import taskRoutes from './routes/task.routes';
import whatsappRoutes from './routes/whatsapp.routes';
import { SchedulerService } from './services/scheduler.service';
import { WhatsAppClientService } from './services/whatsapp-client.service';

const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // React SPA için CSP devre dışı
}));
app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    whatsapp: WhatsAppClientService.isConnected() ? 'connected' : 'disconnected',
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/whatsapp', whatsappRoutes);

// Production: Frontend static dosyalarını serve et
if (env.NODE_ENV === 'production') {
  const frontendPath = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendPath));

  // SPA fallback: API dışı tüm istekleri index.html'e yönlendir
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('💥 Unhandled error:', err.message);
  res.status(500).json({ error: 'Sunucu hatası' });
});

// Start server
app.listen(env.PORT, () => {
  console.log(`🚀 Server çalışıyor: http://localhost:${env.PORT}`);
  console.log(`📊 Environment: ${env.NODE_ENV}`);

  // Start scheduler
  SchedulerService.start();

  // Start WhatsApp client
  WhatsAppClientService.initialize().catch((err) => {
    console.error('❌ WhatsApp başlatılamadı:', err.message);
  });
});

export default app;
