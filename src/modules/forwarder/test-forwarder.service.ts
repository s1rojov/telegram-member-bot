import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Api } from 'telegram';
import { TelegramService } from '../telegram/telegram.service';
import { ForwarderService } from './forwarder.service';

@Injectable()
export class TestForwarderService implements OnModuleInit {
  private readonly logger = new Logger(TestForwarderService.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
    private readonly forwarderService: ForwarderService,
  ) {}

  async onModuleInit(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await this.runTest();
  }

  async runTest(): Promise<void> {
    this.logger.log('═══════════════════════════════════════════');
    this.logger.log('🧪 TEST MODE: Oxirgi postni forward qilish');
    this.logger.log('═══════════════════════════════════════════');

    const client = this.telegramService.getClient();

    const rawSourceIds =
      this.configService.get<string>('SOURCE_CHANNEL_IDS') ?? '';

    const sourceChannelIds = rawSourceIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (sourceChannelIds.length === 0) {
      this.logger.error('SOURCE_CHANNEL_IDS topilmadi!');
      return;
    }

    // Birinchi source kanaldan test qilamiz
    const rawChannelId = sourceChannelIds[0];
    const resolveRef = this.toResolveRef(rawChannelId);

    this.logger.log(`Test kanali: ${resolveRef}`);

    try {
      // 1. Kanalga to'liq kirish (cache ni to'ldiradi)
      this.logger.log("Kanal ma'lumotlari yuklanmoqda...");
      const fullChannel = await client.invoke(
        new Api.channels.GetFullChannel({ channel: resolveRef }),
      );

      const chat = fullChannel.chats?.[0];
      const channelName =
        chat instanceof Api.Channel || chat instanceof Api.Chat
          ? chat.title
          : resolveRef;

      this.logger.log(`✓ Kanal topildi: ${channelName}`);

      // 2. Oxirgi postni olish
      this.logger.log('Oxirgi post olinmoqda...');
      const peer = await client.getInputEntity(resolveRef);

      const history = await client.invoke(
        new Api.messages.GetHistory({
          peer,
          limit: 1,
          offsetId: 0,
          offsetDate: 0,
          addOffset: 0,
          maxId: 0,
          minId: 0,
          hash: BigInt(0) as any,
        }),
      );

      const messages =
        history instanceof Api.messages.ChannelMessages ||
        history instanceof Api.messages.Messages ||
        history instanceof Api.messages.MessagesSlice
          ? history.messages
          : [];

      const lastMessage = messages.find(
        (m): m is Api.Message => m instanceof Api.Message,
      );

      if (!lastMessage) {
        this.logger.warn('Kanalda hech qanday post topilmadi!');
        return;
      }

      this.logger.log('═══════════════════════════════════════════');
      this.logger.log(`📨 Oxirgi post ID: ${lastMessage.id}`);
      this.logger.log(
        `📅 Sana: ${new Date(lastMessage.date * 1000).toLocaleString()}`,
      );
      this.logger.log(
        `📝 Matn: ${lastMessage.message?.slice(0, 100) || "(matn yo'q — media)"}${lastMessage.message?.length > 100 ? '...' : ''}`,
      );
      this.logger.log(
        `🖼  Media: ${lastMessage.media ? lastMessage.media.className : "yo'q"}`,
      );
      this.logger.log('═══════════════════════════════════════════');

      // 3. Comparable channel ID ni olish (ForwarderService kabi)
      const comparableId = this.toComparableId(rawChannelId);

      // 4. ForwarderService orqali forward qilish
      this.logger.log('Forward qilinmoqda...');
      // forwardMessages private bo'lgani uchun reflection ishlatamiz
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (this.forwarderService as any).forwardMessages(
        [lastMessage],
        comparableId,
      );

      this.logger.log('✅ TEST MUVAFFAQIYATLI TUGADI');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ TEST XATOSI: ${msg}`);

      if (
        msg.toUpperCase().includes('CANNOT FIND ANY ENTITY') ||
        msg.toUpperCase().includes('PEER_ID_INVALID')
      ) {
        this.logger.error(
          'Kanal cache da topilmadi. .env da @username formatini ishlating.',
        );
      }
    }

    this.logger.log('═══════════════════════════════════════════');
  }

  private toResolveRef(rawId: string): string {
    const id = rawId.trim();
    if (id.startsWith('@') || id.includes('t.me/')) return id;
    if (/^-100\d+$/.test(id)) return id;
    if (/^-\d+$/.test(id)) return id;
    if (/^100\d+$/.test(id)) return `-${id}`;
    if (/^\d+$/.test(id)) return `-100${id}`;
    return id;
  }

  private toComparableId(rawId: string): string {
    const id = rawId.trim();
    return id.replace(/^-100/, '').replace(/^-/, '').replace(/^@/, '');
  }
}
