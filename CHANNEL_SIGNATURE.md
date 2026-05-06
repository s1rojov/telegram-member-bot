# Kanal Imzosi Funksiyasi

## Umumiy Ma'lumot
Har bir maqsadli kanalga yuboriladigan xabarning oxiriga `@WatcherGuruUzb` kanal imzosi avtomatik qo'shiladi.

## Amalga Oshirish

### O'zgartirilgan Funksiyalar

#### 1. `translateText()` funksiyasi
Tarjima qilingan matnning oxiriga kanal imzosini qo'shadi:

```typescript
private async translateText(
  text: string,
  sourceMessageId: number,
): Promise<string> {
  // ... tarjima mantiqi ...
  
  // Natijaga imzo qo'shish
  return this.addChannelSignature(finalResult);
}
```

#### 2. `addChannelSignature()` funksiyasi (yangi)
Matn oxiriga kanal imzosini qo'shadigan yordamchi funksiya:

```typescript
private addChannelSignature(text: string): string {
  const signature = '\n\n@WatcherGuruUzb';

  if (!text || !text.trim()) {
    return signature.trim();
  }

  return text + signature;
}
```

## Ishlash Tartibi

### Oddiy Xabarlar
```
Asl xabar matni (tarjima qilingan)

@WatcherGuruUzb
```

### Media Xabarlari (rasm, video, hujjat)
Caption (izoh) ga imzo qo'shiladi:
```
Media caption matni (tarjima qilingan)

@WatcherGuruUzb
```

### Bo'sh Xabarlar
Agar xabar matni bo'sh bo'lsa (faqat media), faqat imzo yuboriladi:
```
@WatcherGuruUzb
```

## Xususiyatlar

1. **Avtomatik Qo'shiladi**: Har bir xabarga avtomatik ravishda qo'shiladi
2. **Tarjimadan Keyin**: Matn tarjima qilingandan keyin imzo qo'shiladi
3. **Barcha Xabar Turlariga**: Oddiy matn, media caption, va bo'sh xabarlarga ham qo'shiladi
4. **Ikki Qator Oraliq**: Imzo asosiy matndan ikki qator oraliq bilan ajratiladi

## Misol

### Kiruvchi Xabar (manba kanal)
```
Bu yangilik haqida ma'lumot.
Juda muhim voqea yuz berdi.
```

### Chiquvchi Xabar (maqsad kanal)
```
Bu yangilik haqida ma'lumot.
Juda muhim voqea yuz berdi.

@WatcherGuruUzb
```

## Sozlash

Agar imzoni o'zgartirish kerak bo'lsa, `addChannelSignature()` funksiyasidagi `signature` o'zgaruvchisini o'zgartiring:

```typescript
private addChannelSignature(text: string): string {
  const signature = '\n\n@YangiBotNomi';  // Bu yerda o'zgartiring
  // ...
}
```

## Test Qilish

1. Botni ishga tushiring:
```bash
npm run start:dev
```

2. Manba kanalga test xabar yuboring

3. Maqsadli kanallarda xabar oxirida `@WatcherGuruUzb` borligini tekshiring

4. Turli xabar turlarini test qiling:
   - Oddiy matn xabari
   - Rasm bilan xabar
   - Video bilan xabar
   - Hujjat bilan xabar
   - Bo'sh caption bilan media

## Muhim Eslatmalar

- Imzo **barcha** maqsadli kanallarga qo'shiladi
- Imzo tarjima qilinmaydi, doim `@WatcherGuruUzb` ko'rinishida qoladi
- Agar asl xabarda boshqa kanal linklari bo'lsa, ular olib tashlanadi va faqat `@WatcherGuruUzb` qoladi
