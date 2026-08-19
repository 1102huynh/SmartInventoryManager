import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

// An Exception Filter is NestJS's mechanism for turning a thrown error into an HTTP
// response — it sits at the very edge of the request pipeline, after everything else
// (controller, service, pipes) has had a chance to run. @Catch() with no argument
// means "catch everything", not just HttpException subclasses.
//
// Why we need this at all: NestJS already turns `throw new BadRequestException(...)`
// into a clean `{ statusCode, message, error }` JSON response on its own — that part
// needs no filter. What it does NOT do on its own is stop an *unexpected* error (a
// bug, a dropped DB connection, a null-pointer typo) from leaking its raw message and
// stack trace straight into the HTTP response. This filter is the one place that
// distinguishes "an error the code deliberately threw to report a business problem"
// (HttpException — pass its message through, the client needs it) from "an error the
// code did not anticipate" (log the real detail server-side, tell the client only
// that something went wrong).
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong. Please try again.',
    });
  }
}
