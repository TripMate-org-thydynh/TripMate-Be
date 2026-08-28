import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Documents')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách tài liệu' })
  getAll(@Param('tripId') tripId: string) {
    return this.documentsService.getAll(tripId);
  }

  @Post()
  @ApiOperation({ summary: 'Upload tài liệu (metadata sau khi upload Supabase)' })
  create(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateDocumentDto,
  ) {
    return this.documentsService.create(tripId, user.id, dto);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('tripDocument', 'documentId')
  @Delete(':documentId')
  @ApiOperation({ summary: 'Xóa tài liệu' })
  delete(
    @Param('documentId') documentId: string,
    @CurrentUser() user: User,
  ) {
    return this.documentsService.delete(documentId, user.id);
  }
}
