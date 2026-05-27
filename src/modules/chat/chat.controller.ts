import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { SendMessageDto, ReactionDto } from './dto/chat.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Chat')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @ApiOperation({ summary: 'Gửi tin nhắn vào squad chat' })
  send(
    @Param('tripId') tripId: string,
    @CurrentUser() user: any,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(tripId, user.id, dto);
  }

  @Get('search')
  @ApiOperation({ summary: 'Tìm kiếm tin nhắn trong squad chat' })
  @ApiQuery({ name: 'q', required: true, type: String })
  search(
    @Param('tripId') tripId: string,
    @Query('q') query: string,
  ) {
    return this.chatService.searchMessages(tripId, query);
  }

  @Get()
  @ApiOperation({ summary: 'Lấy lịch sử chat (cursor pagination)' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getMessages(
    @Param('tripId') tripId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: number,
  ) {
    return this.chatService.getMessages(tripId, cursor, limit ? +limit : 30);
  }

  @Post(':messageId/reactions')
  @ApiOperation({ summary: 'Thả cảm xúc tin nhắn (toggle)' })
  toggleReaction(
    @Param('messageId') messageId: string,
    @CurrentUser() user: any,
    @Body() dto: ReactionDto,
  ) {
    return this.chatService.toggleReaction(messageId, user.id, dto.emoji);
  }

  @Delete(':messageId')
  @ApiOperation({ summary: 'Xóa tin nhắn (soft delete)' })
  delete(@Param('messageId') messageId: string, @CurrentUser() user: any) {
    return this.chatService.deleteMessage(messageId, user.id);
  }
}
