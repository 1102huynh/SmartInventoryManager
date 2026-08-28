import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { CORS_OPTIONS } from './common/cors-options';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The frontend (Step 7) runs on its own origin (a plain static file server, not
  // this API's origin), so the browser's same-origin policy would block its fetch()
  // calls without this. In a real deployment you'd list the actual frontend origin(s)
  // instead of allowing everything.
  //
  // Phase 11: the options are no longer empty — `exposedHeaders` is what makes
  // X-Result-Truncated and Retry-After readable by page JavaScript at all. See
  // common/cors-options.ts for why omitting either fails silently rather than loudly.
  app.enableCors(CORS_OPTIONS);

  // A Validation Pipe runs before a request reaches its controller method, checking
  // the incoming body/query against the class-validator decorators on the target DTO
  // class (see products/dto/create-product.dto.ts for a first example) and rejecting
  // the request with 400 Bad Request if anything fails. Registering it once here with
  // useGlobalPipes applies it to every route in the app — the alternative,
  // @UsePipes(ValidationPipe) on each controller, would work identically but invites
  // someone to eventually forget it on a new controller.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip any request property that isn't declared on the DTO
      forbidNonWhitelisted: true, // ...and reject the request if it tried to send one, instead of silently dropping it
      transform: true, // convert plain JSON/query-string values into real DTO class instances (e.g. "20" -> 20)
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // A Class Serializer Interceptor runs on the way OUT — after a controller method
  // returns, before the response is sent — and strips any field marked @Exclude() on
  // its class (see users/user.entity.ts's passwordHash). Without this, a bcrypt hash
  // would otherwise leak through any response that embeds a User, including a
  // transaction's joined `recordedBy` (see InventoryService.listAll). Needs a
  // Reflector instance (app.get(Reflector), Nest's own DI container) to read the
  // @Exclude metadata — the same Reflector mechanism @Public()/JwtAuthGuard uses, see
  // docs/learning-notes/authentication-and-guards.md.
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(
    `Smart Inventory Manager API listening on http://localhost:${port}`,
  );
}
void bootstrap();
