import { Controller, Get, Query } from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  // Brauzerda: http://localhost:3000/telegram/members?group=@guruh_nomi
  @Get('members')
  async getMembers(@Query('group') group: string) {
    if (!group) return { error: "Guruh username'ini kiriting" };

    const members = await this.telegramService.getGroupMembers(group);
    return {
      count: members.length,
      members: members,
    };
  }

  @Get('my-groups')
  async getMyGroups() {
    return await this.telegramService.getJoinedGroups();
  }
}
