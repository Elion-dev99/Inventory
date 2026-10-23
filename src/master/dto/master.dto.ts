import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateProductDto {
  @IsString() sku!: string;
  @IsString() name!: string;
  @IsString() unit!: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsInt() @Min(0) safetyStock?: number;
  @IsOptional() @IsBoolean() requiresExpiry?: boolean;
  @IsOptional() @IsInt() @Min(0) expiryAlertDays?: number;
}

export class CreateWarehouseDto {
  @IsString() code!: string;
  @IsString() name!: string;
}

export class CreateLocationDto {
  @IsString() warehouseId!: string;
  @IsString() code!: string;
  @IsString() name!: string;
}
