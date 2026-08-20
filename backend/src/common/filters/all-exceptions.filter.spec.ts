import {
  ArgumentsHost,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

// This is a unit test, not an e2e one, and that's deliberate: the fallback branch
// (an unanticipated, non-HttpException error) needs to be triggered on purpose to be
// tested at all, and there's no legitimate HTTP request in this app that organically
// throws a plain Error — every real business-rule rejection is a specific
// HttpException subclass (see docs/learning-notes/exception-handling.md). Adding a
// test-only endpoint that throws on command just to reach this branch over HTTP would
// mean shipping test-only behavior in production routes for no real benefit: calling
// `filter.catch()` directly proves the exact same branching logic, faster and without
// that cost. (Contrast with `test/app.e2e-spec.ts`, which still legitimately proves
// the *other* branch — an HttpException from a real pipe — travels correctly over
// real HTTP.)
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let json: jest.Mock;
  let status: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    json = jest.fn();
    status = jest.fn(() => ({ json }));
    // Only what AllExceptionsFilter.catch actually calls: host.switchToHttp().getResponse().
    host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
  });

  it('turns an unexpected, non-HttpException error into a generic 500 and never leaks its message', () => {
    // Logger writes to stderr by default — silence it here so the test output stays
    // clean, and so we can assert it actually logged the real detail server-side.
    const logSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const realError = new Error('db connection lost at pool.ts:42');
    filter.catch(realError, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong. Please try again.',
    });
    // The real error's message/stack must never reach the response body — only the
    // generic message above. This is the property the old e2e test intended to prove
    // but structurally couldn't.
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain(
      'db connection lost',
    );
    // ...but it must still be visible server-side, via the logger, or a real bug in
    // production would be silent as well as unreported to the client.
    expect(logSpy).toHaveBeenCalledWith(
      'Unhandled exception',
      expect.stringContaining('db connection lost'),
    );

    logSpy.mockRestore();
  });

  it('passes an HttpException straight through unchanged', () => {
    // The branch the old e2e test actually exercised (ParseIntPipe's BadRequestException
    // takes this same path) — kept here so the filter's two branches are both covered
    // in one place.
    const notFound = new NotFoundException('Product 7 not found.');
    filter.catch(notFound, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(notFound.getResponse());
  });
});
