import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './modules/prisma/prisma.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { ForwarderModule } from './modules/forwarder/forwarder.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    TelegramModule,
    ForwarderModule,
  ],
})
export class AppModule {}
