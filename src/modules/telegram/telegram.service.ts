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
    });

    await this.client.start({
      phoneNumber: async () =>
        this.configService.get<string>('TELEGRAM_PHONE') ??
        (await this.prompt('Telefon raqamingizni kiriting: ')),
      phoneCode: async () =>
        await this.prompt('Telegramdan kelgan kodni kiriting: '),
      password: async () => await this.prompt('2FA Parolingizni kiriting: '),
      onError: (err) => this.logger.error('Telegram ulanish xatosi:', err),
    });

    this.logger.log('Telegram UserBot ulandi!');

    if (!savedSession) {
      this.logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.logger.warn('YANGI SESSION KALITI — buni .env ga saqlang!');
      this.logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(this.client.session.save());
      this.logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
