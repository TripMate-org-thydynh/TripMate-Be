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
  create(@Param('tripId') tripId: string, @Body() dto: CreateGameSessionDto) {
    return this.gamesService.create(tripId, dto.gameType, dto.initialState);
  }

  @Get()
  @ApiOperation({ summary: 'Danh sách game sessions' })
  findAll(@Param('tripId') tripId: string) {
    return this.gamesService.findAll(tripId);
  }

  // --- MODULE 8 EXTENSION CONTROLLERS ---

  @Get('dare/random')
  @ApiOperation({ summary: 'Tạo thử thách Dare ngẫu nhiên' })
  getRandomDare() {
    return this.gamesService.getRandomDare();
  }

  @Get('xp')
  @ApiOperation({ summary: 'Xem mức độ cấp độ XP của cả nhóm' })
  getXpProgression(@Param('tripId') tripId: string) {
    return this.gamesService.getXpProgression(tripId);
  }

  @Get('seasonal')
  @ApiOperation({ summary: 'Danh sách sự kiện mùa giải du lịch' })
  getSeasonal() {
    return this.gamesService.getSeasonalEvents();
  }

  @Get('weekly')
  @ApiOperation({ summary: 'Danh sách nhiệm vụ thử thách tuần' })
  getWeekly() {
    return this.gamesService.getWeeklyChallenges();
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
