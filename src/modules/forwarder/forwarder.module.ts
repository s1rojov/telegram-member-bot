import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from '../telegram/telegram.module';
import { ForwarderService } from './forwarder.service';

@Module({
  imports: [ConfigModule, TelegramModule],
  providers: [ForwarderService],
})
export class ForwarderModule {}
