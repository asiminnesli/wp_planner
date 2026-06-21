import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  proto,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { GeminiService } from './gemini.service';
import { TaskService } from './task.service';
import prisma from '../config/database';
import * as path from 'path';
import * as fs from 'fs';
import pino from 'pino';

type RepeatType = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'INTERVAL';

const AUTH_DIR = path.join(process.cwd(), '.baileys_auth');
const logger = pino({ level: 'silent' }); // Baileys logları sessiz

let sock: WASocket | null = null;

export class WhatsAppClientService {
  private static isReady = false;
  private static myJid = '';        // Kendi JID'imiz (905xx@s.whatsapp.net)
  private static currentQr = '';    // QR code data URL for frontend
  private static qrTimestamp = 0;

  static isConnected(): boolean {
    return this.isReady;
  }

  static getStatus(): { connected: boolean; qrAvailable: boolean; qrTimestamp: number } {
    return {
      connected: this.isReady,
      qrAvailable: !!this.currentQr,
      qrTimestamp: this.qrTimestamp,
    };
  }

  static getQrCode(): string {
    return this.currentQr;
  }

  static async initialize(): Promise<void> {
    // Destroy existing connection
    if (sock) {
      try { sock.end(undefined); } catch (_) {}
      sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: true,
      logger,
      browser: ['WP Planner', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
    });

    // QR kodu geldiğinde sakla
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n📱 WhatsApp QR Kodu oluşturuldu — tarayın\n');
        // QR string'i frontend için data URL'e çevir
        WhatsAppClientService.currentQr = qr;
        WhatsAppClientService.qrTimestamp = Date.now();
      }

      if (connection === 'close') {
        WhatsAppClientService.isReady = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`⚠️ WhatsApp bağlantısı kesildi (${statusCode})`);

        if (shouldReconnect) {
          console.log('🔄 Yeniden bağlanılıyor...');
          setTimeout(() => WhatsAppClientService.initialize(), 3000);
        } else {
          console.log('🚪 Oturum kapatıldı. Auth temizleniyor...');
          // Auth dosyalarını temizle
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (_) {}
        }
      }

      if (connection === 'open') {
        WhatsAppClientService.isReady = true;
        WhatsAppClientService.currentQr = '';
        WhatsAppClientService.myJid = sock?.user?.id || '';
        // JID normalize: 905xx:xx@s.whatsapp.net → 905xx@s.whatsapp.net
        if (WhatsAppClientService.myJid.includes(':')) {
          WhatsAppClientService.myJid = WhatsAppClientService.myJid.split(':')[0] + '@s.whatsapp.net';
        }
        console.log(`✅ WhatsApp bağlantısı hazır! (${WhatsAppClientService.myJid})`);
      }
    });

    // Creds kaydet
    sock.ev.on('creds.update', saveCreds);

    // Mesajları dinle
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          // Boş mesaj veya status/broadcast atla
          if (!msg.message) continue;
          if (msg.key.remoteJid === 'status@broadcast') continue;
          if (msg.key.remoteJid?.endsWith('@g.us')) continue;

          // Sadece self-chat: kendimize attığımız mesajlar
          // fromMe=true VE remoteJid kendi numaramız olmalı
          if (!msg.key.fromMe) continue;

          // Mesaj metnini al
          const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || '';

          if (!text || text.trim().length === 0) continue;
          if (text.startsWith('|')) continue; // Bot cevapları

          const remoteJid = msg.key.remoteJid || '';
          // Self-chat kontrolü: kendimize mi yazdık?
          const myNumber = WhatsAppClientService.myJid.split('@')[0];
          const remoteNumber = remoteJid.split('@')[0];
          if (myNumber !== remoteNumber) continue;

          console.log(`📨 Mesaj: ${text}`);
          await WhatsAppClientService.handleMessage(remoteJid, text);
        } catch (err: any) {
          console.error('❌ Mesaj işleme hatası:', err.message);
        }
      }
    });

    console.log('🔄 WhatsApp bağlantısı başlatılıyor (Baileys)...');
  }

  static async destroy(): Promise<void> {
    if (sock) {
      try {
        await sock.logout();
        console.log('✅ WhatsApp oturumu kapatıldı');
      } catch (_) {
        try { sock.end(undefined); } catch (_) {}
      }
      sock = null;
      WhatsAppClientService.isReady = false;
      WhatsAppClientService.currentQr = '';
    }
    // Auth temizle
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch (_) {}
  }

  // ==================== CONVERSATION & STATE ====================

  private static pendingTasks = new Map<string, {
    title: string;
    date: string | null;
    time: string | null;
    userId: string;
    createdAt: number;
  }>();

  private static conversationHistory = new Map<string, Array<{
    role: 'user' | 'bot';
    text: string;
    timestamp: number;
  }>>();

  private static addToHistory(phone: string, role: 'user' | 'bot', text: string) {
    if (!this.conversationHistory.has(phone)) {
      this.conversationHistory.set(phone, []);
    }
    const history = this.conversationHistory.get(phone)!;
    history.push({ role, text, timestamp: Date.now() });
    if (history.length > 10) history.shift();
  }

  private static getHistory(phone: string): string {
    const history = this.conversationHistory.get(phone);
    if (!history || history.length === 0) return '';

    const cutoff = Date.now() - 15 * 60 * 1000;
    const recent = history.filter(m => m.timestamp > cutoff);
    if (recent.length === 0) return '';

    return recent
      .map(m => `${m.role === 'user' ? 'Kullanıcı' : 'Bot'}: ${m.text}`)
      .join('\n');
  }

  // ==================== MESSAGING ====================

  private static async reply(jid: string, phone: string, text: string) {
    if (!sock) return;
    const cleanText = text.startsWith('|') ? text.substring(1) : text;
    await sock.sendMessage(jid, { text: cleanText });
    WhatsAppClientService.addToHistory(phone, 'bot', cleanText.substring(0, 200));
  }

  // Send message to a phone number (used by scheduler)
  static async sendMessage(phone: string, text: string): Promise<void> {
    if (!sock || !WhatsAppClientService.isReady) {
      console.warn('⚠️ WhatsApp bağlı değil, mesaj gönderilmedi:', text);
      return;
    }

    try {
      const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text });
      console.log(`✅ WhatsApp mesajı gönderildi: ${phone}`);
    } catch (error: any) {
      console.error('❌ WhatsApp mesaj gönderilemedi:', error.message);
    }
  }

  // ==================== MESSAGE HANDLER ====================

  private static async handleMessage(jid: string, text: string): Promise<void> {
    try {
      const phone = jid.split('@')[0];
      console.log(`📱 WhatsApp mesajı alındı: ${phone} → ${text}`);

      // Check pending interval question
      const pending = WhatsAppClientService.pendingTasks.get(phone);
      if (pending) {
        if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
          WhatsAppClientService.pendingTasks.delete(phone);
        } else {
          const interval = parseIntervalResponse(text);
          if (interval) {
            const nextDueAt = pending.date ? new Date(pending.date) : new Date();
            if (pending.time) {
              const [h, m] = pending.time.split(':').map(Number);
              nextDueAt.setHours(h, m, 0, 0);
            }

            const task = await TaskService.create({
              userId: pending.userId,
              title: pending.title,
              repeatType: interval.repeatType,
              repeatIntervalDays: interval.intervalDays || undefined,
              nextDueAt,
            });

            if (pending.time) {
              await prisma.task.update({
                where: { id: task.id },
                data: { dueTime: pending.time },
              });
            }

            let reply = `✅ Görev oluşturuldu!\n\n*${task.title}*`;
            reply += `\n🔁 ${getRepeatLabel(interval.repeatType, interval.intervalDays)}`;
            if (pending.time) reply += `\n⏰ Saat: ${pending.time}`;
            await WhatsAppClientService.reply(jid, phone, reply);

            WhatsAppClientService.pendingTasks.delete(phone);
            return;
          } else {
            await WhatsAppClientService.reply(jid, phone,
              '❓ Anlamadım. Şunlardan birini yazın:\n\n' +
              '• *tek seferlik*\n• *günlük*\n• *haftalık*\n• *aylık*\n• *X günde bir* (örn: 45 günde bir)'
            );
            return;
          }
        }
      }

      // Find user by phone
      const userData = await TaskService.findTasksByUserPhone(phone);
      if (!userData) {
        await WhatsAppClientService.reply(jid, phone,
          '❌ Bu numara kayıtlı değil. Lütfen önce web uygulamasından kayıt olun ve telefon numaranızı profil ayarlarından ekleyin.'
        );
        return;
      }

      const { user, tasks } = userData;

      // Konuşma geçmişi ve görev listesi
      const history = WhatsAppClientService.getHistory(phone);
      const taskList = tasks.length > 0
        ? tasks.map((t, i) => {
            const date = t.nextDueAt ? t.nextDueAt.toLocaleDateString('tr-TR') : 'Tarih yok';
            const time = (t as any).dueTime ? ` ⏰${(t as any).dueTime}` : '';
            return `${i + 1}. ${t.title} — ${date}${time}`;
          }).join('\n')
        : '';

      WhatsAppClientService.addToHistory(phone, 'user', text);

      const action = await GeminiService.parseMessage(text, user.geminiApiKey, {
        history: history || undefined,
        taskList: taskList || undefined,
      });
      console.log('🤖 Gemini aksiyonu:', action);

      switch (action.action) {
        case 'create_task': {
          if (action.needsInterval) {
            WhatsAppClientService.pendingTasks.set(phone, {
              title: action.title,
              date: action.date,
              time: action.time,
              userId: user.id,
              createdAt: Date.now(),
            });

            await WhatsAppClientService.reply(jid, phone,
              `📝 *${action.title}*\n\nBu görev ne sıklıkla tekrar etsin?\n\n` +
              '• *tek seferlik*\n• *günlük*\n• *haftalık*\n• *aylık*\n• *X günde bir* (örn: 45 günde bir)'
            );
            break;
          }

          const repeatType: RepeatType = (['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'INTERVAL'].includes(action.repeatType)
            ? action.repeatType as RepeatType
            : 'ONCE');

          let nextDueAt: Date;

          // Esnek görev
          if (action.isFlexible && action.deadlineDays) {
            const deadlineDate = new Date();
            deadlineDate.setDate(deadlineDate.getDate() + action.deadlineDays);

            nextDueAt = await TaskService.findLeastBusyDay(user.id, action.deadlineDays);
            if (action.time) {
              const [h, m] = action.time.split(':').map(Number);
              nextDueAt.setHours(h, m, 0, 0);
            }

            const task = await TaskService.create({
              userId: user.id,
              title: action.title,
              repeatType,
              repeatIntervalDays: action.repeatIntervalDays || undefined,
              nextDueAt,
            });

            await prisma.task.update({
              where: { id: task.id },
              data: {
                isFlexible: true,
                deadlineAt: deadlineDate,
                ...(action.time ? { dueTime: action.time } : {}),
                ...(action.location ? { location: action.location } : {}),
              },
            });

            let reply = `✅ Esnek görev oluşturuldu!\n\n*${task.title}*`;
            reply += `\n📅 En uygun gün: ${nextDueAt.toLocaleDateString('tr-TR')}`;
            reply += `\n⏳ Son tarih: ${deadlineDate.toLocaleDateString('tr-TR')}`;
            if (action.time) reply += `\n⏰ Saat: ${action.time}`;
            if (action.location) reply += `\n📍 Konum: ${action.location}`;
            await WhatsAppClientService.reply(jid, phone, reply);
            break;
          }

          // Normal görev
          nextDueAt = action.date ? new Date(action.date) : new Date();
          if (action.time) {
            const [h, m] = action.time.split(':').map(Number);
            nextDueAt.setHours(h, m, 0, 0);
          }

          const task = await TaskService.create({
            userId: user.id,
            title: action.title,
            repeatType,
            repeatIntervalDays: action.repeatIntervalDays || undefined,
            nextDueAt,
          });

          if (action.time || action.location) {
            await prisma.task.update({
              where: { id: task.id },
              data: {
                ...(action.time ? { dueTime: action.time } : {}),
                ...(action.location ? { location: action.location } : {}),
              },
            });
          }

          let reply = `✅ Görev oluşturuldu!\n\n*${task.title}*`;
          if (repeatType !== 'ONCE') {
            reply += `\n🔁 ${getRepeatLabel(repeatType, action.repeatIntervalDays)}`;
          }
          if (action.date) {
            reply += `\n📅 ${new Date(action.date).toLocaleDateString('tr-TR')}`;
          }
          if (action.time) {
            reply += `\n⏰ Saat: ${action.time}`;
          }
          if (action.location) {
            reply += `\n📍 Konum: ${action.location}`;
          }
          await WhatsAppClientService.reply(jid, phone, reply);
          break;
        }

        case 'complete_task': {
          const matchingTask = tasks.find(
            (t) =>
              t.title.toLowerCase().includes(action.title.toLowerCase()) ||
              action.title.toLowerCase().includes(t.title.toLowerCase())
          );

          if (!matchingTask) {
            await WhatsAppClientService.reply(jid, phone,
              `❓ "${action.title}" ile eşleşen görev bulunamadı. Görevlerinizi görmek için "görevlerimi listele" yazın.`
            );
            break;
          }

          const completed = await TaskService.complete(matchingTask.id, user.id);
          let reply = `🎉 Tebrikler! Görev tamamlandı:\n\n*${completed.title}*`;
          if (completed.nextDueAt) {
            reply += `\n\n📅 Sonraki tarih: ${completed.nextDueAt.toLocaleDateString('tr-TR')}`;
          }
          await WhatsAppClientService.reply(jid, phone, reply);
          break;
        }

        case 'list_tasks': {
          let tasksToList = tasks;

          if (action.date) {
            const targetDate = new Date(action.date);
            tasksToList = tasks.filter((t) => {
              if (!t.nextDueAt) return false;
              const taskDate = new Date(t.nextDueAt);
              return (
                taskDate.getFullYear() === targetDate.getFullYear() &&
                taskDate.getMonth() === targetDate.getMonth() &&
                taskDate.getDate() === targetDate.getDate()
              );
            });
          }

          if (tasksToList.length === 0) {
            await WhatsAppClientService.reply(jid, phone, '📭 Bekleyen göreviniz yok!');
            break;
          }

          let reply = `📋 *Görevleriniz*\n\n`;
          tasksToList.forEach((task, i) => {
            const date = task.nextDueAt
              ? task.nextDueAt.toLocaleDateString('tr-TR')
              : 'Tarih yok';
            const time = (task as any).dueTime ? ` ⏰${(task as any).dueTime}` : '';
            const loc = (task as any).location ? ` 📍${(task as any).location}` : '';
            reply += `${i + 1}. ${task.title} — ${date}${time}${loc}\n`;
          });
          await WhatsAppClientService.reply(jid, phone, reply);
          break;
        }

        case 'update_task': {
          const taskToUpdate = tasks.find((t) =>
            t.title.toLowerCase().includes(action.title.toLowerCase())
          );

          if (!taskToUpdate) {
            await WhatsAppClientService.reply(jid, phone,
              `❓ "${action.title}" ile eşleşen görev bulunamadı.`
            );
            break;
          }

          const updateData: any = {};
          if (action.date) updateData.nextDueAt = new Date(action.date);
          if (action.time) updateData.dueTime = action.time;
          if (action.location) updateData.location = action.location;

          await prisma.task.update({
            where: { id: taskToUpdate.id },
            data: updateData,
          });

          await WhatsAppClientService.reply(jid, phone, `✅ "${taskToUpdate.title}" güncellendi.`);
          break;
        }

        case 'query_location': {
          if (!action.location) {
            await WhatsAppClientService.reply(jid, phone, '❓ Hangi konumdaki görevleri soruyorsunuz?');
            break;
          }

          const locationLower = action.location.toLowerCase();
          const locationTasks = await prisma.task.findMany({
            where: { userId: user.id, status: { not: 'COMPLETED' } },
          });

          const matchingTasks = locationTasks.filter(t =>
            t.location && t.location.toLowerCase().includes(locationLower)
          );

          if (matchingTasks.length === 0) {
            await WhatsAppClientService.reply(jid, phone,
              `📭 *${action.location}* konumunda bekleyen göreviniz yok.`
            );
            break;
          }

          const today = new Date();
          today.setHours(12, 0, 0, 0);
          for (const t of matchingTasks) {
            await prisma.task.update({
              where: { id: t.id },
              data: { nextDueAt: today },
            });
          }

          let reply = `📍 *${action.location}* konumunda ${matchingTasks.length} görev bulundu — bugüne taşındı!\n\n`;
          matchingTasks.forEach((t, i) => {
            const time = t.dueTime ? ` ⏰${t.dueTime}` : '';
            reply += `${i + 1}. ${t.title}${time}\n`;
          });
          await WhatsAppClientService.reply(jid, phone, reply);
          break;
        }

        case 'suggest': {
          const now = new Date();
          const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
          const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);

          const allTasks = await prisma.task.findMany({
            where: { userId: user.id, status: { not: 'COMPLETED' } },
            orderBy: { nextDueAt: 'asc' },
          });

          if (allTasks.length === 0) {
            await WhatsAppClientService.reply(jid, phone,
              '🎉 *Harika!* Bekleyen göreviniz yok, biraz dinlenin! ☕'
            );
            break;
          }

          const todayTasks = allTasks.filter(t =>
            t.nextDueAt && t.nextDueAt >= todayStart && t.nextDueAt <= todayEnd
          );
          const flexibleTasks = allTasks.filter(t =>
            t.isFlexible && (!t.nextDueAt || t.nextDueAt > todayEnd)
          ).sort((a, b) => {
            if (a.deadlineAt && b.deadlineAt) return a.deadlineAt.getTime() - b.deadlineAt.getTime();
            if (a.deadlineAt) return -1;
            return 1;
          });
          const overdueTasks = allTasks.filter(t =>
            t.nextDueAt && t.nextDueAt < todayStart
          );

          const locationGroups = new Map<string, typeof allTasks>();
          for (const t of allTasks) {
            if (t.location) {
              const loc = t.location.toLowerCase();
              if (!locationGroups.has(loc)) locationGroups.set(loc, []);
              locationGroups.get(loc)!.push(t);
            }
          }

          let reply = '💡 *Akıllı Öneri*\n\n';

          if (overdueTasks.length > 0) {
            reply += `🚨 *${overdueTasks.length} gecikmiş görev:*\n`;
            overdueTasks.slice(0, 3).forEach(t => {
              const loc = t.location ? ` 📍${t.location}` : '';
              reply += `  • ${t.title}${loc}\n`;
            });
            reply += '\n';
          }

          if (todayTasks.length > 0) {
            reply += `📋 *Bugün ${todayTasks.length} görev kaldı:*\n`;
            todayTasks.slice(0, 3).forEach(t => {
              const time = t.dueTime ? ` ⏰${t.dueTime}` : '';
              const loc = t.location ? ` 📍${t.location}` : '';
              reply += `  • ${t.title}${time}${loc}\n`;
            });
            reply += '\n';
          }

          const locationSuggestions: string[] = [];
          for (const [, locTasks] of locationGroups) {
            if (locTasks.length >= 2) {
              const names = locTasks.slice(0, 3).map(t => t.title).join(', ');
              locationSuggestions.push(
                `📍 *${locTasks[0].location}*'da ${locTasks.length} iş var: ${names}` +
                (locTasks.length > 3 ? '...' : '') +
                ` — gitmişken hepsini halledebilirsin!`
              );
            } else if (locTasks.length === 1) {
              locationSuggestions.push(`📍 *${locTasks[0].location}*'da: ${locTasks[0].title}`);
            }
          }

          if (locationSuggestions.length > 0) {
            reply += `🗺️ *Konum önerileri:*\n`;
            locationSuggestions.forEach(s => { reply += `  ${s}\n`; });
            reply += '\n';
          }

          if (flexibleTasks.length > 0 && todayTasks.length < 3) {
            reply += `⏳ *Bugün boşluk var! Şunları çekebilirsin:*\n`;
            flexibleTasks.slice(0, 3).forEach(t => {
              const deadline = t.deadlineAt
                ? ` (son: ${t.deadlineAt.toLocaleDateString('tr-TR')})`
                : '';
              const loc = t.location ? ` 📍${t.location}` : '';
              reply += `  • ${t.title}${deadline}${loc}\n`;
            });
            reply += '\n"bugüne çek" yazarak taşıyabilirsin.\n';
          }

          if (!overdueTasks.length && !todayTasks.length && !locationSuggestions.length && !flexibleTasks.length) {
            reply += '✨ Bugün için herşey temiz görünüyor!';
          }

          await WhatsAppClientService.reply(jid, phone, reply);
          break;
        }

        case 'unknown': {
          await WhatsAppClientService.reply(jid, phone,
            `🤖 Mesajınızı anlayamadım. Şunları deneyebilirsiniz:\n\n` +
            `📝 *"yarın toplantı var"* — Görev oluşturur\n` +
            `✅ *"toplantı tamamlandı"* — Görevi tamamlar\n` +
            `📋 *"görevlerimi listele"* — Görevleri gösterir\n` +
            `📍 *"Kadıköy'de fatura öde"* — Konumlu görev\n` +
            `💡 *"ne yapabilirim?"* — Akıllı öneri`
          );
          break;
        }
      }
    } catch (error: any) {
      console.error('❌ Mesaj işleme hatası:', error.message);
      try {
        await WhatsAppClientService.reply(jid, jid.split('@')[0], '❌ Bir hata oluştu, lütfen tekrar deneyin.');
      } catch (_) {}
    }
  }
}

function getRepeatLabel(type: RepeatType, intervalDays: number | null): string {
  switch (type) {
    case 'DAILY': return 'Her gün';
    case 'WEEKLY': return 'Her hafta';
    case 'MONTHLY': return 'Her ay';
    case 'INTERVAL': return `Her ${intervalDays} günde bir`;
    default: return 'Tek seferlik';
  }
}

function parseIntervalResponse(text: string): { repeatType: RepeatType; intervalDays: number | null } | null {
  const lower = text.toLowerCase().trim();

  if (lower.includes('tek seferlik') || lower === 'tek' || lower === 'once') {
    return { repeatType: 'ONCE', intervalDays: null };
  }
  if (lower.includes('günlük') || lower.includes('her gün') || lower === 'daily') {
    return { repeatType: 'DAILY', intervalDays: null };
  }
  if (lower.includes('haftalık') || lower.includes('her hafta') || lower === 'weekly') {
    return { repeatType: 'WEEKLY', intervalDays: null };
  }
  if (lower.includes('aylık') || lower.includes('her ay') || lower === 'monthly') {
    return { repeatType: 'MONTHLY', intervalDays: null };
  }

  const intervalMatch = lower.match(/(\d+)\s*gün/);
  if (intervalMatch) {
    return { repeatType: 'INTERVAL', intervalDays: parseInt(intervalMatch[1], 10) };
  }

  return null;
}
