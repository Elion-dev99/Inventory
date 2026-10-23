import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Cloudflare Containers 等のオーケストレータからの SIGTERM で
  // OnModuleDestroy (Prisma 切断 / Redis QUIT) を確実に走らせる。
  app.enableShutdownHooks();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  // コンテナ/リバースプロキシ配下では全インターフェースで待ち受ける。
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
