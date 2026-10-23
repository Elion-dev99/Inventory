import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { MasterService } from './master.service';
import { CreateLocationDto, CreateProductDto, CreateWarehouseDto } from './dto/master.dto';

@Controller('master')
@UseGuards(OidcAuthGuard)
export class MasterController {
  constructor(private readonly master: MasterService) {}

  @Get('products')
  listProducts(@Query('skip') skip?: string, @Query('take') take?: string) {
    return this.master.listProducts(Number(skip ?? 0), Number(take ?? 50));
  }

  @Get('products/:id')
  getProduct(@Param('id') id: string) {
    return this.master.getProduct(BigInt(id));
  }

  @Post('products')
  createProduct(@Body() dto: CreateProductDto) {
    return this.master.createProduct(dto);
  }

  @Get('warehouses')
  listWarehouses() {
    return this.master.listWarehouses();
  }

  @Post('warehouses')
  createWarehouse(@Body() dto: CreateWarehouseDto) {
    return this.master.createWarehouse(dto);
  }

  @Get('locations')
  listLocations(@Query('warehouseId') warehouseId?: string) {
    return this.master.listLocations(warehouseId ? BigInt(warehouseId) : undefined);
  }

  @Post('locations')
  createLocation(@Body() dto: CreateLocationDto) {
    return this.master.createLocation(dto);
  }
}
