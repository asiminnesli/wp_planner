# 📋 WP Planner — AI-Powered WhatsApp Task Manager

<div align="center">

**Kendine WhatsApp mesajı at, AI görevlerini yönetsin.**

WhatsApp + Gemini AI + Akıllı Planlama = Üretkenlik

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=for-the-badge&logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)

</div>

---

## ✨ Özellikler

### 🤖 WhatsApp AI Asistanı
- **Doğal dil ile görev oluşturma** — *"yarın 16'da toplantı"*, *"3 gün içinde mail gönder"*
- **Çoklu görev çıkarma** — *"1-2-3 temmuz direksiyon eğitimi"* → 3 ayrı görev oluşturur
- **Numaralı görev tamamlama** — *"1 bitti"* → listedeki doğru görevi tamamlar
- **Bağlam sorma** — *"25 haziran 09:00"* → *"Bu tarihte ne işiniz var?"* diye sorar
- **Doğal sohbet** — Selamlama, soru, teşekkür → samimi cevap verir
- **Self-chat** — Sadece kendine attığın mesajları işler

### 📸 Resim & Ses ile Görev Oluşturma
- **Resim gönder** — Not kağıdı, yapışkan kağıt, tahta, ekran görüntüsü → OCR ile görev çıkarır
- **Ses kaydı gönder** — Konuşmayı analiz edip görevleri çıkarır
- **Onay akışı** — Çıkarılan görevleri sunar, *"evet"* deyince oluşturur

### 📌 Zamansız Görevler
- *"bir ara araba yıkat"* → ⏳ Zamansız görev listesine eklenir
- *"fırsatını bulunca Kadıköy'e git"* → Tarihsiz, konum etiketli görev
- *"zamansız görevlerim"* → Sadece zamansız görevleri listeler

### 📍 Konum Bazlı Görevler
- *"Kadıköy'de fatura öde"* → 📍 Kadıköy tag'i ile görev oluşturur
- *"Kadıköy'e gidiyorum, işim var mı?"* → O konumdaki görevleri bulur ve bugüne taşır

### 💡 Akıllı Öneri Motoru
- *"Ne yapabilirim?"* deyince:
  - 🚨 Gecikmiş görevleri gösterir
  - 🗺️ Konum bazlı gruplama — *"Kadıköy'de 3 iş var, gitmişken hepsini halledebilirsin!"*
  - ⏳ Bugün boşsa esnek görevleri çekmeyi önerir

### 📅 Esnek Görev Planlaması
- *"Bu hafta motoru bakıma götür"* → En boş güne otomatik atar
- *"3 gün içinde mail gönder"* → Deadline'a göre en uygun güne yerleştirir
- Yoğun günlere yüklenmez, iş yükünü dengeler

### ⏰ Akıllı Hatırlatmalar
- Saatli görevlerde **30 dk önce** WhatsApp hatırlatması
- **Gün başı** mesajı: Bugünkü görevlerin listesi (günlük/haftalık tekrarlar dahil)
- **Gün sonu** mesajı: Bitmemiş görevler için uyarı
- Tekrarlayan görevler: günlük, haftalık, aylık, X günde bir

### 🌐 Modern Web Arayüzü
- Dashboard, görev listesi, takvim görünümü
- Profil ayarları: çalışma saatleri, Gemini API key
- **WhatsApp bağlantı yönetimi** — QR kodu web'den tarayın
- Dark mode, glassmorphism, micro-animations

---

## 🚀 Kurulum

### Gereksinimler
- **Node.js** 18+
- **npm** veya **yarn**
- **PostgreSQL** (Railway, Supabase veya lokal)
- **Google Gemini API Key** — [ai.google.dev](https://ai.google.dev) üzerinden ücretsiz alınabilir

### 1. Repoyu klonla

```bash
git clone https://github.com/asiminnesli/wp_planner.git
cd wp_planner
```

### 2. Backend kurulumu

```bash
cd backend
npm install
```

`.env` dosyası oluştur:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/wp_planner"
JWT_SECRET="your-super-secret-jwt-key-change-this"
JWT_EXPIRES_IN="7d"
GEMINI_API_KEY="your-gemini-api-key"
PORT=3000
NODE_ENV=development
FRONTEND_URL="http://localhost:5173"
```

Veritabanını oluştur:

```bash
npx prisma db push
```

### 3. Frontend kurulumu

```bash
cd ../frontend
npm install
```

### 4. Çalıştır

İki terminal aç:

```bash
# Terminal 1 — Backend
cd backend
npm run dev

# Terminal 2 — Frontend
cd frontend
npm run dev
```

### 5. WhatsApp Bağlantısı

1. `http://localhost:5173` adresine git
2. Kayıt ol ve giriş yap
3. **Ayarlar** sayfasına git
4. QR kodu WhatsApp'tan tara: **Bağlı Cihazlar → Cihaz Bağla**
5. Kendine mesaj atarak test et!

---

## 🐳 Docker ile Deploy (Railway)

```bash
# Railway'e deploy
railway up
```

Gerekli environment variables:
- `DATABASE_URL` — PostgreSQL bağlantı URL'i
- `GEMINI_API_KEY` — Gemini API anahtarı
- `JWT_SECRET` — JWT şifreleme anahtarı

---

## 💬 WhatsApp Komutları

| Mesaj | Sonuç |
|-------|-------|
| `yarın 16'da toplantı` | ✅ Saatli görev + 30 dk hatırlatma |
| `1-2-3 temmuz saat 09:00 direksiyon` | ✅ 3 ayrı görev oluşturur |
| `45 günde bir backup kontrolü yap` | 🔁 Tekrarlayan görev |
| `bu hafta motoru bakıma götür` | ⏳ Esnek görev, en boş güne atar |
| `bir ara araba yıkat` | 📌 Zamansız görev |
| `Kadıköy'de fatura öde` | 📍 Konumlu görev |
| `Kadıköy'e gidiyorum, işim var mı?` | 📍 Konum sorgusu |
| `bugün neler var?` | 📋 Bugünkü görevler (günlük tekrarlar dahil) |
| `yarın ne var?` | 📋 Yarınkı görevler |
| `zamansız görevlerim` | 📌 Zamansız görev listesi |
| `1 bitti` | ✅ Listedeki 1. görevi tamamlar |
| `toplantı tamamlandı` | ✅ İsimle eşleşen görevi tamamlar |
| `ne yapabilirim?` | 💡 Akıllı öneri motoru |
| `merhaba` | 💬 Doğal sohbet cevabı |
| 📸 *Resim gönder* | 🔍 OCR → görev çıkar → onay ister |
| 🎤 *Ses gönder* | 🔍 Transkript → görev çıkar → onay ister |

---

## 🏗️ Mimari

```
wp_planner/
├── backend/
│   ├── prisma/              # Veritabanı şeması
│   ├── src/
│   │   ├── config/          # Ortam değişkenleri, DB bağlantısı
│   │   ├── controllers/     # HTTP + Webhook controller'ları
│   │   ├── middlewares/     # JWT auth middleware
│   │   ├── routes/          # API route'ları
│   │   └── services/
│   │       ├── gemini.service.ts           # AI mesaj + medya analizi
│   │       ├── whatsapp-client.service.ts  # Baileys WhatsApp bağlantısı
│   │       ├── whatsapp-cloud.service.ts   # Meta Cloud API (opsiyonel)
│   │       ├── scheduler.service.ts        # Zamanlanmış hatırlatmalar
│   │       ├── task.service.ts             # Görev CRUD + akıllı planlama
│   │       └── auth.service.ts             # Kimlik doğrulama
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/      # React bileşenleri
│   │   ├── context/         # Auth context
│   │   ├── pages/           # Sayfa bileşenleri
│   │   ├── services/        # API client
│   │   └── index.css        # Tasarım sistemi
│   └── package.json
├── Dockerfile               # Production Docker build
├── railway.toml             # Railway deploy config
└── README.md
```

### Teknoloji Stack

| Katman | Teknoloji |
|--------|-----------|
| **Frontend** | React 19, TypeScript, Vite, Lucide Icons |
| **Backend** | Node.js, Express, TypeScript |
| **Veritabanı** | PostgreSQL + Prisma ORM |
| **AI** | Google Gemini 2.5 Flash (metin + multimodal) |
| **WhatsApp** | Baileys (WebSocket) + Meta Cloud API (opsiyonel) |
| **Auth** | JWT (jsonwebtoken, bcryptjs) |
| **Deploy** | Docker, Railway |

---

## 📝 Roadmap

- [x] 🎤 Ses mesajı ile görev oluşturma
- [x] 🖼️ Resim ile görev oluşturma (Gemini Vision)
- [x] 📌 Zamansız görev desteği
- [x] 🔢 Çoklu görev çıkarma (tek mesajdan)
- [x] ❓ Bağlam sorma (eksik bilgi tamamlama)
- [ ] 🌍 Çoklu dil desteği
- [ ] 📱 PWA desteği
- [ ] 🏷️ Görev kategorileri ve etiketler
- [ ] 📊 Haftalık/aylık verimlilik raporu

---

## 📄 Lisans

Bu proje [MIT](LICENSE) lisansı altında yayınlanmıştır.
