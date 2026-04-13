import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { ConfigModule } from '@nestjs/config';
import { UserBotModule } from '../user-bot/userbot.module';

@Module({
  imports: [ConfigModule, UserBotModule], // Userbot bilan bog'lash uchun
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
