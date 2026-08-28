import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotesService } from './notes.service';
import { CreateNoteDto, UpdateNoteDto } from './dto/note.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Notes')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/notes')
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách ghi chú' })
  getAll(@Param('tripId') tripId: string) {
    return this.notesService.getAll(tripId);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo ghi chú mới' })
  create(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateNoteDto,
  ) {
    return this.notesService.create(tripId, user.id, dto);
  }

  @Patch(':noteId')
  @ApiOperation({ summary: 'Cập nhật ghi chú' })
  update(
    @Param('noteId') noteId: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateNoteDto,
  ) {
    return this.notesService.update(noteId, user.id, dto);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('tripNote', 'noteId')
  @Delete(':noteId')
  @ApiOperation({ summary: 'Xóa ghi chú' })
  delete(@Param('noteId') noteId: string, @CurrentUser() user: User) {
    return this.notesService.delete(noteId, user.id);
  }
}
