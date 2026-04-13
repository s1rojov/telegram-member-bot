import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { ConfigService } from '@nestjs/config';
import { NewMessage } from 'telegram/events';

@Injectable()
export class BotService implements OnModuleInit {
  private client: TelegramClient;
  private readonly logger = new Logger(BotService.name);

  constructor(private configService: ConfigService) {
    const apiId = Number(this.configService.get('TELEGRAM_API_ID'));
    const apiHash = this.configService.get('TELEGRAM_API_HASH');
    const session = new StringSession('');

    this.client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
    });
  }

  async onModuleInit() {
    await this.client.start({
      botAuthToken: this.configService.get<string>('BOT_TOKEN') as string,
    });

    this.logger.log('--- BotFather Bot ishga tushdi ---');

    this.client.addEventHandler(async (event: any) => {
      const message = event.message;
      if (!message || !message.message) return;

      // /groups komandasini tekshirish
      if (message.message.trim() === '/groups') {
        await this.handleCommonGroups(message);
      }
    }, new NewMessage({}));
  }

  private async handleCommonGroups(message: any) {
    try {
      // Xabarni yozgan foydalanuvchining ID sini olamiz
      const senderId = message.senderId;

      if (!senderId) return;

      // Bot va foydalanuvchi o'rtasidagi umumiy guruhlarni olish
      const result = await this.client.invoke(
        new Api.messages.GetCommonChats({
          userId: senderId,
          maxId: 0 as any,
          limit: 100,
        }),
      );

      const chats = (result as any).chats;

      if (!chats || chats.length === 0) {
        await this.client.sendMessage(message.peerId, {
          message: "Siz bilan biz a'zo bo'lgan umumiy guruhlar topilmadi.",
        });
        return;
      }

      let responseText = "Biz birga bo'lgan guruhlar ro'yxati:\n\n";

      chats.forEach((chat: any) => {
        // Chat ID ni to'g'ri formatda shakllantirish (-100 bilan)
        const formattedId = chat.id.toString().startsWith('-100')
          ? chat.id.toString()
          : `-100${chat.id}`;

        responseText += `👥 **${chat.title}**\nID: \`${formattedId}\`\n\n`;
      });

      await this.client.sendMessage(message.peerId, {
        message: responseText,
        parseMode: 'markdown',
      });
    } catch (error) {
      this.logger.error('Umumiy guruhlarni olishda xato:', error);
      await this.client.sendMessage(message.peerId, {
        message: 'Guruhlarni yuklashda xatolik yuz berdi.',
      });
    }
  }

  getClient() {
    return this.client;
  }
}
