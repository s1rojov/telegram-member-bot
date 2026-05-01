import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from '../telegram/telegram.module';
import { ForwarderService } from './forwarder.service';
// import { TestForwarderService } from './test-forwarder.service';

@Module({
  imports: [ConfigModule, TelegramModule],
  providers: [ForwarderService],
  // providers: [ForwarderService, TestForwarderService],
})
export class ForwarderModule {}
