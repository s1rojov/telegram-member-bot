import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // 1. createApplicationContext o'rniga create ishlatamiz (Veb-server bo'lishi uchun)
  const app = await NestFactory.create(AppModule);

  // 2. Render beradigan dinamik portni olamiz
  const port = process.env.PORT || 3000;

  // 3. Graceful shutdown funksiyasi
  const shutdown = (signal: string): void => {
    console.log(`${signal} qabul qilindi. Bot yopilmoqda...`);
    void app
      .close()
      .then(() => {
        console.log('Bot muvaffaqiyatli toxtatildi.');
        process.exit(0);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Graceful shutdown xatosi (${signal}): ${message}`);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 4. Serverni Render uchun barcha IP-manzillarda eshitadigan qilib yoqamiz
  await app.listen(port, '0.0.0.0');
  console.log(`Bot ${port}-portda ishlamoqda...`);
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Bootstrap xatosi: ${message}`);
  process.exit(1);
});
