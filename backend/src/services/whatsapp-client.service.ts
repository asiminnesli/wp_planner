import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  proto,
  makeCacheableSignalKeyStore,
  getAggregateVotesInPollMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { GeminiService } from './gemini.service';
import { TaskService } from './task.service';
import prisma from '../config/database';
import * as path from 'path';
import * as fs from 'fs';
import pino from 'pino';

type RepeatType = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'INTERVAL';

const AUTH_DIR = process.env.NODE_ENV === 'production'
  ? path.join(process.cwd(), 'data', 'baileys_auth')
  : path.join(process.cwd(), '.baileys_auth');
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'error' : 'warn' });

let sock: WASocket | null = null;

// In-memory message store — poll cevaplarını decrypt etmek için gerekli
const msgStore = new Map<string, proto.IWebMessageInfo>();

function getMsgKey(key: proto.IMessageKey): string {
  return `${key.remoteJid}_${key.id}`;
}

export class WhatsAppClientService {
  private static isReady = false;
  private static myJid = '';        // Kendi JID'imiz (905xx@s.whatsapp.net)
  private static myLid = '';        // Self-chat LID (43684xxx@lid)
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

    // WhatsApp protokol versiyonunu çek (405 hatasını önler)
    const { fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📦 Baileys versiyon: ${version.join('.')} (güncel: ${isLatest})`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      browser: ['WP Planner', 'Safari', '3.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async (key) => {
        const stored = msgStore.get(getMsgKey(key));
        return stored?.message || undefined;
      },
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
        if (WhatsAppClientService.myJid.includes(':')) {
          WhatsAppClientService.myJid = WhatsAppClientService.myJid.split(':')[0] + '@s.whatsapp.net';
        }
        // Self-chat LID'i al
        WhatsAppClientService.myLid = (sock?.user as any)?.lid || '';
        if (WhatsAppClientService.myLid.includes(':')) {
          WhatsAppClientService.myLid = WhatsAppClientService.myLid.split(':')[0] + '@lid';
        }
        console.log(`✅ WhatsApp bağlantısı hazır! (${WhatsAppClientService.myJid}, LID: ${WhatsAppClientService.myLid})`);
      }
    });

    // Creds kaydet
    sock.ev.on('creds.update', saveCreds);

    // Mesajları dinle
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          const remoteJid = msg.key.remoteJid || '';

          if (!msg.message) continue;
          if (remoteJid === 'status@broadcast') continue;
          if (remoteJid.endsWith('@g.us')) continue;

          // Tüm mesajları store'a kaydet (poll decrypt için gerekli)
          if (msg.key) msgStore.set(getMsgKey(msg.key), msg);

          // Self-chat kontrolü
          const myNumber = WhatsAppClientService.myJid.split('@')[0];
          const myLidNumber = WhatsAppClientService.myLid.split('@')[0];
          const remoteNumber = remoteJid.split('@')[0];
          const isSelfChat = (myNumber === remoteNumber) || (myLidNumber && myLidNumber === remoteNumber);
          if (!isSelfChat) continue;

          // Metin mesajı
          const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || '';

          // Resim mesajı
          const imageMsg = msg.message?.imageMessage;
          // Ses mesajı
          const audioMsg = msg.message?.audioMessage;

          if (imageMsg || audioMsg) {
            console.log(`📎 Medya mesajı alındı: ${imageMsg ? 'resim' : 'ses'}`);
            await WhatsAppClientService.handleMedia(remoteJid, msg, imageMsg ? 'image' : 'audio');
          } else if (text && text.trim().length > 0) {
            console.log(`📨 Mesaj: ${text}`);
            await WhatsAppClientService.handleMessage(remoteJid, text);
          }
        } catch (err: any) {
          console.error('❌ Mesaj işleme hatası:', err.message);
        }
      }
    });

    // Poll oy güncellemelerini dinle
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        try {
          const pollUpdates = update.update?.pollUpdates;
          if (!pollUpdates || pollUpdates.length === 0) continue;

          console.log(`📊 messages.update: pollUpdates alındı (${pollUpdates.length} update)`);

          const pollKey = update.key;
          const storeKey = getMsgKey(pollKey);
          const originalMsg = msgStore.get(storeKey);

          if (!originalMsg) {
            console.log(`⚠️ Poll orijinal mesajı store'da bulunamadı: ${storeKey}`);
            console.log(`📝 Store'daki key sayısı: ${msgStore.size}`);
            continue;
          }

          if (!originalMsg.message?.pollCreationMessage) {
            console.log(`⚠️ Orijinal mesaj poll değil`);
            continue;
          }

          const pollVotes = getAggregateVotesInPollMessage({
            message: originalMsg.message,
            pollUpdates,
          });

          console.log(`📊 Poll sonuçları:`, JSON.stringify(pollVotes.map(v => ({ name: v.name, voters: v.voters.length }))));

          // En çok oy alan seçeneği bul
          const topVote = pollVotes.sort((a, b) => b.voters.length - a.voters.length)[0];
          if (!topVote || topVote.voters.length === 0) {
            console.log(`⚠️ Poll'da oy yok veya boş`);
            continue;
          }

          const selectedOption = topVote.name;
          const jid = pollKey.remoteJid || '';

          console.log(`✅ Poll seçimi: "${selectedOption}" → handleInteractiveResponse`);
          await WhatsAppClientService.handleInteractiveResponse(jid, selectedOption);
        } catch (err: any) {
          console.error('❌ Poll güncelleme hatası:', err.message, err.stack);
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
    type: 'interval' | 'clarification' | 'media_confirmation' | 'task_filter' | 'task_complete_select';
    title: string;
    date: string | null;
    time: string | null;
    dates?: string[];
    proposedActions?: import('./gemini.service').GeminiAction[];  // medya onayı için
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

  // ==================== POLL MESSAGES ====================

  /**
   * WhatsApp Poll mesajı gönder (Baileys'de çalışan anket)
   * selectableCount=1 → tek seçim (radio button gibi)
   */
  private static async sendPollMessage(
    jid: string,
    phone: string,
    question: string,
    options: string[],
    selectableCount: number = 1,
  ): Promise<void> {
    if (!sock) return;
    try {
      const sentMsg = await sock.sendMessage(jid, {
        poll: {
          name: question,
          values: options,
          selectableCount,
        },
      });
      // Poll mesajını store'a kaydet (oy decrypt için)
      if (sentMsg?.key) {
        msgStore.set(getMsgKey(sentMsg.key), sentMsg);
      }
      WhatsAppClientService.addToHistory(phone, 'bot', `[Poll: ${question}]`);
    } catch (err: any) {
      console.error('❌ Poll gönderilemedi:', err.message);
      // Fallback: düz metin
      let fallbackText = `📊 *${question}*\n\n`;
      options.forEach((opt, i) => {
        fallbackText += `${i + 1}. ${opt}\n`;
      });
      await WhatsAppClientService.reply(jid, phone, fallbackText);
    }
  }

  // ==================== POLL RESPONSE HANDLER ====================

  private static async handleInteractiveResponse(jid: string, selectedOption: string): Promise<void> {
    try {
      const phone = WhatsAppClientService.myJid.split('@')[0];
      console.log(`📊 Poll seçim: ${selectedOption}`);
      WhatsAppClientService.addToHistory(phone, 'user', `[Seçim: ${selectedOption}]`);

      const pending = WhatsAppClientService.pendingTasks.get(phone);

      // ── Interval seçimi ──
      if (pending?.type === 'interval') {
        const intervalMap: Record<string, { repeatType: RepeatType; intervalDays: number | null }> = {
          'Tek Seferlik': { repeatType: 'ONCE', intervalDays: null },
          'Günlük': { repeatType: 'DAILY', intervalDays: null },
          'Haftalık': { repeatType: 'WEEKLY', intervalDays: null },
          'Aylık': { repeatType: 'MONTHLY', intervalDays: null },
        };

        const selected = intervalMap[selectedOption];
        if (!selected) {
          // Özel Aralık seçildi
          await WhatsAppClientService.reply(jid, phone, '📝 Kaç günde bir tekrar etsin? Örn: *45 günde bir*');
          return;
        }

        const nextDueAt = pending.date ? new Date(pending.date) : new Date();
        if (pending.time) {
          const [h, m] = pending.time.split(':').map(Number);
          nextDueAt.setHours(h, m, 0, 0);
        }
        const task = await TaskService.create({
          userId: pending.userId,
          title: pending.title,
          repeatType: selected.repeatType,
          repeatIntervalDays: selected.intervalDays || undefined,
          nextDueAt,
        });
        if (pending.time) {
          await prisma.task.update({ where: { id: task.id }, data: { dueTime: pending.time } });
        }
        let reply = `✅ Görev oluşturuldu!\n\n*${task.title}*`;
        reply += `\n🔁 ${getRepeatLabel(selected.repeatType, selected.intervalDays)}`;
        if (pending.time) reply += `\n⏰ Saat: ${pending.time}`;
        await WhatsAppClientService.reply(jid, phone, reply);
        WhatsAppClientService.pendingTasks.delete(phone);
        return;
      }

      // ── Medya onay seçimi ──
      if (pending?.type === 'media_confirmation') {
        if (selectedOption === 'Onayla ✅') {
          const actions = pending.proposedActions || [];
          const createdTasks: string[] = [];
          for (const a of actions) {
            const nextDueAt = a.date ? new Date(a.date) : undefined;
            if (nextDueAt && a.time) {
              const [h, m] = a.time.split(':').map(Number);
              nextDueAt.setHours(h, m, 0, 0);
            }
            const task = await TaskService.create({
              userId: pending.userId,
              title: a.title,
              repeatType: (a.repeatType as any) || 'ONCE',
              nextDueAt: nextDueAt || undefined,
            });
            if (a.time || a.location) {
              await prisma.task.update({
                where: { id: task.id },
                data: {
                  ...(a.time ? { dueTime: a.time } : {}),
                  ...(a.location ? { location: a.location } : {}),
                },
              });
            }
            const dateStr = nextDueAt ? `📅 ${nextDueAt.toLocaleDateString('tr-TR')}` : '⏳ Zamansız';
            createdTasks.push(`✅ ${a.title} — ${dateStr}${a.time ? ` ⏰${a.time}` : ''}${a.location ? ` 📍${a.location}` : ''}`);
          }
          let reply = `🎉 *${createdTasks.length} görev oluşturuldu!*\n\n`;
          createdTasks.forEach(t => { reply += `${t}\n`; });
          await WhatsAppClientService.reply(jid, phone, reply);
          WhatsAppClientService.pendingTasks.delete(phone);
          return;
        } else if (selectedOption === 'İptal ❌') {
          await WhatsAppClientService.reply(jid, phone, '❌ Görevler iptal edildi.');
          WhatsAppClientService.pendingTasks.delete(phone);
          return;
        } else if (selectedOption === 'Düzenle ✏️') {
          await WhatsAppClientService.reply(jid, phone, '✏️ Düzenlemek istediğiniz görevleri yazıyla belirtin veya medyayı tekrar gönderin.');
          WhatsAppClientService.pendingTasks.delete(phone);
          return;
        }
      }

      // ── Görev tamamlama seçimi ──
      if (pending?.type === 'task_complete_select') {
        const userData = await TaskService.findTasksByUserPhone(phone);
        if (!userData) return;
        const { user, tasks } = userData;

        const matchingTask = tasks.find(t =>
          t.title.substring(0, 24) === selectedOption || t.title === selectedOption
        );
        if (matchingTask) {
          try {
            const completed = await TaskService.complete(matchingTask.id, user.id);
            let cReply = `🎉 Tebrikler! Görev tamamlandı:\n\n*${completed.title}*`;
            if (completed.nextDueAt) {
              cReply += `\n\n📅 Sonraki tarih: ${completed.nextDueAt.toLocaleDateString('tr-TR')}`;
            }
            await WhatsAppClientService.reply(jid, phone, cReply);
          } catch {
            await WhatsAppClientService.reply(jid, phone, '❓ Görev bulunamadı veya zaten tamamlanmış.');
          }
        } else {
          await WhatsAppClientService.reply(jid, phone, '❓ Eşleşen görev bulunamadı.');
        }
        WhatsAppClientService.pendingTasks.delete(phone);
        return;
      }

      // ── Görev filtre seçimi ──
      const filterMap: Record<string, string> = {
        'Bugünkü Görevler': 'today',
        'Yarınki Görevler': 'tomorrow',
        'Bu Hafta': 'week',
        'Tüm Görevler': 'all',
        'Zamansız Görevler': 'timeless',
      };
      const filterType = filterMap[selectedOption];
      if (filterType) {
        const userData = await TaskService.findTasksByUserPhone(phone);
        if (!userData) return;
        const { tasks } = userData;

        let tasksToList = tasks;
        let listTitle = '*Görevleriniz*';

        if (filterType === 'today') {
          const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
          const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
          tasksToList = tasks.filter(t => {
            if (!t.nextDueAt) return false;
            const d = new Date(t.nextDueAt);
            return d >= todayStart && d <= todayEnd;
          });
          listTitle = `*Bugünkü Görevleriniz* 📅`;
        } else if (filterType === 'tomorrow') {
          const tmrw = new Date(); tmrw.setDate(tmrw.getDate() + 1);
          tmrw.setHours(0, 0, 0, 0);
          const tmrwEnd = new Date(tmrw); tmrwEnd.setHours(23, 59, 59, 999);
          tasksToList = tasks.filter(t => {
            if (!t.nextDueAt) return false;
            const d = new Date(t.nextDueAt);
            return d >= tmrw && d <= tmrwEnd;
          });
          listTitle = `*Yarınki Görevleriniz* 📅`;
        } else if (filterType === 'week') {
          const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
          tasksToList = tasks.filter(t => {
            if (!t.nextDueAt) return false;
            return new Date(t.nextDueAt) <= weekEnd;
          });
          listTitle = `*Bu Haftaki Görevleriniz* 📅`;
        } else if (filterType === 'timeless') {
          tasksToList = tasks.filter(t => !t.nextDueAt);
          listTitle = `*Zamansız Görevleriniz* ⏳`;
        }

        if (tasksToList.length === 0) {
          await WhatsAppClientService.reply(jid, phone, `📭 ${listTitle} — Bekleyen göreviniz yok!`);
          return;
        }

        let lReply = `📋 ${listTitle}\n\n`;
        tasksToList.forEach((t, i) => {
          const date = t.nextDueAt ? t.nextDueAt.toLocaleDateString('tr-TR') : '⏳ Zamansız';
          const time = (t as any).dueTime ? ` ⏰${(t as any).dueTime}` : '';
          const loc = (t as any).location ? ` 📍${(t as any).location}` : '';
          const repeat = (t as any).repeatType && (t as any).repeatType !== 'ONCE' ? ` 🔁` : '';
          lReply += `${i + 1}. ${t.title} — ${date}${time}${loc}${repeat}\n`;
        });
        await WhatsAppClientService.reply(jid, phone, lReply);
        return;
      }

    } catch (error: any) {
      console.error('❌ Poll response hatası:', error.message);
    }
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

  // ==================== MEDIA HANDLER ====================

  private static async handleMedia(jid: string, msg: proto.IWebMessageInfo, mediaType: 'image' | 'audio'): Promise<void> {
    try {
      const phone = WhatsAppClientService.myJid.split('@')[0];

      // Kullanıcıyı bul
      const userData = await TaskService.findTasksByUserPhone(phone);
      if (!userData) {
        await WhatsAppClientService.reply(jid, phone, '❌ Bu numara kayıtlı değil.');
        return;
      }
      const { user } = userData;

      // "Analiz ediyorum" mesajı
      if (sock) await sock.sendMessage(jid, { text: `🔍 _${mediaType === 'image' ? 'Resim' : 'Ses'} analiz ediliyor..._` });

      // Medyayı indir
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
      const buffer = await downloadMediaMessage(msg as any, 'buffer', {}) as Buffer;

      if (!buffer || buffer.length === 0) {
        await WhatsAppClientService.reply(jid, phone, '⚠️ Medya indirilemedi, lütfen tekrar gönderin.');
        return;
      }

      console.log(`📥 Medya indirildi: ${buffer.length} byte (${mediaType})`);

      // MIME type belirle
      let mimeType: string;
      if (mediaType === 'image') {
        mimeType = msg.message?.imageMessage?.mimetype || 'image/jpeg';
      } else {
        mimeType = msg.message?.audioMessage?.mimetype || 'audio/ogg';
        // Baileys ses mesajlarını ogg/opus olarak gönderir
        if (mimeType.includes('codecs')) {
          mimeType = 'audio/ogg';
        }
      }

      // Caption (resim açıklaması)
      const caption = msg.message?.imageMessage?.caption || '';

      // Gemini'ye gönder
      const response = await GeminiService.parseMedia(buffer, mimeType, user.geminiApiKey, caption);

      // Chat action'ı varsa direkt gönder (görev çıkarılmadı)
      const chatActions = response.actions.filter(a => a.action === 'chat');
      if (chatActions.length > 0 && response.actions.length === chatActions.length) {
        await WhatsAppClientService.reply(jid, phone, chatActions[0].reply || '❓ Bu medyadan görev çıkaramadım.');
        return;
      }

      // Görev önerilerini sun
      const taskActions = response.actions.filter(a => a.action === 'create_task');
      if (taskActions.length === 0) {
        await WhatsAppClientService.reply(jid, phone, '❓ Bu medyadan görev çıkaramadım. İçeriği yazıyla anlatır mısınız?');
        return;
      }

      // Önerileri formatla
      let preview = `📋 *${mediaType === 'image' ? 'Resimden' : 'Sesten'} ${taskActions.length} görev çıkardım:*\n\n`;
      taskActions.forEach((t, i) => {
        preview += `${i + 1}. *${t.title}*`;
        if (t.date) preview += ` 📅 ${new Date(t.date).toLocaleDateString('tr-TR')}`;
        if (t.time) preview += ` ⏰ ${t.time}`;
        if (t.location) preview += ` 📍 ${t.location}`;
        preview += '\n';
      });

      // Pending state'e kaydet
      WhatsAppClientService.pendingTasks.set(phone, {
        type: 'media_confirmation',
        title: '',
        date: null,
        time: null,
        proposedActions: taskActions,
        userId: user.id,
        createdAt: Date.now(),
      });

      // Poll ile onay iste
      await WhatsAppClientService.sendPollMessage(
        jid,
        phone,
        preview + '\nNe yapmak istersiniz?',
        ['Onayla ✅', 'İptal ❌', 'Düzenle ✏️'],
      );
    } catch (error: any) {
      console.error('❌ Medya işleme hatası:', error.message);
      const phone = WhatsAppClientService.myJid.split('@')[0];
      await WhatsAppClientService.reply(jid, phone, '⚠️ Medya işlenirken bir hata oluştu.');
    }
  }

  // ==================== MESSAGE HANDLER ====================

  private static async handleMessage(jid: string, text: string): Promise<void> {
    try {
      const phone = WhatsAppClientService.myJid.split('@')[0];
      console.log(`📱 WhatsApp mesajı alındı: ${phone} → ${text}`);

      // Check pending state
      const pending = WhatsAppClientService.pendingTasks.get(phone);
      if (pending) {
        if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
          WhatsAppClientService.pendingTasks.delete(phone);
        } else if (pending.type === 'interval') {
          // Interval cevabı
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
              await prisma.task.update({ where: { id: task.id }, data: { dueTime: pending.time } });
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
        } else if (pending.type === 'clarification') {
          // Clarification cevabı: tarihlerle görev oluştur
          const dates = pending.dates || [];
          const time = pending.time || null;
          const title = text.trim();

          if (dates.length > 0) {
            const createdTasks: string[] = [];
            for (const dateStr of dates) {
              const nextDueAt = new Date(dateStr);
              if (time) {
                const [h, m] = time.split(':').map(Number);
                nextDueAt.setHours(h, m, 0, 0);
              }
              const task = await TaskService.create({
                userId: pending.userId,
                title,
                repeatType: 'ONCE',
                nextDueAt,
              });
              if (time) {
                await prisma.task.update({ where: { id: task.id }, data: { dueTime: time } });
              }
              createdTasks.push(`📅 ${nextDueAt.toLocaleDateString('tr-TR')}${time ? ` ⏰${time}` : ''}`);
            }
            let reply = `✅ *${title}* — ${createdTasks.length} görev oluşturuldu!\n\n`;
            createdTasks.forEach(t => { reply += `${t}\n`; });
            await WhatsAppClientService.reply(jid, phone, reply);
            WhatsAppClientService.pendingTasks.delete(phone);
            return;
          }
          WhatsAppClientService.pendingTasks.delete(phone);
        } else if (pending.type === 'media_confirmation') {
          // Medya onay cevabı (metin veya poll seçenek metni)
          const lower = text.toLowerCase().trim();

          if (lower === 'evet' || lower === 'onay' || lower === 'e' || lower === 'tamam' || lower === 'onayla' || text.trim() === 'Onayla ✅') {
            // Tüm görevleri oluştur
            const actions = pending.proposedActions || [];
            const createdTasks: string[] = [];

            for (const a of actions) {
              const nextDueAt = a.date ? new Date(a.date) : undefined;
              if (nextDueAt && a.time) {
                const [h, m] = a.time.split(':').map(Number);
                nextDueAt.setHours(h, m, 0, 0);
              }
              const task = await TaskService.create({
                userId: pending.userId,
                title: a.title,
                repeatType: (a.repeatType as any) || 'ONCE',
                nextDueAt: nextDueAt || undefined,
              });
              if (a.time || a.location) {
                await prisma.task.update({
                  where: { id: task.id },
                  data: {
                    ...(a.time ? { dueTime: a.time } : {}),
                    ...(a.location ? { location: a.location } : {}),
                  },
                });
              }
              const dateStr = nextDueAt ? `📅 ${nextDueAt.toLocaleDateString('tr-TR')}` : '⏳ Zamansız';
              createdTasks.push(`✅ ${a.title} — ${dateStr}${a.time ? ` ⏰${a.time}` : ''}${a.location ? ` 📍${a.location}` : ''}`);
            }

            let reply = `🎉 *${createdTasks.length} görev oluşturuldu!*\n\n`;
            createdTasks.forEach(t => { reply += `${t}\n`; });
            await WhatsAppClientService.reply(jid, phone, reply);
            WhatsAppClientService.pendingTasks.delete(phone);
            return;
          } else if (lower === 'hayır' || lower === 'iptal' || lower === 'h' || lower === 'vazgeç' || text.trim() === 'İptal ❌') {
            await WhatsAppClientService.reply(jid, phone, '❌ Görevler iptal edildi.');
            WhatsAppClientService.pendingTasks.delete(phone);
            return;
          } else if (lower === 'düzenle' || lower === 'düzelt' || text.trim() === 'Düzenle ✏️') {
            await WhatsAppClientService.reply(jid, phone, '✏️ Düzenlemek istediğiniz görevleri yazıyla belirtin veya medyayı tekrar gönderin.');
            WhatsAppClientService.pendingTasks.delete(phone);
            return;
          } else {
            // Farklı bir cevap — ipucu ver
            await WhatsAppClientService.reply(jid, phone,
              '📝 Anketten bir seçenek seçin veya *evet* / *hayır* yazın.'
            );
            return;
          }
        }
      }

      // Find user
      const userData = await TaskService.findTasksByUserPhone(phone);
      if (!userData) {
        await WhatsAppClientService.reply(jid, phone,
          '❌ Bu numara kayıtlı değil. Lütfen önce web uygulamasından kayıt olun.'
        );
        return;
      }

      const { user, tasks } = userData;

      // Konuşma geçmişi ve numaralı görev listesi
      const history = WhatsAppClientService.getHistory(phone);
      const taskList = tasks.length > 0
        ? tasks.map((t, i) => {
            const date = t.nextDueAt ? t.nextDueAt.toLocaleDateString('tr-TR') : 'Tarih yok';
            const time = (t as any).dueTime ? ` ⏰${(t as any).dueTime}` : '';
            return `${i + 1}. ${t.title} — ${date}${time}`;
          }).join('\n')
        : '';

      WhatsAppClientService.addToHistory(phone, 'user', text);

      // Düşünüyorum mesajı
      if (sock) await sock.sendMessage(jid, { text: '🤔 _Düşünüyorum..._' });

      // Gemini'den çoklu action al
      const response = await GeminiService.parseMessage(text, user.geminiApiKey, {
        history: history || undefined,
        taskList: taskList || undefined,
      });
      console.log('🤖 Gemini aksiyonları:', JSON.stringify(response.actions.map(a => ({ action: a.action, title: a.title, taskNumber: a.taskNumber }))));

      // Her action'ı sırayla işle
      for (const action of response.actions) {
        switch (action.action) {
          case 'create_task': {
            if (action.needsInterval) {
              WhatsAppClientService.pendingTasks.set(phone, {
                type: 'interval',
                title: action.title,
                date: action.date,
                time: action.time,
                userId: user.id,
                createdAt: Date.now(),
              });
              // Poll ile tekrar sıklığı sor
              await WhatsAppClientService.sendPollMessage(
                jid,
                phone,
                `📝 ${action.title} — ne sıklıkla tekrar etsin?`,
                ['Tek Seferlik', 'Günlük', 'Haftalık', 'Aylık', 'Özel Aralık'],
              );
              break;
            }

            const repeatType: RepeatType = (['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'INTERVAL'].includes(action.repeatType)
              ? action.repeatType as RepeatType : 'ONCE');

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
                userId: user.id, title: action.title, repeatType,
                repeatIntervalDays: action.repeatIntervalDays || undefined, nextDueAt,
              });
              await prisma.task.update({
                where: { id: task.id },
                data: { isFlexible: true, deadlineAt: deadlineDate,
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
            nextDueAt = action.date ? new Date(action.date) : (undefined as unknown as Date);
            if (nextDueAt && action.time) {
              const [h, m] = action.time.split(':').map(Number);
              nextDueAt.setHours(h, m, 0, 0);
            }
            const task = await TaskService.create({
              userId: user.id, title: action.title, repeatType,
              repeatIntervalDays: action.repeatIntervalDays || undefined,
              nextDueAt: action.date ? nextDueAt : undefined,
            });
            if (action.time || action.location || action.isReminder) {
              await prisma.task.update({
                where: { id: task.id },
                data: {
                  ...(action.time ? { dueTime: action.time } : {}),
                  ...(action.location ? { location: action.location } : {}),
                  ...(action.isReminder ? { isReminder: true } : {}),
                },
              });
            }

            // Hatırlatma/alarm ise farklı mesaj göster
            if (action.isReminder && action.date && action.time) {
              const reminderDate = new Date(action.date);
              const now = new Date();
              const [rh, rm] = action.time.split(':').map(Number);
              reminderDate.setHours(rh, rm, 0, 0);
              const diffMs = reminderDate.getTime() - now.getTime();
              const diffMin = Math.round(diffMs / 60000);
              let timeLeft = '';
              if (diffMin >= 60) {
                const hours = Math.floor(diffMin / 60);
                const mins = diffMin % 60;
                timeLeft = mins > 0 ? `${hours} saat ${mins} dakika` : `${hours} saat`;
              } else {
                timeLeft = `${diffMin} dakika`;
              }
              let reply = `🔔 Hatırlatıcı kuruldu!\n\n*${task.title}*`;
              reply += `\n⏰ ${action.time} — ${reminderDate.toLocaleDateString('tr-TR')}`;
              reply += `\n⏳ ${timeLeft} sonra bildirim alacaksınız`;
              await WhatsAppClientService.reply(jid, phone, reply);
            } else {
              let reply = action.date
                ? `✅ Görev oluşturuldu!\n\n*${task.title}*`
                : `📌 Zamansız görev eklendi!\n\n*${task.title}*\n⏳ Zamanı gelince yapılacak`;
              if (repeatType !== 'ONCE') reply += `\n🔁 ${getRepeatLabel(repeatType, action.repeatIntervalDays)}`;
              if (action.date) reply += `\n📅 ${new Date(action.date).toLocaleDateString('tr-TR')}`;
              if (action.time) reply += `\n⏰ Saat: ${action.time}`;
              if (action.location) reply += `\n📍 Konum: ${action.location}`;
              await WhatsAppClientService.reply(jid, phone, reply);
            }
            break;
          }

          case 'complete_task': {
            let matchingTask: any = null;

            // Numaralı eşleşme: "1 bitti" → tasks[0]
            if (action.taskNumber && action.taskNumber > 0 && action.taskNumber <= tasks.length) {
              matchingTask = tasks[action.taskNumber - 1];
            }

            // Title ile fuzzy eşleşme (fallback)
            if (!matchingTask && action.title) {
              matchingTask = tasks.find(
                (t) => t.title.toLowerCase().includes(action.title.toLowerCase()) ||
                       action.title.toLowerCase().includes(t.title.toLowerCase())
              );
            }

            if (!matchingTask) {
              // Görev bulunamadı → interactive list ile seçtir
              if (tasks.length > 0) {
                WhatsAppClientService.pendingTasks.set(phone, {
                  type: 'task_complete_select',
                  title: '',
                  date: null,
                  time: null,
                  userId: user.id,
                  createdAt: Date.now(),
                });
                await WhatsAppClientService.sendPollMessage(
                  jid,
                  phone,
                  '🎯 Hangi görevi tamamladınız?',
                  tasks.slice(0, 10).map(t => t.title.substring(0, 24)),
                );
              } else {
                await WhatsAppClientService.reply(jid, phone,
                  '📭 Bekleyen göreviniz yok!'
                );
              }
              break;
            }

            const completed = await TaskService.complete(matchingTask.id, user.id);
            let cReply = `🎉 Tebrikler! Görev tamamlandı:\n\n*${completed.title}*`;
            if (completed.nextDueAt) {
              cReply += `\n\n📅 Sonraki tarih: ${completed.nextDueAt.toLocaleDateString('tr-TR')}`;
            }
            await WhatsAppClientService.reply(jid, phone, cReply);
            break;
          }

          case 'list_tasks': {
            // Belirli bir tarih veya filtre yoksa → interactive filtre sun
            if (!action.date) {
              await WhatsAppClientService.sendPollMessage(
                jid,
                phone,
                '📋 Görevlerinizi nasıl listelemek istersiniz?',
                ['Bugünkü Görevler', 'Yarınki Görevler', 'Bu Hafta', 'Tüm Görevler', 'Zamansız Görevler'],
              );
              break;
            }

            let tasksToList = tasks;
            let listTitle = '*Görevleriniz*';

            if (action.date === 'TIMELESS') {
              // Zamansız görevler
              tasksToList = tasks.filter(t => !t.nextDueAt);
              listTitle = '*Zamansız Görevleriniz* ⏳';
            } else if (action.date) {
              const targetDate = new Date(action.date);
              targetDate.setHours(0, 0, 0, 0);
              listTitle = `*${targetDate.toLocaleDateString('tr-TR')}* — *Görevleriniz*`;

              tasksToList = tasks.filter((t) => {
                if (!t.nextDueAt) return false;
                const taskDate = new Date(t.nextDueAt);
                taskDate.setHours(0, 0, 0, 0);
                if (taskDate.getTime() === targetDate.getTime()) return true;
                const rt = (t as any).repeatType;
                if (rt === 'DAILY') return true;
                if (rt === 'WEEKLY' && taskDate.getDay() === targetDate.getDay()) return true;
                if (rt === 'MONTHLY' && taskDate.getDate() === targetDate.getDate()) return true;
                if (rt === 'INTERVAL' && (t as any).repeatIntervalDays) {
                  const diff = Math.abs(targetDate.getTime() - taskDate.getTime());
                  const days = Math.round(diff / (1000 * 60 * 60 * 24));
                  if (days % (t as any).repeatIntervalDays === 0) return true;
                }
                return false;
              });
            }

            // Zamansız görevleri de say olarak belirt
            const timelessCount = tasks.filter(t => !t.nextDueAt).length;

            if (tasksToList.length === 0) {
              let emptyMsg = `📭 ${action.date && action.date !== 'TIMELESS' ? `${new Date(action.date).toLocaleDateString('tr-TR')} için ` : ''}Bekleyen göreviniz yok!`;
              if (action.date !== 'TIMELESS' && timelessCount > 0) {
                emptyMsg += `\n\n📌 ${timelessCount} zamansız göreviniz var. "zamansız görevlerim" yazarak görebilirsiniz.`;
              }
              await WhatsAppClientService.reply(jid, phone, emptyMsg);
              break;
            }

            let lReply = `📋 ${listTitle}\n\n`;
            tasksToList.forEach((t, i) => {
              const date = t.nextDueAt ? t.nextDueAt.toLocaleDateString('tr-TR') : '⏳ Zamansız';
              const time = (t as any).dueTime ? ` ⏰${(t as any).dueTime}` : '';
              const loc = (t as any).location ? ` 📍${(t as any).location}` : '';
              const repeat = (t as any).repeatType && (t as any).repeatType !== 'ONCE' ? ` 🔁` : '';
              lReply += `${i + 1}. ${t.title} — ${date}${time}${loc}${repeat}\n`;
            });

            // Zamansız görev sayısını dipnot olarak ekle (tarihli liste gösterilirken)
            if (action.date !== 'TIMELESS' && timelessCount > 0) {
              lReply += `\n📌 Ayrıca ${timelessCount} zamansız görev var. "zamansız görevlerim" yazın.`;
            }

            await WhatsAppClientService.reply(jid, phone, lReply);
            break;
          }

          case 'update_task': {
            const taskToUpdate = tasks.find((t) =>
              t.title.toLowerCase().includes(action.title.toLowerCase())
            );
            if (!taskToUpdate) {
              await WhatsAppClientService.reply(jid, phone, `❓ "${action.title}" ile eşleşen görev bulunamadı.`);
              break;
            }
            const updateData: any = {};
            if (action.date) updateData.nextDueAt = new Date(action.date);
            if (action.time) updateData.dueTime = action.time;
            if (action.location) updateData.location = action.location;
            await prisma.task.update({ where: { id: taskToUpdate.id }, data: updateData });
            await WhatsAppClientService.reply(jid, phone, `✅ "${taskToUpdate.title}" güncellendi.`);
            break;
          }

          case 'ask_clarification': {
            const dates = action.date ? action.date.split(',').map(d => d.trim()) : [];
            WhatsAppClientService.pendingTasks.set(phone, {
              type: 'clarification',
              title: '',
              date: null,
              time: action.time,
              dates,
              userId: user.id,
              createdAt: Date.now(),
            });
            const question = action.question || 'Bu tarihler için ne planladınız?';
            await WhatsAppClientService.reply(jid, phone, `❓ ${question}`);
            break;
          }

          case 'chat': {
            const chatReply = action.reply || 'Size nasıl yardımcı olabilirim? 😊';
            await WhatsAppClientService.reply(jid, phone, chatReply);
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
              await WhatsAppClientService.reply(jid, phone, `📭 *${action.location}* konumunda bekleyen göreviniz yok.`);
              break;
            }
            const today = new Date(); today.setHours(12, 0, 0, 0);
            for (const t of matchingTasks) {
              await prisma.task.update({ where: { id: t.id }, data: { nextDueAt: today } });
            }
            let locReply = `📍 *${action.location}* konumunda ${matchingTasks.length} görev bulundu — bugüne taşındı!\n\n`;
            matchingTasks.forEach((t, i) => {
              const time = t.dueTime ? ` ⏰${t.dueTime}` : '';
              locReply += `${i + 1}. ${t.title}${time}\n`;
            });
            await WhatsAppClientService.reply(jid, phone, locReply);
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
              await WhatsAppClientService.reply(jid, phone, '🎉 *Harika!* Bekleyen göreviniz yok, biraz dinlenin! ☕');
              break;
            }
            const todayTasks = allTasks.filter(t => t.nextDueAt && t.nextDueAt >= todayStart && t.nextDueAt <= todayEnd);
            const overdueTasks = allTasks.filter(t => t.nextDueAt && t.nextDueAt < todayStart);
            const flexibleTasks = allTasks.filter(t => t.isFlexible && (!t.nextDueAt || t.nextDueAt > todayEnd))
              .sort((a, b) => {
                if (a.deadlineAt && b.deadlineAt) return a.deadlineAt.getTime() - b.deadlineAt.getTime();
                if (a.deadlineAt) return -1; return 1;
              });
            const locationGroups = new Map<string, typeof allTasks>();
            for (const t of allTasks) {
              if (t.location) {
                const loc = t.location.toLowerCase();
                if (!locationGroups.has(loc)) locationGroups.set(loc, []);
                locationGroups.get(loc)!.push(t);
              }
            }
            let sReply = '💡 *Akıllı Öneri*\n\n';
            if (overdueTasks.length > 0) {
              sReply += `🚨 *${overdueTasks.length} gecikmiş görev:*\n`;
              overdueTasks.slice(0, 3).forEach(t => {
                sReply += `  • ${t.title}${t.location ? ` 📍${t.location}` : ''}\n`;
              });
              sReply += '\n';
            }
            if (todayTasks.length > 0) {
              sReply += `📋 *Bugün ${todayTasks.length} görev kaldı:*\n`;
              todayTasks.slice(0, 3).forEach(t => {
                sReply += `  • ${t.title}${t.dueTime ? ` ⏰${t.dueTime}` : ''}${t.location ? ` 📍${t.location}` : ''}\n`;
              });
              sReply += '\n';
            }
            const locSuggestions: string[] = [];
            for (const [, locTasks] of locationGroups) {
              if (locTasks.length >= 2) {
                locSuggestions.push(`📍 *${locTasks[0].location}*'da ${locTasks.length} iş var — gitmişken hepsini halledebilirsin!`);
              }
            }
            if (locSuggestions.length > 0) {
              sReply += `🗺️ *Konum önerileri:*\n`;
              locSuggestions.forEach(s => { sReply += `  ${s}\n`; });
              sReply += '\n';
            }
            if (flexibleTasks.length > 0 && todayTasks.length < 3) {
              sReply += `⏳ *Bugün boşluk var! Şunları çekebilirsin:*\n`;
              flexibleTasks.slice(0, 3).forEach(t => {
                const deadline = t.deadlineAt ? ` (son: ${t.deadlineAt.toLocaleDateString('tr-TR')})` : '';
                sReply += `  • ${t.title}${deadline}\n`;
              });
              sReply += '\n"bugüne çek" yazarak taşıyabilirsin.\n';
            }
            if (!overdueTasks.length && !todayTasks.length && !locSuggestions.length && !flexibleTasks.length) {
              sReply += '✨ Bugün için herşey temiz görünüyor!';
            }
            await WhatsAppClientService.reply(jid, phone, sReply);
            break;
          }

          default: {
            const defReply = action.reply || '🤷 Mesajınızı anlayamadım. Görev oluşturmak, tamamlamak veya listelemek için yazın.';
            await WhatsAppClientService.reply(jid, phone, defReply);
            break;
          }
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

