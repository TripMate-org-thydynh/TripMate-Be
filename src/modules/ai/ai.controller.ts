import type { User } from '@prisma/client';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiService } from './ai.service';
import { CreateAIRequestDto } from './dto/ai-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
@ApiTags('AI')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('request')
  @ApiOperation({ summary: 'Tạo yêu cầu AI (lập lịch, recap, caption...)' })
  create(@CurrentUser() user: User, @Body() dto: CreateAIRequestDto) {
    return this.aiService.createRequest(
      user.id,
      dto.tripId,
      dto.type,
      dto.prompt,
    );
  }

  @Post('photo-location')
  @ApiOperation({
    summary:
      'Phân tích ảnh (base64) → toạ độ + tên địa điểm (EXIF → AI vision)',
  })
  photoLocation(
    @CurrentUser() user: User,
    @Body() dto: { imageBase64: string; mimeType?: string },
  ) {
    return this.aiService.photoLocation(
      user.id,
      dto.imageBase64,
      dto.mimeType ?? 'image/jpeg',
    );
  }

  @Get('my-requests')
  @ApiOperation({ summary: 'Lịch sử yêu cầu AI của tôi' })
  findAll(@CurrentUser() user: User) {
    return this.aiService.findAll(user.id);
  }

  // --- MODULE 10 AI FLOW ENDPOINTS ---

  @Get('trips/:tripId/personality')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Phân tích tính cách phượt thủ của cả nhóm' })
  getPersonality(
    @CurrentUser() user: User,
    @Param('tripId') tripId: string,
  ) {
    return this.aiService.getPersonalityRoast(user.id, tripId);
  }

  @Get('trips/:tripId/mood')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Đo lường tâm trạng và xung đột của Squad' })
  getMood(@CurrentUser() user: User, @Param('tripId') tripId: string) {
    return this.aiService.getSquadMood(user.id, tripId);
  }

  @Get('trips/:tripId/timeline')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Dòng thời gian gợi ý hành trình tự động bằng AI' })
  getTimeline(
    @CurrentUser() user: User,
    @Param('tripId') tripId: string,
  ) {
    return this.aiService.getRecommendationTimeline(user.id, tripId);
  }

  @Get('saved-prompts')
  @ApiOperation({ summary: 'Câu lệnh AI gợi ý sẵn (danh mục do team soạn)' })
  getSuggestedPrompts() {
    return this.aiService.getSuggestedPrompts();
  }

  @Get('generation-queue')
  @ApiOperation({ summary: 'Hàng chờ xử lý/render background bằng AI' })
  getQueue(@CurrentUser() user: User) {
    return this.aiService.getGenerationQueue(user.id);
  }

  @Get('trips/:tripId')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'AI requests của chuyến đi' })
  findByTrip(@Param('tripId') tripId: string) {
    return this.aiService.findByTrip(tripId);
  }
}
