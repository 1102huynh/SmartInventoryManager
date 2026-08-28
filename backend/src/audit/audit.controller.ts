import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { RESULT_TRUNCATED_HEADER } from '../common/result-truncated.header';
import { UserRole } from '../common/enums/user-role.enum';
import { AuditService } from './audit.service';
import { QueryAuditEventsDto } from './dto/query-audit-events.dto';

// Phase 9 (docs/phase-9-plan.md §1 "The read is Owner-only"). Class-level
// @Roles(UserRole.Owner) — the second controller in the app to use this form after
// UsersController (BR-074) — for the same structural reason: every route on it is
// Owner-only, so there is nothing to put a per-route decorator on. The substantive
// reason is stronger here than for the user list: this table contains failed login
// attempts against named accounts, which is not merely a list of who exists but a
// list of who is currently being attacked and which accounts are close to their
// lockout threshold. Letting Staff read this screen would reopen the enumeration
// hole Phase 3 and Phase 8 (BR-081) both closed, from a third direction.
@Roles(UserRole.Owner)
@Controller('audit-events')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  // Phase 11 (docs/phase-11-plan.md §1): the cap this route has had since Phase 9 stops
  // being silent. The service returns { rows, truncated }; the controller sets
  // X-Result-Truncated when more matched and returns the bare array every existing
  // caller (Store.listAuditEvents, the e2e specs) already expects.
  @Get()
  async findAll(
    @Query() query: QueryAuditEventsDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { rows, truncated } = await this.auditService.findAll(query);
    if (truncated) res.setHeader(RESULT_TRUNCATED_HEADER, 'true');
    return rows;
  }
}
