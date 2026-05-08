import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import translate from 'google-translate-api-next';
import { Api, utils } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { CustomFile } from 'telegram/client/uploads';
import * as fs from 'fs';
import * as path from 'path';
import { TelegramService } from '../telegram/telegram.service';

type ForwardRecord = {
  sourceChannelId: string;
  sourceMessageId: number;
  destinationChannelId: string;
  destinationMessageId: number | null;
  status: 'success' | 'failed';
  error?: string;
  forwardedAt: string;
};

@Injectable()
export class ForwarderService implements OnModuleInit {
  private readonly logger = new Logger(ForwarderService.name);
  private readonly albumFlushDelayMs = 1200;
  private readonly logFilePath: string;
  private readonly translateClient = 'gtx';
  private readonly MAX_CAPTION_LENGTH = 1024;

  private sourceChannelIds: string[] = [];
  private destinationChannelRefs: string[] = [];
  private destinationPeers = new Map<string, Api.TypeInputPeer>();
  private translateTo = 'uz';
  private readonly forwardedKeys = new Set<string>();
  private forwardHistory: ForwardRecord[] = [];

  // Album grouping: groupedId → { messages, timer }
  private albumBuffer = new Map<
    string,
    { messages: Api.Message[]; timer: NodeJS.Timeout }
  >();

  // Polling mexanizmi uchun
  private readonly pollingIntervalMs = 60000; // 1 daqiqa
  private pollingTimer: NodeJS.Timeout | null = null;
  private lastCheckedMessageIds = new Map<string, number>(); // channelId -> lastMessageId

  private readonly onNewMessageEvent = (event: NewMessageEvent): void => {
    void this.handleNewMessage(event).catch((error: unknown) => {
      this.logUnexpectedError('handleNewMessage xatosi', error);
    });
  };

  constructor(
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
  ) {
    this.logFilePath = path.resolve(
      this.configService.get<string>('FORWARDED_IDS_PATH')?.trim() ||
        'forwarded-ids.json',
    );
  }

  async onModuleInit(): Promise<void> {
    this.loadForwardHistory();

    const rawSourceIds =
      this.configService.get<string>('SOURCE_CHANNEL_IDS') ?? '';

    // Backward compatibility: support both singular and plural
    const rawDestIds =
      this.configService.get<string>('DESTINATION_CHANNEL_IDS') ??
      this.configService.get<string>('DESTINATION_CHANNEL_ID') ?? '';

    const rawTranslateTo =
      this.configService.get<string>('TRANSLATE_TO')?.trim() ?? '';

    if (!rawSourceIds || !rawDestIds) {
      this.logger.error(
        'SOURCE_CHANNEL_IDS yoki DESTINATION_CHANNEL_IDS .env da topilmadi!',
      );
      return;
    }

    if (rawTranslateTo) {
      this.translateTo = rawTranslateTo;
    }

    this.destinationChannelRefs = rawDestIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => this.normalizeDestinationReference(id));

    this.sourceChannelIds = rawSourceIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => this.normalizeComparableChannelId(id));

    this.logger.log(
      `Kuzatilayotgan kanal IDlari: ${this.sourceChannelIds.join(', ')}`,
    );
    this.logger.log(
      `Maqsadli kanallar (${this.destinationChannelRefs.length} ta): ${this.destinationChannelRefs.join(', ')}`,
    );
    this.logger.log(`Tarjima tili: ${this.translateTo}`);

    const client = this.telegramService.getClient();

    try {
      // Barcha dialoglarni yuklash uchun limit oshirildi
      await client.getDialogs({ limit: 500 });
      this.logger.log('Dialog cache muvaffaqiyatli yuklandi');
    } catch (error: unknown) {
      this.logger.warn(
        `Dialog cache yuklanmadi: ${this.getErrorMessage(error)}`,
      );
    }

    await this.resolveDestinationPeers();
    await this.resolveSourceChannelNames();

    // Har bir kanal uchun oxirgi xabar ID ni olish
    await this.initializeLastMessageIds();

    // Barcha xabar turlarini eshitish uchun
    client.addEventHandler(this.onNewMessageEvent, new NewMessage({}));

    // Polling mexanizmini ishga tushirish
    this.startPolling();

    this.logger.log(
      'Forwarder tayyor — yangi postlarni kutmoqda (event + polling)...',
    );
  }

  // ── Source kanallarni resolve qilib cache ga yuklaydi ───────────────────────
  private async resolveSourceChannelNames(): Promise<void> {
    const client = this.telegramService.getClient();

    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.log(
      `Kuzatilayotgan kanallar (${this.sourceChannelIds.length} ta):`,
    );

    for (const channelId of this.sourceChannelIds) {
      const resolveRef = `-100${channelId}`;
      try {
        // Avval getEntity orqali entity ni olish
        const entity = await client.getEntity(resolveRef);

        // Keyin GetFullChannel orqali to'liq ma'lumot olish
        const fullChannel = await client.invoke(
          new Api.channels.GetFullChannel({
            channel: resolveRef,
          }),
        );

        const chat = fullChannel.chats?.[0];
        const name =
          chat instanceof Api.Channel || chat instanceof Api.Chat
            ? chat.title
            : entity instanceof Api.Channel || entity instanceof Api.Chat
              ? entity.title
              : "Noma'lum";

        this.logger.log(`  ✓ ${name} (ID: ${channelId}, ref: ${resolveRef})`);
      } catch (error: unknown) {
        this.logger.warn(
          `  ✗ ID: ${channelId} (ref: ${resolveRef}) — resolve bo'lmadi: ${this.getErrorMessage(error)}`,
        );
        this.logger.warn(
          `    Maslahat: Kanal private bo'lsa, avval shu akkaunt bilan kanalga kiring`,
        );
      }
    }

    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
  // ────────────────────────────────────────────────────────────────────────────

  // ── Boshlang'ich holatni o'rnatish ─────────────────────────────────────────
  private async initializeLastMessageIds(): Promise<void> {
    const client = this.telegramService.getClient();

    this.logger.log('Har bir kanal uchun oxirgi xabar ID ni olish...');

    for (const channelId of this.sourceChannelIds) {
      try {
        const resolveRef = `-100${channelId}`;
        const entity = await client.getEntity(resolveRef);

        // Oxirgi xabarni olish
        const messages = await client.getMessages(entity, { limit: 1 });

        if (
          messages &&
          messages.length > 0 &&
          messages[0] instanceof Api.Message
        ) {
          const lastMessageId = messages[0].id;
          this.lastCheckedMessageIds.set(channelId, lastMessageId);
          this.logger.log(
            ` ✓ Kanal ${channelId}: oxirgi xabar ID = ${lastMessageId}`,
          );
        }
      } catch (error: unknown) {
        this.logger.warn(
          `✗ Kanal ${channelId}: oxirgi xabar ID olinmadi: ${this.getErrorMessage(error)}`,
        );
      }
    }

    this.logger.log("Boshlang'ich holatni o'rnatish tugadi");
  }
  // ────────────────────────────────────────────────────────────────────────────

  // ── Polling mexanizmi ───────────────────────────────────────────────────────
  private startPolling(): void {
    this.logger.log(
      `Polling mexanizmi ishga tushirildi (interval: ${this.pollingIntervalMs / 1000}s)`,
    );

    // Dastlabki tekshiruv
    void this.pollChannels().catch((error: unknown) => {
      this.logUnexpectedError('Polling dastlabki tekshiruv xatosi', error);
    });

    // Muntazam tekshiruvlar
    this.pollingTimer = setInterval(() => {
      void this.pollChannels().catch((error: unknown) => {
        this.logUnexpectedError('Polling xatosi', error);
      });
    }, this.pollingIntervalMs);
  }

  private async pollChannels(): Promise<void> {
    const client = this.telegramService.getClient();

    for (const channelId of this.sourceChannelIds) {
      try {
        const resolveRef = `-100${channelId}`;
        const entity = await client.getEntity(resolveRef);

        // Oxirgi xabarlarni olish (limit: 10)
        const messages = await client.getMessages(entity, { limit: 10 });

        if (!messages || messages.length === 0) {
          continue;
        }

        // Oxirgi tekshirilgan message ID ni olish
        const lastCheckedId = this.lastCheckedMessageIds.get(channelId) || 0;

        // Yangi xabarlarni filtrlash
        const newMessages = messages.filter(
          (msg) => msg instanceof Api.Message && msg.id > lastCheckedId,
        ) as any[];

        if (newMessages.length > 0) {
          this.logger.log(
            `Polling: ${newMessages.length} ta yangi xabar topildi — kanal: ${channelId}`,
          );

          // Eng yangi message ID ni saqlash
          const maxId = Math.max(...newMessages.map((msg) => msg.id));
          this.lastCheckedMessageIds.set(channelId, maxId);

          // Xabarlarni qayta ishlash (eskidan yangiga)
          const sortedMessages = [...newMessages].sort((a, b) => a.id - b.id);

          for (const message of sortedMessages) {
            // Agar allaqachon barcha maqsadlarga forward qilingan bo'lsa, o'tkazib yuborish
            if (this.isAlreadyForwardedToAnyDestination(channelId, message.id)) {
              continue;
            }

            // Album xabarlarini guruhlash
            if (message.groupedId) {
              this.bufferAlbumMessage(message, channelId);
            } else {
              await this.forwardMessages([message], channelId);
            }
          }
        } else {
          // Oxirgi message ID ni yangilash (agar yangi xabar bo'lmasa ham)
          if (messages.length > 0 && messages[0] instanceof Api.Message) {
            const latestId = messages[0].id;
            const currentLastChecked =
              this.lastCheckedMessageIds.get(channelId) || 0;
            if (latestId > currentLastChecked) {
              this.lastCheckedMessageIds.set(channelId, latestId);
            }
          }
        }
      } catch (error: unknown) {
        this.logger.warn(
          `Polling xatosi — kanal: ${channelId}: ${this.getErrorMessage(error)}`,
        );
      }
    }
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.logger.log("Polling mexanizmi to'xtatildi");
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  private async handleNewMessage(event: NewMessageEvent): Promise<void> {
    const { message } = event;

    if (!(message instanceof Api.Message) || !message.peerId) {
      return;
    }

    const sourceChannelId = this.extractComparableChannelId(message.peerId);

    // Debug log - xabar qaysi kanaldan kelganini ko'rish uchun
    this.logger.debug(
      `Yangi xabar: kanal ID=${sourceChannelId}, xabar ID=${message.id}`,
    );

    if (!sourceChannelId) {
      this.logger.warn(
        `Channel ID aniqlanmadi: peerId type=${message.peerId.constructor.name}`,
      );
      return;
    }

    if (!this.sourceChannelIds.includes(sourceChannelId)) {
      this.logger.debug(
        `Xabar o'tkazib yuborildi - kanal kuzatilmaydi: ${sourceChannelId}. Kuzatilayotganlar: [${this.sourceChannelIds.join(', ')}]`,
      );
      return;
    }

    if (this.isAlreadyForwardedToAnyDestination(sourceChannelId, message.id)) {
      this.logger.warn(
        `Takror xabar o'tkazib yuborildi: ${sourceChannelId}:${message.id}`,
      );
      return;
    }

    // Oxirgi tekshirilgan message ID ni yangilash
    const currentLastChecked =
      this.lastCheckedMessageIds.get(sourceChannelId) || 0;
    if (message.id > currentLastChecked) {
      this.lastCheckedMessageIds.set(sourceChannelId, message.id);
    }

    this.logger.log(
      `Yangi xabar qabul qilindi: kanal=${sourceChannelId}, xabar=${message.id}`,
    );

    if (message.groupedId) {
      this.bufferAlbumMessage(message, sourceChannelId);
      return;
    }

    await this.forwardMessages([message], sourceChannelId);
  }

  private bufferAlbumMessage(
    message: Api.Message,
    sourceChannelId: string,
  ): void {
    const groupKey = `${sourceChannelId}:${message.groupedId?.toString()}`;
    const existing = this.albumBuffer.get(groupKey);

    if (existing) {
      clearTimeout(existing.timer);
      if (
        !existing.messages.some(
          (bufferedMessage) => bufferedMessage.id === message.id,
        )
      ) {
        existing.messages.push(message);
      }
      existing.timer = this.scheduleAlbumFlush(groupKey, sourceChannelId);
    } else {
      const timer = this.scheduleAlbumFlush(groupKey, sourceChannelId);
      this.albumBuffer.set(groupKey, { messages: [message], timer });
    }
  }

  private scheduleAlbumFlush(
    groupKey: string,
    sourceChannelId: string,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      void this.flushAlbum(groupKey, sourceChannelId);
    }, this.albumFlushDelayMs);
  }

  private async flushAlbum(
    groupKey: string,
    sourceChannelId: string,
  ): Promise<void> {
    const buffered = this.albumBuffer.get(groupKey);
    this.albumBuffer.delete(groupKey);
    if (!buffered || buffered.messages.length === 0) {
      return;
    }

    const messages = [...buffered.messages]
      .sort((left, right) => left.id - right.id)
      .filter(
        (message, index, items) =>
          index === items.findIndex((item) => item.id === message.id),
      );
    const pendingMessages = messages.filter(
      (message) => !this.isAlreadyForwardedToAnyDestination(sourceChannelId, message.id),
    );

    if (pendingMessages.length === 0) {
      this.logger.warn(`Album o'tkazib yuborildi: ${groupKey}`);
      return;
    }

    this.logger.log(
      `Album yuborilmoqda (${pendingMessages.length} ta xabar) — kanal: ${sourceChannelId}`,
    );

    await this.forwardMessages(pendingMessages, sourceChannelId);
  }

  private async forwardMessages(
    messages: Api.Message[],
    sourceChannelId: string,
  ): Promise<void> {
    const pendingMessages = messages.filter(
      (message) => !this.isAlreadyForwardedToAnyDestination(sourceChannelId, message.id),
    );

    if (pendingMessages.length === 0) {
      return;
    }

    if (this.destinationPeers.size === 0) {
      await this.resolveDestinationPeers();
    }

    if (this.destinationPeers.size === 0) {
      const errorMessage =
        'Hech qanday maqsadli kanal resolve qilinmadi. Kanallarni shu akkaunt bilan oching yoki public username ishlating.';
      this.logger.error(errorMessage);

      for (const message of pendingMessages) {
        for (const destRef of this.destinationChannelRefs) {
          const destId = this.extractChannelIdFromRef(destRef);
          this.recordForwardAttempt({
            sourceChannelId,
            sourceMessageId: message.id,
            destinationChannelId: destId,
            destinationMessageId: null,
            status: 'failed',
            error: errorMessage,
            forwardedAt: new Date().toISOString(),
          });
        }
      }
      return;
    }

    const messageIds = pendingMessages.map((message) => message.id);
    this.logger.log(
      `Copy boshlanmoqda — kanal: ${sourceChannelId}, xabarlar: ${messageIds.join(', ')} → ${this.destinationPeers.size} ta maqsadga`,
    );

    let successCount = 0;
    let failCount = 0;

    for (const [destId, destPeer] of this.destinationPeers.entries()) {
      // Filter messages not yet forwarded to this specific destination
      const messagesToForward = pendingMessages.filter(
        (message) => !this.isAlreadyForwarded(sourceChannelId, message.id, destId),
      );

      if (messagesToForward.length === 0) {
        this.logger.debug(
          `Barcha xabarlar allaqachon ${destId} ga yuborilgan, o'tkazib yuborildi`,
        );
        continue;
      }

      try {
        const result = await this.sendMessagesAsCopies(messagesToForward, destPeer);
        const sentMessages = this.normalizeForwardResult(result);

        for (let i = 0; i < messagesToForward.length; i++) {
          const sentMessage = sentMessages[i];
          this.recordForwardAttempt({
            sourceChannelId,
            sourceMessageId: messagesToForward[i].id,
            destinationChannelId: destId,
            destinationMessageId: sentMessage?.id ?? null,
            status: 'success',
            forwardedAt: new Date().toISOString(),
          });
        }

        successCount++;
        this.logger.log(
          `  ✓ Maqsad ${successCount}/${this.destinationPeers.size}: ${messagesToForward.length} ta xabar yuborildi (dest: ${destId})`,
        );
      } catch (error: any) {
        failCount++;
        await this.handleForwardError(error, messagesToForward, sourceChannelId, destId);
      }
    }

    this.logger.log(
      `✓ Forward tugadi: ${successCount} muvaffaqiyatli, ${failCount} xato`,
    );
  }

  private isAlreadyForwardedToAnyDestination(
    sourceChannelId: string,
    sourceMessageId: number,
  ): boolean {
    // Check if forwarded to ALL destinations
    for (const [destId] of this.destinationPeers.entries()) {
      if (!this.isAlreadyForwarded(sourceChannelId, sourceMessageId, destId)) {
        return false;
      }
    }
    return this.destinationPeers.size > 0;
  }

  private async sendMessagesAsCopies(
    messages: Api.Message[],
    destinationPeer: Api.TypeInputPeer,
  ): Promise<Api.Message | Array<Api.Message | undefined>> {
    const client = this.telegramService.getClient();

    // Separate media messages from text-only messages
    const mediaMessages = messages.filter((msg) => msg.media && !(msg.media instanceof Api.MessageMediaWebPage));
    const textOnlyMessages = messages.filter((msg) => !msg.media || msg.media instanceof Api.MessageMediaWebPage);

    const results: Array<Api.Message | undefined> = [];

    // Send album (multiple media messages together)
    if (mediaMessages.length > 1) {
      const translatedCaptions = await Promise.all(
        mediaMessages.map(async (message, index) => {
          const translated = await this.translateText(message.message ?? '', message.id);
          // Only add signature to the first media message (which has the main caption)
          if (index === 0) {
            return this.truncateCaptionIfNeeded(translated); // Signature already added by translateText
          }
          // For other media in album, don't add signature (they usually have empty captions)
          return message.message ? this.truncateCaptionIfNeeded(translated) : '';
        }),
      );
      const uploadFiles = await Promise.all(
        mediaMessages.map((message) => this.downloadMediaAsUploadFile(message)),
      );

      this.logger.log(
        `Album fresh-upload rejimida yuborilmoqda: ${mediaMessages.length} ta media`,
      );
      const albumResult = await client.sendFile(destinationPeer, {
        file: uploadFiles,
        caption: translatedCaptions,
        parseMode: false,
        silent: mediaMessages[0].silent,
      });

      const normalizedAlbum = this.normalizeForwardResult(albumResult);
      results.push(...normalizedAlbum);
    } else if (mediaMessages.length === 1) {
      // Send single media message
      const sentMedia = await this.sendSingleMessageAsCopy(mediaMessages[0], destinationPeer);
      results.push(sentMedia);
    }

    // Send text-only messages separately
    for (const textMessage of textOnlyMessages) {
      const sentText = await this.sendSingleMessageAsCopy(textMessage, destinationPeer);
      results.push(sentText);
    }

    return results;
  }

  private async sendSingleMessageAsCopy(
    message: Api.Message,
    destinationPeer: Api.TypeInputPeer,
  ): Promise<Api.Message> {
    const client = this.telegramService.getClient();

    const translatedText = await this.translateText(
      message.message ?? '',
      message.id,
    );

    if (message.media && !(message.media instanceof Api.MessageMediaWebPage)) {
      const uploadFile = await this.downloadMediaAsUploadFile(message);

      return client.sendFile(destinationPeer, {
        file: uploadFile,
        caption: this.truncateCaptionIfNeeded(translatedText),
        parseMode: false,
        silent: message.silent,
      });
    }

    const textToSend = translatedText || message.message || ' ';

    return client.sendMessage(destinationPeer, {
      message: textToSend,
      parseMode: false,
      linkPreview: message.media instanceof Api.MessageMediaWebPage,
      silent: message.silent,
    });
  }

  private async downloadMediaAsUploadFile(
    message: Api.Message,
  ): Promise<CustomFile> {
    const client = this.telegramService.getClient();
    const downloadedMedia = await client.downloadMedia(message, {});

    if (!downloadedMedia || typeof downloadedMedia === 'string') {
      throw new Error(`Media yuklab olinmadi: ${message.id}`);
    }

    const extension = this.getMediaExtension(message);
    const fileName = `message-${message.id}${extension}`;

    this.logger.log(`Media qayta upload uchun tayyorlandi: ${fileName}`);

    return new CustomFile(
      fileName,
      downloadedMedia.length,
      '',
      downloadedMedia,
    );
  }

  private getMediaExtension(message: Api.Message): string {
    const rawExtension = utils.getExtension(message.media);

    if (!rawExtension) {
      return '.bin';
    }

    return rawExtension.startsWith('.') ? rawExtension : `.${rawExtension}`;
  }

  private removeChannelLinks(text: string): string {
    if (!text) return text;

    const cleanedText = text.replace(/(@[a-zA-Z0-9_]+\s*)+$/g, '');

    return cleanedText.trim();
  }

  private async translateText(
    text: string,
    sourceMessageId: number,
  ): Promise<string> {
    if (!text.trim()) {
      return this.addChannelSignature('');
    }

    const cleanOriginalText = this.removeChannelLinks(text);

    if (!cleanOriginalText.trim()) {
      return this.addChannelSignature('');
    }

    this.logger.log(
      `Tarjima qilinmoqda — xabar ID: ${sourceMessageId}, til: ${this.translateTo}`,
    );

    try {
      const result = await translate(cleanOriginalText, {
        to: this.translateTo,
        client: this.translateClient,
      });

      if (
        Array.isArray(result) ||
        typeof result !== 'object' ||
        result === null ||
        !('text' in result) ||
        typeof result.text !== 'string'
      ) {
        return this.addChannelSignature(cleanOriginalText);
      }

      const translatedText = result.text.trim();
      if (!translatedText) {
        return this.addChannelSignature(cleanOriginalText);
      }

      const finalResult = this.removeChannelLinks(translatedText);

      this.logger.log(`Tarjima tayyor — xabar ID: ${sourceMessageId}`);
      return this.addChannelSignature(finalResult);
    } catch (error: unknown) {
      this.logger.warn(
        `Tarjima xatosi — xabar ID: ${sourceMessageId}: ${this.getErrorMessage(error)}`,
      );
      return this.addChannelSignature(cleanOriginalText);
    }
  }

  private addChannelSignature(text: string): string {
    const signature = '\n\n@WatcherGuruUzb';

    if (!text || !text.trim()) {
      return signature.trim();
    }

    return text + signature;
  }

  private truncateCaptionIfNeeded(caption: string): string {
    if (caption.length <= this.MAX_CAPTION_LENGTH) {
      return caption;
    }

    const signature = '\n\n@WatcherGuruUzb';
    const ellipsis = '...';
    const maxTextLength = this.MAX_CAPTION_LENGTH - signature.length - ellipsis.length;

    if (maxTextLength <= 0) {
      // If signature itself is too long, just return truncated signature
      return signature.substring(0, this.MAX_CAPTION_LENGTH);
    }

    const truncatedText = caption.substring(0, maxTextLength);
    const result = truncatedText + ellipsis + signature;

    this.logger.warn(
      `Caption qisqartirildi: ${caption.length} → ${result.length} belgi`,
    );

    return result;
  }

  private async handleForwardError(
    error: any,
    messages: Api.Message[],
    sourceChannelId: string,
    destinationChannelId: string,
  ): Promise<void> {
    const errorName: string = error?.constructor?.name ?? 'UnknownError';
    const errorMessage = this.getErrorMessage(error);

    if (errorName === 'FloodWaitError' && typeof error.seconds === 'number') {
      const waitSeconds: number = error.seconds;
      this.logger.warn(`FloodWait: ${waitSeconds} soniya kutilmoqda...`);

      await new Promise<void>((resolve) =>
        setTimeout(resolve, (waitSeconds + 1) * 1000),
      );

      this.logger.log('FloodWait tugadi. Qayta urinilmoqda...');

      // Retry for this specific destination
      const destPeer = this.destinationPeers.get(destinationChannelId);
      if (destPeer) {
        try {
          const result = await this.sendMessagesAsCopies(messages, destPeer);
          const sentMessages = this.normalizeForwardResult(result);

          for (let i = 0; i < messages.length; i++) {
            const sentMessage = sentMessages[i];
            this.recordForwardAttempt({
              sourceChannelId,
              sourceMessageId: messages[i].id,
              destinationChannelId,
              destinationMessageId: sentMessage?.id ?? null,
              status: 'success',
              forwardedAt: new Date().toISOString(),
            });
          }
        } catch (retryError: any) {
          this.logger.error(
            `Qayta urinishda xato (dest: ${destinationChannelId}): ${this.getErrorMessage(retryError)}`,
          );
          for (const message of messages) {
            this.recordForwardAttempt({
              sourceChannelId,
              sourceMessageId: message.id,
              destinationChannelId,
              destinationMessageId: null,
              status: 'failed',
              error: `${errorName}: ${errorMessage}`.slice(0, 500),
              forwardedAt: new Date().toISOString(),
            });
          }
        }
      }
      return;
    }

    this.logger.error(
      `Xabar yuborishda xato (dest: ${destinationChannelId}) [${errorName}]: ${errorMessage}`,
    );

    const hint = this.buildErrorHint(errorMessage);
    if (hint) {
      this.logger.error(`Yechim: ${hint}`);
    }

    for (const message of messages) {
      this.recordForwardAttempt({
        sourceChannelId,
        sourceMessageId: message.id,
        destinationChannelId,
        destinationMessageId: null,
        status: 'failed',
        error: `${errorName}: ${errorMessage}`.slice(0, 500),
        forwardedAt: new Date().toISOString(),
      });
    }
  }

  private async resolveDestinationPeers(): Promise<void> {
    const client = this.telegramService.getClient();

    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.log(
      `Maqsadli kanallar (${this.destinationChannelRefs.length} ta):`,
    );

    for (const destRef of this.destinationChannelRefs) {
      try {
        const peer = await client.getInputEntity(destRef);
        const entity = await client.getEntity(peer);

        // Extract channel ID for the Map key
        const channelId = this.extractChannelIdFromRef(destRef);
        this.destinationPeers.set(channelId, peer);

        this.logger.log(
          `  ✓ ${this.describeEntity(entity)} (ref: ${destRef})`,
        );
      } catch (error: unknown) {
        this.logger.error(
          `  ✗ Maqsadli kanal resolve bo'lmadi (${destRef}): ${this.getErrorMessage(error)}`,
        );

        const hint = this.buildErrorHint(this.getErrorMessage(error));
        if (hint) {
          this.logger.error(`    Yechim: ${hint}`);
        }
      }
    }

    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (this.destinationPeers.size === 0) {
      this.logger.error(
        'Hech qanday maqsadli kanal resolve qilinmadi! Botni to\'xtatish kerak.',
      );
    } else {
      this.logger.log(
        `${this.destinationPeers.size}/${this.destinationChannelRefs.length} ta maqsadli kanal tayyor`,
      );
    }
  }

  private extractChannelIdFromRef(ref: string): string {
    // Extract a comparable ID from the reference for use as Map key
    if (ref.startsWith('-100')) {
      return ref.substring(4); // Remove -100 prefix
    }
    if (ref.startsWith('-')) {
      return ref.substring(1); // Remove - prefix
    }
    if (ref.startsWith('@') || ref.includes('t.me/')) {
      return ref; // Use username/link as-is
    }
    return ref;
  }

  private loadForwardHistory(): void {
    if (!fs.existsSync(this.logFilePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.logFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as ForwardRecord[];
      this.forwardHistory = Array.isArray(parsed) ? parsed : [];

      for (const entry of this.forwardHistory) {
        if (entry.status === 'success') {
          // Handle both old format (without destinationChannelId) and new format
          const destId = entry.destinationChannelId || 'legacy';
          this.forwardedKeys.add(
            this.makeForwardKey(entry.sourceChannelId, entry.sourceMessageId, destId),
          );
        }
      }

      this.logger.log(
        `Avvalgi ${this.forwardedKeys.size} ta forward ID yuklandi`,
      );
    } catch (error: unknown) {
      this.forwardHistory = [];
      this.forwardedKeys.clear();
      this.logger.warn(
        `forwarded-ids.json o'qishda xato: ${this.getErrorMessage(error)}`,
      );
    }
  }

  private recordForwardAttempt(record: ForwardRecord): void {
    this.forwardHistory.push(record);

    if (record.status === 'success') {
      this.forwardedKeys.add(
        this.makeForwardKey(record.sourceChannelId, record.sourceMessageId, record.destinationChannelId),
      );
    }

    try {
      fs.writeFileSync(
        this.logFilePath,
        JSON.stringify(this.forwardHistory, null, 2),
        'utf-8',
      );
    } catch (error: unknown) {
      this.logger.error(
        `forwarded-ids.json yozishda xato: ${this.getErrorMessage(error)}`,
      );
    }
  }

  private normalizeDestinationReference(rawValue: string): string {
    const value = rawValue.trim();
    if (!value) {
      throw new Error("DESTINATION_CHANNEL_ID bo'sh");
    }

    if (value.startsWith('@') || value.includes('t.me/')) {
      return value;
    }

    if (/^-100\d+$/.test(value) || /^-\d+$/.test(value)) {
      return value;
    }

    if (/^100\d+$/.test(value)) {
      return `-${value}`;
    }

    if (/^\d+$/.test(value)) {
      return `-100${value}`;
    }

    throw new Error(`DESTINATION_CHANNEL_ID noto'g'ri: ${value}`);
  }

  private normalizeComparableChannelId(rawValue: string): string {
    const value = rawValue.trim();

    // -100 prefiksini olib tashlash
    let normalized = value.replace(/^-100/, '');

    // Oddiy - prefiksini olib tashlash
    normalized = normalized.replace(/^-/, '');

    if (!/^\d+$/.test(normalized)) {
      throw new Error(`SOURCE_CHANNEL_IDS noto'g'ri: ${value}`);
    }

    this.logger.debug(`Channel ID normalizatsiya: ${value} -> ${normalized}`);

    return normalized;
  }

  private extractComparableChannelId(peerId: Api.TypePeer): string | null {
    if (peerId instanceof Api.PeerChannel) {
      const channelId = peerId.channelId.toString();
      this.logger.debug(`PeerChannel aniqlandi: ${channelId}`);
      return channelId;
    }

    if (peerId instanceof Api.PeerChat) {
      const chatId = peerId.chatId.toString();
      this.logger.debug(`PeerChat aniqlandi: ${chatId}`);
      return chatId;
    }

    if (peerId instanceof Api.PeerUser) {
      this.logger.debug("PeerUser - o'tkazib yuborildi");
      return null;
    }

    this.logger.warn(
      `Noma'lum peer turi: ${(peerId as any).constructor?.name ?? 'Unknown'}`,
    );
    return null;
  }

  private isAlreadyForwarded(
    sourceChannelId: string,
    sourceMessageId: number,
    destinationChannelId: string,
  ): boolean {
    return this.forwardedKeys.has(
      this.makeForwardKey(sourceChannelId, sourceMessageId, destinationChannelId),
    );
  }

  private makeForwardKey(
    sourceChannelId: string,
    sourceMessageId: number,
    destinationChannelId: string,
  ): string {
    return `${sourceChannelId}:${sourceMessageId}:${destinationChannelId}`;
  }

  private normalizeForwardResult(
    result: unknown,
  ): Array<Api.Message | undefined> {
    if (!Array.isArray(result)) {
      return result instanceof Api.Message ? [result] : [];
    }

    return result.flatMap((item) => {
      if (Array.isArray(item)) {
        return item.filter(
          (message): message is Api.Message => message instanceof Api.Message,
        );
      }

      return item instanceof Api.Message ? [item] : [undefined];
    });
  }

  private describeEntity(entity: unknown): string {
    if (entity instanceof Api.Channel || entity instanceof Api.Chat) {
      return `${entity.title} (ID: ${entity.id.toString()})`;
    }

    if (entity instanceof Api.User) {
      return `${entity.firstName ?? 'User'} (ID: ${entity.id.toString()})`;
    }

    return 'UnknownEntity';
  }

  private buildErrorHint(errorMessage: string): string | null {
    const normalizedMessage = errorMessage.toUpperCase();

    if (
      normalizedMessage.includes('CHAT_WRITE_FORBIDDEN') ||
      normalizedMessage.includes('CHAT_ADMIN_REQUIRED')
    ) {
      return "Userbot account destination kanalda admin bo'lishi yoki post yozish huquqiga ega bo'lishi kerak.";
    }

    if (normalizedMessage.includes('CHANNEL_PRIVATE')) {
      return "Userbot account source va destination private kanallarga a'zo bo'lishi kerak.";
    }

    if (
      normalizedMessage.includes('PEER_ID_INVALID') ||
      normalizedMessage.includes('INPUT ENTITY') ||
      normalizedMessage.includes('CANNOT FIND ANY ENTITY')
    ) {
      return "Kanal ID yoki username noto'g'ri bo'lishi mumkin. Destination kanalni shu akkaunt bilan oching yoki public @username ishlating.";
    }

    if (normalizedMessage.includes('USER_BANNED_IN_CHANNEL')) {
      return 'Userbot account kanalda ban qilingan. Boshqa account yoki ruxsat kerak.';
    }

    return null;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    return "Noma'lum xato";
  }

  private logUnexpectedError(context: string, error: unknown): void {
    if (error instanceof Error) {
      this.logger.error(`${context}: ${error.message}`, error.stack);
      return;
    }

    this.logger.error(`${context}: ${this.getErrorMessage(error)}`);
  }
}
