import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The frontend (Step 7) runs on its own origin (a plain static file server, not
  // this API's origin), so the browser's same-origin policy would block its fetch()
  // calls without this. In a real deployment you'd list the actual frontend origin(s)
  // instead of allowing everything.
  app.enableCors();

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

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(
    `Smart Inventory Manager API listening on http://localhost:${port}`,
  );
}
void bootstrap();
