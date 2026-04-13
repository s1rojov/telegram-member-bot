import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { UserBotModule } from './modules//user-bot/userbot.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), UserBotModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
