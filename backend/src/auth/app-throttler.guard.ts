import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

// Phase 8 (docs/phase-8-plan.md §1 "A 429 has to fit the error shape api.md
// promises — and by default it doesn't"). The default ThrottlerException is
// `new HttpException(message, 429)` with a plain STRING message — and HttpException's
// getResponse() returns that string as-is, not wrapped in an object. So an
// un-overridden ThrottlerGuard would make AllExceptionsFilter's
// `response.status(exception.getStatus()).json(exception.getResponse())` serialize a
// bare JSON string instead of the `{ statusCode, message, error }` shape every other
// error in this API uses, and the frontend's Store._request (which reads
// `data.message`) would silently discard the one useful piece of information — the
// Retry-After wait — falling back to its generic "Request failed (429)."
//
// Fixed here, in the guard that creates the problem, by throwing an HttpException
// constructed the same way every other exception in this app already gets that shape
// (an object body, not a string) — rather than by teaching AllExceptionsFilter about
// ThrottlerException specifically. That filter's job is the "expected vs. unexpected
// error" boundary, and patching one library's response shape into it would blur a
// well-commented seam for a problem that belongs here.
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  // Not async — it never awaits anything, it just throws. `never` (not
  // `Promise<void>`) is what tells TS this method never returns at all, and `never`
  // is still assignable to the base class's `Promise<void>` signature, so this stays
  // a valid override without the pointless `async` eslint (correctly) flags.
  protected throwThrottlingException(): never {
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many requests. Please slow down and try again shortly.',
        error: 'Too Many Requests',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
