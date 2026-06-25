import cron from 'node-cron';
import prisma from '../config/database';
import { WhatsAppClientService } from './whatsapp-client.service';

export class SchedulerService {
  static start(): void {
    console.log('⏰ Zamanlayıcı başlatıldı');

    // Her dakika çalış — 4 kontrol yapar:
    // 1. ⏰ Hatırlatma/alarm (tam saatinde bildirim)
    // 2. Saatli görev hatırlatma (30 dk önce)
    // 3. Gün başlangıcı → bugünkü görevler
    // 4. Gün bitişi - 30dk → bitmemiş görevler
    cron.schedule('* * * * *', async () => {
      try {
        const now = new Date();
        const currentHH = String(now.getHours()).padStart(2, '0');
        const currentMM = String(now.getMinutes()).padStart(2, '0');
        const currentTime = `${currentHH}:${currentMM}`;

        // === 1. Alarm/Hatırlatma (tam saatinde) ===
        await checkReminderAlarms(now, currentTime);

        // === 2. Saatli görev hatırlatma (30 dk önce) ===
        await checkTimedTaskReminders(now);

        // === 3. Gün başlangıcı → bugünkü görevler ===
        await checkDayStart(currentTime);

        // === 4. Gün bitişi - 30dk → bitmemiş görevler ===
        await checkDayEnd(currentTime);
      } catch (error: any) {
        console.error('❌ Zamanlayıcı hatası:', error.message);
      }
    });
  }
}

// 30 dk sonra olan saatli görevler için hatırlatma
async function checkTimedTaskReminders(now: Date) {
  // 30 dk sonraki saat
  const reminder = new Date(now.getTime() + 30 * 60 * 1000);
  const reminderHH = String(reminder.getHours()).padStart(2, '0');
  const reminderMM = String(reminder.getMinutes()).padStart(2, '0');
  const reminderTime = `${reminderHH}:${reminderMM}`;

  // Bugünün tarihi için filtreleme
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const tasks = await prisma.task.findMany({
    where: {
      dueTime: reminderTime,
      status: { not: 'COMPLETED' },
      nextDueAt: {
        gte: todayStart,
        lte: todayEnd,
      },
    },
    include: { user: { select: { phone: true, name: true } } },
  });

  for (const task of tasks) {
    if (task.user.phone) {
      const text = `|⏰ *Hatırlatma*\n\n30 dakika sonra:\n\n*${task.title}* — ${task.dueTime}`;
      await WhatsAppClientService.sendMessage(task.user.phone, text);
      console.log(`⏰ Hatırlatma gönderildi: ${task.title} → ${task.user.phone}`);
    }
  }
}

// Gün başlangıcında bugünkü görevleri gönder
async function checkDayStart(currentTime: string) {
  const users = await prisma.user.findMany({
    where: {
      dayStartTime: currentTime,
      phone: { not: null },
    },
  });

  for (const user of users) {
    if (!user.phone) continue;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const tasks = await prisma.task.findMany({
      where: {
        userId: user.id,
        status: { not: 'COMPLETED' },
        nextDueAt: {
          gte: todayStart,
          lte: todayEnd,
        },
      },
      orderBy: { nextDueAt: 'asc' },
    });

    if (tasks.length === 0) {
      await WhatsAppClientService.sendMessage(user.phone, '|☀️ *Günaydın!*\n\nBugün planlanmış göreviniz yok.');
    } else {
      let text = `|☀️ *Günaydın ${user.name}!*\n\nBugünkü görevleriniz:\n\n`;
      tasks.forEach((task, i) => {
        const time = task.dueTime ? ` ⏰${task.dueTime}` : '';
        text += `${i + 1}. ${task.title}${time}\n`;
      });
      text += '\nTamamladığınızda "tamamlandı" yazın.';
      await WhatsAppClientService.sendMessage(user.phone, text);
    }
    console.log(`☀️ Gün başlangıcı mesajı: ${user.name} → ${user.phone}`);
  }
}

// Gün bitişinden 30 dk önce bitmemiş görevleri hatırlat
async function checkDayEnd(currentTime: string) {
  // dayEndTime'dan 30 dk önceki saati hesapla
  const users = await prisma.user.findMany({
    where: {
      phone: { not: null },
      dayEndTime: { not: null },
    },
  });

  for (const user of users) {
    if (!user.phone || !user.dayEndTime) continue;

    // dayEndTime'dan 30 dk çıkar
    const [endH, endM] = user.dayEndTime.split(':').map(Number);
    const endMinutes = endH * 60 + endM;
    const reminderMinutes = endMinutes - 30;
    if (reminderMinutes < 0) continue;

    const reminderH = String(Math.floor(reminderMinutes / 60)).padStart(2, '0');
    const reminderM = String(reminderMinutes % 60).padStart(2, '0');
    const reminderTime = `${reminderH}:${reminderM}`;

    if (currentTime !== reminderTime) continue;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const unfinishedTasks = await prisma.task.findMany({
      where: {
        userId: user.id,
        status: { not: 'COMPLETED' },
        nextDueAt: {
          gte: todayStart,
          lte: todayEnd,
        },
      },
      orderBy: { nextDueAt: 'asc' },
    });

    if (unfinishedTasks.length > 0) {
      let text = `|🌙 *Gün Sonu Hatırlatma*\n\nBitmemiş görevleriniz var:\n\n`;
      unfinishedTasks.forEach((task, i) => {
        const time = task.dueTime ? ` ⏰${task.dueTime}` : '';
        text += `${i + 1}. ${task.title}${time}\n`;
      });
      text += `\n⏰ Gün bitiş: ${user.dayEndTime}`;
      await WhatsAppClientService.sendMessage(user.phone, text);
      console.log(`🌙 Gün sonu hatırlatma: ${user.name} → ${user.phone}`);
    }
  }
}

// Tam saatinde hatırlatma/alarm gönder (isReminder=true olan görevler)
async function checkReminderAlarms(now: Date, currentTime: string) {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const reminders = await prisma.task.findMany({
    where: {
      isReminder: true,
      dueTime: currentTime,
      status: { not: 'COMPLETED' },
      nextDueAt: {
        gte: todayStart,
        lte: todayEnd,
      },
    },
    include: { user: { select: { phone: true, name: true } } },
  });

  for (const task of reminders) {
    if (task.user.phone) {
      const text = `|🔔 *HATIRLATMA!*\n\n*${task.title}*\n\n⏰ Saat: ${task.dueTime}\n\n_Bu hatırlatıcıyı siz kurdunuz._`;
      await WhatsAppClientService.sendMessage(task.user.phone, text);
      console.log(`🔔 Alarm gönderildi: ${task.title} → ${task.user.phone}`);

      // Hatırlatma görevini tamamlandı olarak işaretle
      await prisma.task.update({
        where: { id: task.id },
        data: { status: 'COMPLETED', lastCompletedAt: now },
      });
    }
  }
}
