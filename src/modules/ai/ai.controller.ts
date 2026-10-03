import type { User } from '@prisma/client';
import type { Response } from 'express';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { userOrIpTracker } from '../../common/throttle/user-tracker';
import { AiService } from './ai.service';
import { CreateAIRequestDto } from './dto/ai-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AiCorrectionsService } from './ai-corrections.service';
import { AiEmbeddingService } from './ai-embedding.service';
import { SubmitCorrectionDto } from './dto/correction.dto';
// Mỗi lời gọi ở đây là tiền trả cho Gemini; giới hạn chặt hơn mức chung 100/phút
// để một phiên không đốt hạn mức bằng request song song.
const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

@Throttle({
  default: { limit: 30, ttl: 60000, getTracker: userOrIpTracker },
})
@ApiTags('AI')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly corrections: AiCorrectionsService,
    private readonly embeddings: AiEmbeddingService,
  ) {}

  /**
   * Matey trả lời theo kiểu chảy chữ (SSE).
   *
   * Dùng SSE thủ công thay vì `@Sse` của Nest vì `@Sse` bắt buộc phương thức
   * GET, mà câu hỏi kèm lịch sử hội thoại thì phải đi trong thân yêu cầu —
   * nhét cả đoạn chat vào query string là vừa vỡ giới hạn độ dài URL vừa
   * đẩy nội dung riêng tư vào log máy chủ.
   */
  @Post('chat/stream')
  @ApiOperation({ summary: 'Matey trả lời chảy từng mẩu chữ (SSE)' })
  async chatStream(
    @CurrentUser() user: User,
    @Body() dto: CreateAIRequestDto,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx mặc định gom đệm phản hồi, chảy chữ sẽ thành trả một cục.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const piece of this.aiService.chatStream(
        user.id,
        dto.tripId,
        dto.prompt,
        dto.history,
      )) {
        send('chunk', { text: piece });
      }
      send('done', {});
    } catch (e) {
      // Header đã gửi rồi nên không đặt được mã lỗi HTTP nữa — báo lỗi qua
      // chính luồng sự kiện để app hiện được thông báo tử tế.
      // Chỉ lỗi nghiệp vụ (HttpException: hết lượt, không phải thành viên…)
      // mới mang thông báo viết cho người dùng. Lỗi khác (Prisma, mạng) có thể
      // chứa tên host DB hay chi tiết nội bộ → trả câu chung.
      const isHttp = e instanceof HttpException;
      send('error', {
        status: isHttp ? e.getStatus() : 500,
        message: isHttp ? e.message : 'AI đang bận, bạn thử lại sau nhé.',
      });
    } finally {
      res.end();
    }
  }

  @Get('search')
  @ApiOperation({
    summary: 'Tìm mẫu/điểm dừng theo NGHĨA (pgvector), không phải từ khoá',
  })
  semanticSearch(@Query('q') q: string) {
    // Cắt độ dài: câu truy vấn đi thẳng vào lời gọi embedding tính tiền.
    return this.embeddings.search(String(q ?? '').slice(0, 300), 8);
  }

  @Post('reindex')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Đánh chỉ mục lại kho mẫu công khai (admin)' })
  reindex() {
    return this.embeddings.reindexTemplates();
  }

  @Post('corrections')
  @ApiOperation({
    summary:
      'Báo thông tin sai (quán đóng cửa, đổi địa chỉ). Phải được duyệt mới ' +
      'có hiệu lực — nếu không ai cũng đầu độc được câu trả lời chung.',
  })
  submitCorrection(
    @CurrentUser() user: User,
    @Body() dto: SubmitCorrectionDto,
  ) {
    return this.corrections.submit(user.id, dto.subject, dto.correction);
  }

  @Get('corrections/pending')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Danh sách đính chính chờ duyệt (admin)' })
  pendingCorrections() {
    return this.corrections.listPending();
  }

  @Post('corrections/:id/approve')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Duyệt hoặc gỡ duyệt một đính chính (admin)' })
  approveCorrection(
    @Param('id') id: string,
    @Body('approved') approved?: boolean,
  ) {
    return this.corrections.approve(id, approved !== false);
  }

  @Post('request')
  @ApiOperation({ summary: 'Tạo yêu cầu AI (lập lịch, recap, caption...)' })
  create(@CurrentUser() user: User, @Body() dto: CreateAIRequestDto) {
    return this.aiService.createRequest(
      user.id,
      dto.tripId,
      dto.type,
      dto.prompt,
      dto.history,
    );
  }

  @Post('photo-location')
  @ApiOperation({
    summary:
      'Phân tích ảnh (base64) → toạ độ + tên địa điểm (EXIF → AI vision)',
  })
  photoLocation(
    @CurrentUser() user: User,
    @Body() dto: { imageBase64: string; mimeType?: string; tripId?: string },
  ) {
    // Body này không qua DTO nên tự kiểm: phải là chuỗi base64, tối đa ~15MB
    // ảnh, và mime chỉ trong danh sách ảnh cho phép.
    if (
      typeof dto?.imageBase64 !== 'string' ||
      dto.imageBase64.length === 0 ||
      dto.imageBase64.length > 20_000_000
    ) {
      throw new BadRequestException('Ảnh không hợp lệ hoặc quá lớn');
    }
    const mimeType = ALLOWED_IMAGE_MIME.has(dto.mimeType ?? '')
      ? (dto.mimeType as string)
      : 'image/jpeg';
    return this.aiService.photoLocation(
      user.id,
      dto.imageBase64,
      mimeType,
      typeof dto.tripId === 'string' ? dto.tripId : undefined,
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
  getPersonality(@CurrentUser() user: User, @Param('tripId') tripId: string) {
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
  getTimeline(@CurrentUser() user: User, @Param('tripId') tripId: string) {
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
