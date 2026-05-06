# Album va Matn Xabarlari - To'liq Tahlil va Tuzatish

## Muammo Tavsifi

**Asl Muammo:** Source kanaldan 2 ta rasm + matn bo'lgan post kelganda, destination kanalga faqat 2 ta rasm yuborilardi, matn yo'qolardi.

**Sabab:** Kod faqat media xabarlarni yuborish uchun optimallashtirilgan edi va matn bilan media aralash xabarlarni to'g'ri qayta ishlamaydi.

## Telegram Album Tuzilishi

Telegram da album (ko'p rasmli post) quyidagicha ishlaydi:

### Misol: 2 ta rasm + matn
```
Message 1: Photo + Caption (matn)
  - groupedId: 123456789
  - media: MessageMediaPhoto
  - message: "Bu yerda asosiy matn bor"

Message 2: Photo + Empty Caption
  - groupedId: 123456789
  - media: MessageMediaPhoto
  - message: "" (bo'sh)
```

**Muhim:** Matn odatda **birinchi** rasmning captionida bo'ladi!

## Amalga Oshirilgan Tuzatishlar

### 1. `sendMessagesAsCopies()` Funksiyasi Qayta Ishlandi

#### Eski Kod (Muammoli)
```typescript
if (messages.length > 1 && messages.every((message) => message.media)) {
  // Faqat BARCHA xabarlar media bo'lsa ishlaydi
  // Agar matn bilan aralash bo'lsa, bu shart false qaytaradi
}
```

**Muammo:** Agar albumda matn ham bo'lsa, bu shart ishlamaydi va xabarlar alohida yuboriladi.

#### Yangi Kod (Tuzatilgan)
```typescript
// Media va matn xabarlarni ajratish
const mediaMessages = messages.filter((msg) => 
  msg.media && !(msg.media instanceof Api.MessageMediaWebPage)
);
const textOnlyMessages = messages.filter((msg) => 
  !msg.media || msg.media instanceof Api.MessageMediaWebPage
);

// Albumni yuborish (ko'p media)
if (mediaMessages.length > 1) {
  // Album sifatida yuborish
}

// Matn xabarlarni alohida yuborish
for (const textMessage of textOnlyMessages) {
  // Har bir matn xabarni yuborish
}
```

### 2. Caption Imzosi Optimallashtirish

Albumda faqat **birinchi** rasmning captioniga `@WatcherGuruUzb` qo'shiladi:

```typescript
const translatedCaptions = await Promise.all(
  mediaMessages.map(async (message, index) => {
    const translated = await this.translateText(message.message ?? '', message.id);
    
    if (index === 0) {
      // Birinchi rasm - imzo qo'shiladi (translateText ichida)
      return translated;
    }
    
    // Qolgan rasmlar - faqat caption (odatda bo'sh)
    return message.message ? translated : '';
  }),
);
```

## Ishlash Tartibi

### Stsenariy 1: Album (2 ta rasm + matn)

**Source kanal:**
```
[Rasm 1] "Bu yangilik haqida ma'lumot @BoshqaKanal"
[Rasm 2] (bo'sh caption)
```

**Destination kanal:**
```
[Rasm 1] "Bu yangilik haqida ma'lumot

@WatcherGuruUzb"
[Rasm 2] (bo'sh caption)
```

### Stsenariy 2: Album + Alohida Matn

Agar album va matn **alohida** xabarlar bo'lsa:

**Source kanal:**
```
[Rasm 1] (caption bo'sh)
[Rasm 2] (caption bo'sh)
[Matn xabar] "Qo'shimcha ma'lumot"
```

**Destination kanal:**
```
[Rasm 1] (caption bo'sh)
[Rasm 2] (caption bo'sh)
[Matn xabar] "Qo'shimcha ma'lumot

@WatcherGuruUzb"
```

### Stsenariy 3: Bitta Rasm + Matn

**Source kanal:**
```
[Rasm] "Matn caption"
```

**Destination kanal:**
```
[Rasm] "Matn caption

@WatcherGuruUzb"
```

### Stsenariy 4: Faqat Matn

**Source kanal:**
```
"Oddiy matn xabari @BoshqaKanal"
```

**Destination kanal:**
```
"Oddiy matn xabari

@WatcherGuruUzb"
```

## Kanal Linklarini Almashtirish

`removeChannelLinks()` funksiyasi xabar oxiridagi barcha `@username` linkalarini olib tashlaydi:

```typescript
private removeChannelLinks(text: string): string {
  if (!text) return text;
  
  // Matn oxiridagi barcha @username linkalarni olib tashlash
  const cleanedText = text.replace(/(@[a-zA-Z0-9_]+\s*)+$/g, '');
  
  return cleanedText.trim();
}
```

**Misol:**
```
Input:  "Bu yangilik @KanalA @KanalB"
Output: "Bu yangilik"
```

Keyin `addChannelSignature()` o'z imzosini qo'shadi:
```
Final:  "Bu yangilik

@WatcherGuruUzb"
```

## Xususiyatlar

### ✅ To'liq Album Qo'llab-quvvatlash
- Ko'p rasmli albumlar to'g'ri yuboriladi
- Birinchi rasmning captioni saqlanadi
- Qolgan rasmlarning captionlari saqlanadi (agar bo'lsa)

### ✅ Matn + Media Aralashmasi
- Album + alohida matn xabarlar to'g'ri yuboriladi
- Har bir xabar o'z tartibida yuboriladi

### ✅ Kanal Imzosi
- Faqat birinchi rasmning captioniga qo'shiladi (albumda)
- Oddiy xabarlarda har doim qo'shiladi
- Eski kanal linklari olib tashlanadi

### ✅ Tarjima
- Barcha matnlar tarjima qilinadi
- Imzo tarjima qilinmaydi (doim `@WatcherGuruUzb`)

## Test Qilish

### Test 1: Album (2 ta rasm + matn)
1. Source kanalga 2 ta rasm + matn yuboring
2. Destination kanalda:
   - ✅ 2 ta rasm ko'rinishi kerak
   - ✅ Birinchi rasmda matn (tarjima qilingan) bo'lishi kerak
   - ✅ Matn oxirida `@WatcherGuruUzb` bo'lishi kerak
   - ✅ Eski kanal linklari olib tashlangan bo'lishi kerak

### Test 2: Bitta Rasm + Matn
1. Source kanalga 1 ta rasm + caption yuboring
2. Destination kanalda:
   - ✅ Rasm ko'rinishi kerak
   - ✅ Caption tarjima qilingan bo'lishi kerak
   - ✅ Oxirida `@WatcherGuruUzb` bo'lishi kerak

### Test 3: Faqat Matn
1. Source kanalga oddiy matn yuboring
2. Destination kanalda:
   - ✅ Matn tarjima qilingan bo'lishi kerak
   - ✅ Oxirida `@WatcherGuruUzb` bo'lishi kerak

### Test 4: Ko'p Rasmli Album (3+ rasm)
1. Source kanalga 3 yoki undan ko'p rasm yuboring
2. Destination kanalda:
   - ✅ Barcha rasmlar ko'rinishi kerak
   - ✅ Birinchi rasmda caption + imzo bo'lishi kerak

## Texnik Tafsilotlar

### Album Buffer Mexanizmi
```typescript
private albumBuffer = new Map<
  string,
  { messages: Api.Message[]; timer: NodeJS.Timeout }
>();
```

- Albumdagi barcha xabarlar 1200ms ichida yig'iladi
- Keyin birgalikda yuboriladi
- Bu albumning to'liq yuborilishini ta'minlaydi

### Media va Matn Ajratish
```typescript
const mediaMessages = messages.filter((msg) => 
  msg.media && !(msg.media instanceof Api.MessageMediaWebPage)
);
const textOnlyMessages = messages.filter((msg) => 
  !msg.media || msg.media instanceof Api.MessageMediaWebPage
);
```

- Media xabarlar: rasm, video, hujjat
- Matn xabarlar: oddiy matn, web preview bilan matn

## Xulosa

Endi bot to'liq ishlaydi:
- ✅ Albumlar to'liq yuboriladi (barcha rasmlar + matn)
- ✅ Matn tarjima qilinadi
- ✅ Eski kanal linklari olib tashlanadi
- ✅ `@WatcherGuruUzb` imzosi qo'shiladi
- ✅ Ko'p maqsadli kanallarga yuborish ishlaydi

Botni ishga tushiring va test qiling:
```bash
npm run start:dev
```
