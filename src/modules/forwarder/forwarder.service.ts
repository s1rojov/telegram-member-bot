import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { TelegramService } from '../telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';
import { Api } from 'telegram';

@Injectable()
export class ForwarderService implements OnModuleInit {
  private readonly logger = new Logger(ForwarderService.name);
  /** Stored as strings for safe comparison with gramjs BigInteger IDs */
  private sourceChannelIds: string[] = [];
  private destinationChannelId: string = '';

  // Album grouping: groupedId → { messages, timer }
  private albumBuffer = new Map<
    string,
    { messages: Api.Message[]; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly telegramService: TelegramService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    const rawSourceIds =
      this.configService.get<string>('SOURCE_CHANNEL_IDS') ?? '';
    const rawDestId =
      this.configService.get<string>('DESTINATION_CHANNEL_ID') ?? '';

    if (!rawSourceIds || !rawDestId) {
      this.logger.error(
        'SOURCE_CHANNEL_IDS yoki DESTINATION_CHANNEL_ID .env da topilmadi!',
      );
      return;
    }

    this.destinationChannelId = rawDestId;
    // Strip leading -100 and store bare channel IDs for comparison with gramjs IDs
    this.sourceChannelIds = rawSourceIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => id.replace(/^-100/, ''));

    this.logger.log(
      `Kuzatilayotgan kanallar: ${this.sourceChannelIds.join(', ')}`,
    );
    this.logger.log(`Maqsadli kanal: ${this.destinationChannelId}`);

    const client = this.telegramService.getClient();

    client.addEventHandler(
      (event: NewMessageEvent) => this.handleNewMessage(event),
      new NewMessage({}),
    );

    this.logger.log('Forwarder tayyor — yangi postlarni kutmoqda...');
  }

  private async handleNewMessage(event: NewMessageEvent) {
    const message = event.message as Api.Message;
    if (!message || !message.peerId) return;

    const peerId = message.peerId;
    let channelIdStr: string | undefined;

    if (peerId instanceof Api.PeerChannel) {
      channelIdStr = peerId.channelId.toString();
    } else if (peerId instanceof Api.PeerChat) {
      channelIdStr = peerId.chatId.toString();
    } else {
      return; // Shaxsiy xabar — o'tkazib yuboramiz
    }

    const isFromSource = this.sourceChannelIds.includes(channelIdStr);
    if (!isFromSource) return;

    // Album (media group) tekshiruvi
    if (message.groupedId) {
      await this.handleAlbumMessage(message, channelIdStr);
    } else {
      await this.forwardSingleMessage(message, channelIdStr);
    }
  }

  private async handleAlbumMessage(
    message: Api.Message,
    sourceChannelIdStr: string,
  ) {
    const groupKey = message.groupedId!.toString();

    if (this.albumBuffer.has(groupKey)) {
      const existing = this.albumBuffer.get(groupKey)!;
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.timer = setTimeout(
        () => this.flushAlbum(groupKey, sourceChannelIdStr),
        500,
      );
    } else {
      const timer = setTimeout(
        () => this.flushAlbum(groupKey, sourceChannelIdStr),
        500,
      );
      this.albumBuffer.set(groupKey, { messages: [message], timer });
    }
  }

  private async flushAlbum(groupKey: string, sourceChannelIdStr: string) {
    const buffered = this.albumBuffer.get(groupKey);
    this.albumBuffer.delete(groupKey);
    if (!buffered || buffered.messages.length === 0) return;

    const messages = buffered.messages.sort((a, b) => a.id - b.id);
    const firstMessage = messages[0];
    const messageIds = messages.map((m) => m.id);

    this.logger.log(
      `Album yuborilmoqda (${messages.length} ta rasm) — kanal: ${sourceChannelIdStr}`,
    );

    await this.forwardMessages(firstMessage, messageIds, sourceChannelIdStr);
  }

  private async forwardSingleMessage(
    message: Api.Message,
    sourceChannelIdStr: string,
  ) {
    this.logger.log(
      `Post yuborilmoqda — kanal: ${sourceChannelIdStr}, xabar ID: ${message.id}`,
    );
    await this.forwardMessages(message, [message.id], sourceChannelIdStr);
  }

  private async forwardMessages(
    referenceMessage: Api.Message,
    messageIds: number[],
    sourceChannelIdStr: string,
  ) {
    const client = this.telegramService.getClient();

    try {
      // client.forwardMessages() handles randomId internally
      const result = await client.forwardMessages(this.destinationChannelId, {
        messages: messageIds,
        fromPeer: referenceMessage.peerId!,
      });

      // Yuborilgan xabar ID larini olish
      const sentMessages = Array.isArray(result) ? result : [result];

      for (let i = 0; i < messageIds.length; i++) {
        const sentMsg = sentMessages[i] as Api.Message | undefined;
        await this.prisma.forwardLog.create({
          data: {
            sourceChannelId: sourceChannelIdStr,
            sourceMessageId: BigInt(messageIds[i]),
            destinationMessageId: sentMsg?.id ? BigInt(sentMsg.id) : null,
            status: 'success',
          },
        });
      }

      this.logger.log(
        `✓ ${messageIds.length} ta xabar muvaffaqiyatli yuborildi`,
      );
    } catch (error: any) {
      await this.handleForwardError(
        error,
        referenceMessage,
        messageIds,
        sourceChannelIdStr,
      );
    }
  }

  private async handleForwardError(
    error: any,
    referenceMessage: Api.Message,
    messageIds: number[],
    sourceChannelIdStr: string,
  ) {
    const errorName: string = error?.constructor?.name ?? 'UnknownError';

    // FloodWaitError — kutib, qayta urinish
    if (errorName === 'FloodWaitError' && typeof error.seconds === 'number') {
      const waitSeconds: number = error.seconds;
      this.logger.warn(`FloodWait: ${waitSeconds} soniya kutilmoqda...`);

      await new Promise<void>((resolve) =>
        setTimeout(resolve, (waitSeconds + 1) * 1000),
      );

      this.logger.log('FloodWait tugadi. Qayta urinilmoqda...');
      try {
        await this.forwardMessages(
          referenceMessage,
          messageIds,
          sourceChannelIdStr,
        );
        return;
      } catch (retryError: any) {
        this.logger.error('Qayta urinishda ham xato:', retryError.message);
      }
    } else {
      this.logger.error(`Xabar yuborishda xato [${errorName}]:`, error.message);
    }

    // Xatolikni DB ga yozish
    for (const msgId of messageIds) {
      await this.prisma.forwardLog.create({
        data: {
          sourceChannelId: sourceChannelIdStr,
          sourceMessageId: BigInt(msgId),
          destinationMessageId: null,
          status: 'failed',
          error: `${errorName}: ${error.message ?? ''}`.slice(0, 500),
        },
      });
    }
  }
}
