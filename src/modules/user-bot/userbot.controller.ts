import { Controller, Get, Query } from '@nestjs/common';
import { UserBotService } from './userbot.service';

@Controller('userBot')
export class UserBotController {
  constructor(private readonly userBotService: UserBotService) {}

  // Brauzerda: http://localhost:3000/telegram/members?group=@guruh_nomi
  @Get('members')
  async getMembers(@Query('group') group: string) {
    if (!group) return { error: "Guruh username'ini kiriting" };

    const members = await this.userBotService.getGroupMembers(group);
    return {
      count: members.length,
      members: members,
    };
  }

  @Get('my-groups')
  async getMyGroups() {
    return await this.userBotService.getJoinedGroups();
  }
}
