import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from '../config/configuration';
import { UsersModule } from '../users/users.module';
import { User } from '../users/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    UsersModule,
    PassportModule,
    // forRootAsync (rather than forRoot with a literal string) because the secret has
    // to come from ConfigService, not a value hardcoded at module-load time — the same
    // reason DatabaseModule reads its connection settings this way.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => ({
        secret: configService.get('auth.jwtSecret', { infer: true }),
        signOptions: {
          expiresIn: configService.get('auth.jwtExpiresIn', { infer: true }),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    // Registers JwtAuthGuard once, globally, via the providers array — the same
    // "register the cross-cutting thing once so it can't be forgotten on a new
    // controller" pattern ValidationPipe and AllExceptionsFilter already establish in
    // main.ts (see docs/phase-3-plan.md "Guard rollout"). APP_GUARD is the token Nest
    // looks for to wire a provider in as a global guard instead of a plain provider —
    // unlike app.useGlobalGuards() in main.ts, a guard registered this way can have
    // its own injected dependencies (JwtAuthGuard needs Reflector), because it's built
    // through the DI container like everything else here.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
