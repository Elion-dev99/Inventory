import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { InventoryService } from './inventory.service';

@Controller('stocks')
@UseGuards(OidcAuthGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  list(
    @Query('locationId') locationId?: string,
    @Query('productId') productId?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.inventory.listStocks({
      locationId: locationId ? BigInt(locationId) : undefined,
      productId: productId ? BigInt(productId) : undefined,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get('fefo-preview')
  fefoPreview(
    @Query('productId') productId: string,
    @Query('quantity') quantity: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.inventory.previewFefo(
      BigInt(productId),
      Number(quantity),
      locationId ? BigInt(locationId) : undefined,
    );
  }
}
