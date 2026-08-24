import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from '../config/configuration';
import { UsersModule } from '../users/users.module';
import { User } from '../users/user.entity';
import { AppThrottlerGuard } from './app-throttler.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { RolesGuard } from './roles.guard';

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
    // Three global guards, registered in this exact order — Nest runs APP_GUARD
    // providers in registration order, and that order is load-bearing for two
    // different reasons, so it's kept as one array with one comment instead of
    // splitting across modules (docs/phase-8-plan.md §1 "The throttler guard runs
    // first, which is why it lives beside the other two" — the admitted smell: a
    // throttler isn't really an authentication concern, but the alternative —
    // registering it from AppModule — would make the three guards' relative order
    // depend on cross-module import order, which is worse):
    //
    // 1. AppThrottlerGuard FIRST — rejects a flood before any database lookup
    //    happens at all. A throttler registered after JwtAuthGuard would still let
    //    every request in a flood cost a JwtStrategy.validate primary-key lookup;
    //    registered after RolesGuard, it would cost that AND a role check too. See
    //    app-throttler.guard.ts for the response-shape fix it also carries.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    // 2. JwtAuthGuard — the same "register the cross-cutting thing once so it can't
    //    be forgotten on a new controller" pattern ValidationPipe and
    //    AllExceptionsFilter already establish in main.ts (see docs/phase-3-plan.md
    //    "Guard rollout"). APP_GUARD is the token Nest looks for to wire a provider
    //    in as a global guard instead of a plain provider — unlike
    //    app.useGlobalGuards() in main.ts, a guard registered this way can have its
    //    own injected dependencies (JwtAuthGuard needs Reflector), because it's built
    //    through the DI container like everything else here.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // 3. RolesGuard — must run after JwtAuthGuard because it reads
    //    `request.user.role`, which only exists once JwtAuthGuard's Passport
    //    strategy has populated it. Swapping this order would make RolesGuard run
    //    before `request.user` exists, denying every request. See roles.guard.ts and
    //    docs/phase-5-plan.md §1 "RolesGuard is a second global guard".
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
