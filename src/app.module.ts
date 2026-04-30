import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from './modules/telegram/telegram.module';
import { ForwarderModule } from './modules/forwarder/forwarder.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TelegramModule,
    ForwarderModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
