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

  private sourceChannelIds: string[] = [];
  private destinationChannelRef = '';
  private destinationPeer: Api.TypeInputPeer | null = null;
  private translateTo = 'uz';
  private readonly forwardedKeys = new Set<string>();
  private forwardHistory: ForwardRecord[] = [];

  // Album grouping: groupedId → { messages, timer }
  private albumBuffer = new Map<
    string,
    { messages: Api.Message[]; timer: NodeJS.Timeout }
  >();

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
    const rawDestId =
      this.configService.get<string>('DESTINATION_CHANNEL_ID') ?? '';
    const rawTranslateTo =
      this.configService.get<string>('TRANSLATE_TO')?.trim() ?? '';

    if (!rawSourceIds || !rawDestId) {
      this.logger.error(
        'SOURCE_CHANNEL_IDS yoki DESTINATION_CHANNEL_ID .env da topilmadi!',
      );
      return;
    }

    if (rawTranslateTo) {
      this.translateTo = rawTranslateTo;
    }

    this.destinationChannelRef = this.normalizeDestinationReference(rawDestId);
    this.sourceChannelIds = rawSourceIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => this.normalizeComparableChannelId(id));

    this.logger.log(
      `Kuzatilayotgan kanallar: ${this.sourceChannelIds.join(', ')}`,
    );
    this.logger.log(`Maqsadli kanal: ${this.destinationChannelRef}`);
    this.logger.log(`Tarjima tili: ${this.translateTo}`);

    const client = this.telegramService.getClient();

    try {
      await client.getDialogs({ limit: 200 });
    } catch (error: unknown) {
      this.logger.warn(
        `Dialog cache yuklanmadi: ${this.getErrorMessage(error)}`,
      );
    }

    await this.resolveDestinationPeer();

    client.addEventHandler(this.onNewMessageEvent, new NewMessage({}));

    this.logger.log('Forwarder tayyor — yangi postlarni kutmoqda...');
  }

  private async handleNewMessage(event: NewMessageEvent): Promise<void> {
    const { message } = event;
    // console.log(message);
    if (!(message instanceof Api.Message) || !message.peerId) {
      return;
    }

    const sourceChannelId = this.extractComparableChannelId(message.peerId);
    if (!sourceChannelId || !this.sourceChannelIds.includes(sourceChannelId)) {
      return;
    }

    if (this.isAlreadyForwarded(sourceChannelId, message.id)) {
      this.logger.warn(
        `Takror xabar o'tkazib yuborildi: ${sourceChannelId}:${message.id}`,
      );
      return;
    }

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
      (message) => !this.isAlreadyForwarded(sourceChannelId, message.id),
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
      (message) => !this.isAlreadyForwarded(sourceChannelId, message.id),
    );

    if (pendingMessages.length === 0) {
      return;
    }

    if (!this.destinationPeer) {
      await this.resolveDestinationPeer();
    }

    if (!this.destinationPeer) {
      const errorMessage =
        'Maqsadli kanal resolve qilinmadi. Kanalni shu akkaunt bilan oching yoki public username ishlating.';
      this.logger.error(errorMessage);

      for (const message of pendingMessages) {
        this.recordForwardAttempt({
          sourceChannelId,
          sourceMessageId: message.id,
          destinationMessageId: null,
          status: 'failed',
          error: errorMessage,
          forwardedAt: new Date().toISOString(),
        });
      }
      return;
    }

    const messageIds = pendingMessages.map((message) => message.id);
    this.logger.log(
      `Copy boshlanmoqda — kanal: ${sourceChannelId}, xabarlar: ${messageIds.join(', ')}`,
    );

    try {
      const result = await this.sendMessagesAsCopies(pendingMessages);

      const sentMessages = this.normalizeForwardResult(result);

      for (let i = 0; i < messageIds.length; i++) {
        const sentMessage = sentMessages[i];
        this.recordForwardAttempt({
          sourceChannelId,
          sourceMessageId: messageIds[i],
          destinationMessageId: sentMessage?.id ?? null,
          status: 'success',
          forwardedAt: new Date().toISOString(),
        });
      }

      this.logger.log(
        `✓ ${messageIds.length} ta xabar muvaffaqiyatli yuborildi`,
      );
    } catch (error: any) {
      await this.handleForwardError(error, pendingMessages, sourceChannelId);
    }
  }

  private async sendMessagesAsCopies(
    messages: Api.Message[],
  ): Promise<Api.Message | Array<Api.Message | undefined>> {
    const client = this.telegramService.getClient();

    if (!this.destinationPeer) {
      throw new Error('Destination peer topilmadi');
    }

    if (messages.length > 1 && messages.every((message) => message.media)) {
      const translatedCaptions = await Promise.all(
        messages.map((message) =>
          this.translateText(message.message ?? '', message.id),
        ),
      );
      const uploadFiles = await Promise.all(
        messages.map((message) => this.downloadMediaAsUploadFile(message)),
      );

      this.logger.log(
        `Album fresh-upload rejimida yuborilmoqda: ${messages.length} ta`,
      );
      const result = await client.sendFile(this.destinationPeer, {
        file: uploadFiles,
        caption: translatedCaptions,
        parseMode: false,
        silent: messages[0].silent,
      });

      return this.normalizeForwardResult(result);
    }

    const sentMessages = await Promise.all(
      messages.map((message) => this.sendSingleMessageAsCopy(message)),
    );

    return sentMessages;
  }

  private async sendSingleMessageAsCopy(
    message: Api.Message,
  ): Promise<Api.Message> {
    const client = this.telegramService.getClient();

    if (!this.destinationPeer) {
      throw new Error('Destination peer topilmadi');
    }

    const translatedText = await this.translateText(
      message.message ?? '',
      message.id,
    );

    if (message.media && !(message.media instanceof Api.MessageMediaWebPage)) {
      const uploadFile = await this.downloadMediaAsUploadFile(message);

      return client.sendFile(this.destinationPeer, {
        file: uploadFile,
        caption: translatedText,
        parseMode: false,
        silent: message.silent,
      });
    }

    const textToSend = translatedText || message.message || ' ';

    return client.sendMessage(this.destinationPeer, {
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

    // Xabar oxiridagi @username larni topish (va ulardan keyingi bo'shliqlarni)
    // Bu regex faqat xabar oxiridagi qatorlarda kelgan @belgilarni o'chiradi
    const cleanedText = text.replace(/(@[a-zA-Z0-9_]+\s*)+$/g, '');

    return cleanedText.trim();
  }
  private async translateText(
    text: string,
    sourceMessageId: number,
  ): Promise<string> {
    if (!text.trim()) {
      return text;
    }

    // 1. Avval kanal linklarini (oxiridagilarini) o'chirib tashlaymiz
    const cleanOriginalText = this.removeChannelLinks(text);

    // Agar linklar o'chgandan keyin matn bo'sh bo'lib qolsa (faqat link bo'lgan bo'lsa)
    if (!cleanOriginalText.trim()) {
      return '';
    }

    this.logger.log(
      `Tarjima qilinmoqda — xabar ID: ${sourceMessageId}, til: ${this.translateTo}`,
    );

    try {
      const result = await translate(cleanOriginalText, {
        // Tozalangan matnni yuboramiz
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
        return cleanOriginalText; // Xato bo'lsa tozalanganini qaytaramiz
      }

      const translatedText = result.text.trim();
      if (!translatedText) {
        return cleanOriginalText;
      }

      // 2. Tarjima qilingan matnning oxirida ham ba'zan link qolib ketishi mumkin
      // (tarjimon xatosi tufayli), yana bir bor tekshirib yuboramiz
      const finalResult = this.removeChannelLinks(translatedText);

      this.logger.log(`Tarjima tayyor — xabar ID: ${sourceMessageId}`);
      return finalResult;
    } catch (error: unknown) {
      this.logger.warn(
        `Tarjima xatosi — xabar ID: ${sourceMessageId}: ${this.getErrorMessage(error)}`,
      );
      return cleanOriginalText;
    }
  }

  private async handleForwardError(
    error: any,
    messages: Api.Message[],
    sourceChannelId: string,
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
      await this.forwardMessages(messages, sourceChannelId);
      return;
    }

    this.logger.error(`Xabar yuborishda xato [${errorName}]: ${errorMessage}`);

    const hint = this.buildErrorHint(errorMessage);
    if (hint) {
      this.logger.error(`Yechim: ${hint}`);
    }

    for (const message of messages) {
      this.recordForwardAttempt({
        sourceChannelId,
        sourceMessageId: message.id,
        destinationMessageId: null,
        status: 'failed',
        error: `${errorName}: ${errorMessage}`.slice(0, 500),
        forwardedAt: new Date().toISOString(),
      });
    }
  }

  private async resolveDestinationPeer(): Promise<void> {
    const client = this.telegramService.getClient();

    try {
      this.destinationPeer = await client.getInputEntity(
        this.destinationChannelRef,
      );
      const destinationEntity = await client.getEntity(this.destinationPeer);
      this.logger.log(
        `Destination resolve bo'ldi: ${this.describeEntity(destinationEntity)}`,
      );
    } catch (error: unknown) {
      this.destinationPeer = null;
      this.logger.error(
        `Maqsadli kanal resolve bo'lmadi (${this.destinationChannelRef}): ${this.getErrorMessage(error)}`,
      );

      const hint = this.buildErrorHint(this.getErrorMessage(error));
      if (hint) {
        this.logger.error(`Yechim: ${hint}`);
      }
    }
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
          this.forwardedKeys.add(
            this.makeForwardKey(entry.sourceChannelId, entry.sourceMessageId),
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
        this.makeForwardKey(record.sourceChannelId, record.sourceMessageId),
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
    const normalized = value.replace(/^-100/, '').replace(/^-/, '');

    if (!/^\d+$/.test(normalized)) {
      throw new Error(`SOURCE_CHANNEL_IDS noto'g'ri: ${value}`);
    }

    if (/^100\d+$/.test(value)) {
      return value.slice(3);
    }

    return normalized;
  }

  private extractComparableChannelId(peerId: Api.TypePeer): string | null {
    if (peerId instanceof Api.PeerChannel) {
      return peerId.channelId.toString();
    }

    if (peerId instanceof Api.PeerChat) {
      return peerId.chatId.toString();
    }

    return null;
  }

  private isAlreadyForwarded(
    sourceChannelId: string,
    sourceMessageId: number,
  ): boolean {
    return this.forwardedKeys.has(
      this.makeForwardKey(sourceChannelId, sourceMessageId),
    );
  }

  private makeForwardKey(
    sourceChannelId: string,
    sourceMessageId: number,
  ): string {
    return `${sourceChannelId}:${sourceMessageId}`;
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
      return `${entity.title} (${entity.id.toString()})`;
    }

    if (entity instanceof Api.User) {
      return `${entity.firstName ?? 'User'} (${entity.id.toString()})`;
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
