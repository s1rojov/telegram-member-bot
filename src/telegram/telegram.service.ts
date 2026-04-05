import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as input from 'input'; // npm i input

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private client: TelegramClient;

  // .env dan ma'lumotlarni olyapmiz
  private apiId = Number(process.env.TELEGRAM_API_ID);
  private apiHash = process.env.TELEGRAM_API_HASH as string;
  private stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');

  async onModuleInit() {
    this.client = new TelegramClient(
      this.stringSession,
      this.apiId,
      this.apiHash,
      {
        connectionRetries: 5,
      },
    );

    // AGAR SESSYIYA BO'LSA - To'g'ridan-to'g'ri ulanadi
    // AGAR SESSYIYA BO'LMASA - Terminalda kod so'raydi
    await this.client.start({
      phoneNumber: async () => process.env.TELEGRAM_PHONE || '',
      password: async () => await input.text('2FA Parolingizni kiriting: '),
      phoneCode: async () =>
        await input.text('Telegramdan kelgan kodni kiriting: '),
      onError: (err) => this.logger.error(err),
    });

    this.logger.log('Telegram UserBot ulandi!');

    // Birinchi marta kirganda sessiyani saqlash uchun chiqaradi
    if (!process.env.TELEGRAM_SESSION) {
      this.logger.warn('YANGI SESSYIYA KALITI (Buni .env ga saqlang!):');
      console.log(this.client.session.save());
    }
  }

  async getGroupMembers(groupUsername: string) {
    try {
      const participants = await this.client.getParticipants(groupUsername);
      return participants.map((p) => ({
        id: p.id.toString(),
        username: p.username,
        firstName: p.firstName,
      }));
    } catch (e: any) {
      this.logger.error(`A'zolarni olishda xato: ${e.message}`);
      return [];
    }
  }

  //get joined group channel and groups

  async getJoinedGroups() {
    try {
      // UserBot qatnashayotgan barcha chatlarni olish (limit: 100 ta chat)
      const dialogs = await this.client.getDialogs({ limit: 100 });

      // Faqat guruhlar va superguruhlarni filtrlash
      const groups = dialogs.filter(
        (dialog) => dialog.isGroup || dialog.isChannel, // Telegramda katta guruhlar 'Channel' tipida bo'ladi (supergroup)
      );

      return groups.map((group) => ({
        id: group.id?.toString(),
        title: group.title,
        type: group.isChannel ? 'Supergroup/Channel' : 'Group',
        username:
          group.entity instanceof Api.Channel ? group.entity.username : null,
        participantsCount:
          (group.entity as any).participantsCount || 'Nomaʼlum',
      }));
    } catch (error: any) {
      this.logger.error(`Guruhlarni olishda xato: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
