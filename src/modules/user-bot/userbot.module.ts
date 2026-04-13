import { Module } from '@nestjs/common';
import { UserBotService } from './userbot.service';
import { UserBotController } from './userbot.controller';

@Module({
  providers: [UserBotService],
  exports: [UserBotService], // Boshqa modullar ishlata olishi uchun
  controllers: [UserBotController],
})
export class UserBotModule {}
