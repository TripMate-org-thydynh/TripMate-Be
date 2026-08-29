import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { GamesService } from './games.service';
import { CreateGameSessionDto, UpdateGameStateDto } from './dto/game.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';

@ApiTags('Games')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/games')
export class GamesController {
  constructor(private readonly gamesService: GamesService) {}

  @Post()
  @ApiOperation({ summary: 'Bắt đầu game session mới' })
  create(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateGameSessionDto,
  ) {
    return this.gamesService.create(
      tripId,
      dto.gameType,
      dto.initialState,
      user.id,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Danh sách game sessions' })
  findAll(@Param('tripId') tripId: string) {
    return this.gamesService.findAll(tripId);
  }

  // --- MODULE 8 EXTENSION CONTROLLERS ---

  @Get('dare/random')
  @ApiOperation({ summary: 'Tạo thử thách Dare ngẫu nhiên' })
  getRandomDare(@Param('tripId') tripId: string) {
    return this.gamesService.getRandomDare(tripId);
  }

  @Get('xp')
  @ApiOperation({ summary: 'Xem mức độ cấp độ XP của cả nhóm' })
  getXpProgression(@Param('tripId') tripId: string) {
    return this.gamesService.getXpProgression(tripId);
  }

  @Get('seasonal')
  @ApiOperation({ summary: 'Danh sách sự kiện mùa giải du lịch' })
  getSeasonal(@Param('tripId') tripId: string) {
    return this.gamesService.getSeasonalEvents(tripId);
  }

  @Get('daily')
  @ApiOperation({ summary: 'Nhiệm vụ trong ngày, tiến độ tính từ hôm nay' })
  getDailyMissions(@Param('tripId') tripId: string) {
    return this.gamesService.getDailyMissions(tripId);
  }

  @Get('weekly')
  @ApiOperation({ summary: 'Danh sách nhiệm vụ thử thách tuần' })
  getWeekly(@Param('tripId') tripId: string) {
    return this.gamesService.getWeeklyChallenges(tripId);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Bảng xếp hạng đóng góp của từng thành viên' })
  getLeaderboard(@Param('tripId') tripId: string) {
    return this.gamesService.getLeaderboard(tripId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Xem trạng thái game' })
  findOne(@Param('id') id: string) {
    return this.gamesService.findOne(id);
  }

  @Patch(':id/state')
  @ApiOperation({ summary: 'Cập nhật trạng thái game realtime' })
  updateState(@Param('id') id: string, @Body() dto: UpdateGameStateDto) {
    return this.gamesService.updateState(id, dto.stateJson);
  }

  @Patch(':id/end')
  @ApiOperation({ summary: 'Kết thúc game session' })
  end(@Param('id') id: string) {
    return this.gamesService.endSession(id);
  }
}
