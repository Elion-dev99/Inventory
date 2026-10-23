import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class InboundDto {
  @IsString() locationId!: string;
  @IsString() productId!: string;
  @IsString() lotCode!: string;
  /** YYYY-MM-DD。期限管理対象の商品では必須 (サービス層で検証) */
  @IsOptional() @IsString() expiryDate?: string;
  @IsInt() @Min(1) quantity!: number;
}

export class ConsumeDto {
  @IsString() productId!: string;
  @IsOptional() @IsString() locationId?: string;
  @IsInt() @Min(1) quantity!: number;
  /** 社内消費の用途 (部署・目的) は必須 */
  @IsString() department!: string;
  @IsString() purpose!: string;
  /** FEFO 提案から逸脱する場合の理由 */
  @IsOptional() @IsString() fefoDeviationReason?: string;
}

export class TransferDto {
  @IsString() stockId!: string;
  @IsString() toLocationId!: string;
  @IsInt() @Min(1) quantity!: number;
}
