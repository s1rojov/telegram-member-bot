import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as readline from 'readline';

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private client: TelegramClient;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const apiId = Number(this.configService.get<string>('TELEGRAM_API_ID'));
    const apiHash = this.configService.get<string>(
      'TELEGRAM_API_HASH',
    ) as string;
    const savedSession =
      this.configService.get<string>('TELEGRAM_SESSION') ?? '';

    const session = new StringSession(savedSession);

    this.client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      timeout: 60000, // 60 soniya timeout
      requestRetries: 3,
    });

    try {
      await this.client.start({
        phoneNumber: async () => {
          const phone = this.configService.get<string>('TELEGRAM_PHONE');
          if (phone) {
            this.logger.log(`Telefon raqami ishlatilmoqda: ${phone}`);
            return phone;
          }
          return await this.prompt('Telefon raqamingizni kiriting (+998...): ');
        },
        phoneCode: async () => {
          this.logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          this.logger.warn('TELEGRAM KODI KERAK!');
          this.logger.warn('Telegramdan kelgan 5 xonali kodni kiriting:');
          this.logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          const code = await this.prompt('Kod: ');
          this.logger.log(`Kod qabul qilindi: ${code}`);
          return code;
        },
        password: async () => {
          this.logger.warn('2FA parol kerak!');
          return await this.prompt('2FA Parolingizni kiriting: ');
        },
        onError: (err) => {
          this.logger.error('Telegram ulanish xatosi:', err);
          this.logger.error('Xato tafsiloti:', JSON.stringify(err, null, 2));
        },
      });

      this.logger.log('✓ Telegram UserBot muvaffaqiyatli ulandi!');

      if (!savedSession) {
        this.logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.logger.warn('YANGI SESSION KALITI — buni .env ga saqlang!');
        this.logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(this.client.session.save());
        this.logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.logger.warn('Yuqoridagi session stringni .env fayliga qo\'shing:');
        this.logger.warn('TELEGRAM_SESSION=<yuqoridagi string>');
        this.logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      }
    } catch (error) {
      this.logger.error('Telegram ulanishda xatolik yuz berdi!');
      this.logger.error('Xato:', error);

      if (error instanceof Error) {
        this.logger.error('Xato xabari:', error.message);
        this.logger.error('Stack trace:', error.stack);
      }

      this.logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.logger.error('YECHIM:');
      this.logger.error('1. .env faylida TELEGRAM_API_ID va TELEGRAM_API_HASH to\'g\'ri ekanligini tekshiring');
      this.logger.error('2. TELEGRAM_PHONE to\'g\'ri formatda ekanligini tekshiring (+998...)');
      this.logger.error('3. Internet aloqangizni tekshiring');
      this.logger.error('4. Agar kod kelmasa, Telegram da "Login Code via SMS" ni yoqing');
      this.logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      throw error;
    }
  }

  getClient(): TelegramClient {
    return this.client;
  }

  private prompt(question: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
}
