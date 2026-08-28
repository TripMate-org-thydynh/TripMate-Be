import type { RequestWithUser } from '../../common/types/request-with-user';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { TodosService } from './todos.service';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';

@Controller('trips/:tripId/todos')
@UseGuards(JwtAuthGuard, TripMemberGuard)
export class TodosController {
  constructor(private readonly todosService: TodosService) {}

  @Get()
  getList(
    @Param('tripId') tripId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (page || limit) {
      return this.todosService.getListPaginated(
        tripId,
        page ? parseInt(page, 10) : 1,
        limit ? parseInt(limit, 10) : 50,
      );
    }
    return this.todosService.getList(tripId);
  }

  @Post()
  addItem(
    @Param('tripId') tripId: string,
    @Request() req: RequestWithUser,
    @Body() dto: CreateTodoDto,
  ) {
    return this.todosService.addItem(tripId, req.user.id, dto);
  }

  @Patch(':itemId')
  updateItem(
    @Param('itemId') itemId: string,
    @Request() req: RequestWithUser,
    @Body() dto: UpdateTodoDto,
  ) {
    return this.todosService.updateItem(itemId, req.user.id, dto);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('todoItem', 'itemId')
  @Delete(':itemId')
  deleteItem(@Param('itemId') itemId: string) {
    return this.todosService.deleteItem(itemId);
  }
}
