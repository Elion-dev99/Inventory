import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateLocationDto, CreateProductDto, CreateWarehouseDto } from './dto/master.dto';

/** マスタ管理 (商品・倉庫・保管場所)。マスタ系のみ論理削除 (deleted_at) を使う */
@Injectable()
export class MasterService {
  constructor(private readonly prisma: PrismaService) {}

  listProducts(skip = 0, take = 50) {
    return this.prisma.product.findMany({
      where: { deletedAt: null },
      skip,
      take,
      orderBy: { sku: 'asc' },
    });
  }

  async getProduct(id: bigint) {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  createProduct(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: {
        sku: dto.sku,
        name: dto.name,
        unit: dto.unit,
        barcode: dto.barcode,
        safetyStock: dto.safetyStock ?? 0,
        requiresExpiry: dto.requiresExpiry ?? false,
        expiryAlertDays: dto.expiryAlertDays,
      },
    });
  }

  createWarehouse(dto: CreateWarehouseDto) {
    return this.prisma.warehouse.create({ data: { code: dto.code, name: dto.name } });
  }

  listWarehouses() {
    return this.prisma.warehouse.findMany({
      where: { deletedAt: null },
      orderBy: { code: 'asc' },
    });
  }

  createLocation(dto: CreateLocationDto) {
    return this.prisma.location.create({
      data: { warehouseId: BigInt(dto.warehouseId), code: dto.code, name: dto.name },
    });
  }

  listLocations(warehouseId?: bigint) {
    return this.prisma.location.findMany({
      where: { deletedAt: null, ...(warehouseId ? { warehouseId } : {}) },
      orderBy: { code: 'asc' },
    });
  }
}
