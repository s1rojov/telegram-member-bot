import { Module } from '@nestjs/common';
import { UserBotService } from './telegram.service';
import { TelegramController } from './telegram.controller';

@Module({
  providers: [TelegramService],
  exports: [TelegramService], // Boshqa modullar ishlata olishi uchun
  controllers: [TelegramController],
})
export class TelegramModule {}
