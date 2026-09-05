import type { User } from '@prisma/client';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiService } from './ai.service';
import { CreateAIRequestDto } from './dto/ai-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
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
  photoLocation(@Body() dto: { imageBase64: string; mimeType?: string }) {
    return this.aiService.photoLocation(
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
  @ApiOperation({ summary: 'Phân tích tính cách phượt thủ của cả nhóm' })
  getPersonality(@Param('tripId') tripId: string) {
    return this.aiService.getPersonalityRoast(tripId);
  }

  @Get('trips/:tripId/mood')
  @ApiOperation({ summary: 'Đo lường tâm trạng và xung đột của Squad' })
  getMood(@Param('tripId') tripId: string) {
    return this.aiService.getSquadMood(tripId);
  }

  @Get('trips/:tripId/timeline')
  @ApiOperation({ summary: 'Dòng thời gian gợi ý hành trình tự động bằng AI' })
  getTimeline(@Param('tripId') tripId: string) {
    return this.aiService.getRecommendationTimeline(tripId);
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
  @ApiOperation({ summary: 'AI requests của chuyến đi' })
  findByTrip(@Param('tripId') tripId: string) {
    return this.aiService.findByTrip(tripId);
  }
}
