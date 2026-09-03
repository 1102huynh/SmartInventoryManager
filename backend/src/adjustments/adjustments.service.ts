import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { daysCutoffForInstantColumn } from '../common/days-cutoff';
import { AdjustmentRequestStatus } from '../common/enums/adjustment-request-status.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { BoundedResult, trimToLimit } from '../common/result-truncated.header';
import { CreateAdjustmentDto } from '../inventory/dto/create-adjustment.dto';
import { InventoryService } from '../inventory/inventory.service';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';
import { Product } from '../products/product.entity';
import { AdjustmentRequest } from './adjustment-request.entity';
import { QueryAdjustmentRequestsDto } from './dto/query-adjustment-requests.dto';
import { SetAdjustmentRequestStatusDto } from './dto/set-adjustment-request-status.dto';

// Phase 12 (docs/phase-12-plan.md §1 "The new list read is bounded on arrival, using
// Phase 11's convention unchanged"). The same `const DEFAULT_LIMIT = 100` as
// AuditService and InventoryService — no configuration.ts entry: no deployment tunes a
// page size, and the tests set `limit` per request.
const DEFAULT_LIMIT = 100;

// POST /products/:id/adjustments has two outcomes with two response shapes (§1 "The
// Staff path returns 202, and the Owner path is byte-identical"). The controller
// branches on `outcome` to set 201 (Owner, an InventoryTransaction) vs 202 (Staff, an
// AdjustmentRequest) — one `if`, not a wrapper object that would change the Owner
// path's shape.
export type SubmitResult =
  | { outcome: 'recorded'; transaction: InventoryTransaction }
  | { outcome: 'requested'; request: AdjustmentRequest };

// The list read attaches the product's current stock as of this request — recomputed
// on every load, never frozen at request time — plus the delta an approval right now
// would produce (§1 "The Owner's screen must show the delta as of now"). It is a
// preview, not a promise: the real delta is recomputed under lock at approval. A plain
// shape, like ProductsService's ProductWithStock — no validation, so not a DTO class.
export type AdjustmentRequestWithStock = AdjustmentRequest & {
  currentStock: number;
  delta: number;
};

@Injectable()
export class AdjustmentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AdjustmentRequest)
    private readonly requestsRepository: Repository<AdjustmentRequest>,
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    private readonly inventoryService: InventoryService,
  ) {}

  // BR-085. Owner → the transaction is recorded immediately, exactly as before this
  // phase (InventoryService.recordAdjustment, unchanged). Staff → a `pending` request
  // that changes no stock until an Owner approves it.
  async submit(
    productId: number,
    dto: CreateAdjustmentDto,
    user: AuthenticatedUser,
  ): Promise<SubmitResult> {
    // BR-052, checked once here — at submission — and deliberately not repeated at
    // approval (§1).
    this.inventoryService.assertNotFuture(dto.occurredAt);

    if (user.role === UserRole.Owner) {
      const transaction = await this.inventoryService.recordAdjustment(
        productId,
        dto,
        user.id,
      );
      return { outcome: 'recorded', transaction };
    }

    const product = await this.productsRepository.findOne({
      where: { id: productId },
    });
    if (!product)
      throw new NotFoundException(`Product ${productId} not found.`);

    // Snapshot of what the requester saw, for the approver's screen. Not used to
    // compute the delta — that is recomputed under lock at approval (§1).
    const stockAtRequest =
      await this.inventoryService.getCurrentStock(productId);

    const request = this.requestsRepository.create({
      productId,
      newQuantity: dto.newQuantity,
      occurredAt: new Date(dto.occurredAt),
      reason: dto.reason,
      status: AdjustmentRequestStatus.PENDING,
      requestedByUserId: user.id,
      stockAtRequest,
    });
    const saved = await this.requestsRepository.save(request);
    return { outcome: 'requested', request: await this.getOne(saved.id) };
  }

  // Phase 11's convention, applied without re-derivation: bounded on arrival,
  // newest-first, `created_at DESC, id DESC`, `?days=` via daysCutoffForInstantColumn
  // (created_at is a real instant, so it takes the same branch /audit-events takes —
  // NOT daysCutoffForDateColumn). Joins product/requestedBy/resolvedBy so no screen
  // needs a second request for a name.
  //
  // `actor` scopes the result: an Owner sees the whole queue, a Staff caller sees only
  // their OWN requests ("Staff see their own requests", phase-12-plan.md §3 item 3).
  // The scoping is by the authenticated id, not a client-supplied `requestedByUserId`
  // param, so a Staff user cannot widen it to read a colleague's counts. Optional so
  // the integration spec can call this without constructing an actor (it always
  // reads as the whole queue there).
  async list(
    query: QueryAdjustmentRequestsDto,
    actor?: AuthenticatedUser,
  ): Promise<BoundedResult<AdjustmentRequestWithStock>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const qb = this.requestsRepository
      .createQueryBuilder('req')
      .leftJoinAndSelect('req.product', 'product')
      .leftJoinAndSelect('req.requestedBy', 'requestedBy')
      .leftJoinAndSelect('req.resolvedBy', 'resolvedBy')
      .orderBy('req.createdAt', 'DESC')
      .addOrderBy('req.id', 'DESC')
      .take(limit + 1);

    if (actor && actor.role !== UserRole.Owner)
      qb.andWhere('req.requestedByUserId = :actorId', { actorId: actor.id });
    if (query.status)
      qb.andWhere('req.status = :status', { status: query.status });
    if (query.productId)
      qb.andWhere('req.productId = :productId', {
        productId: query.productId,
      });
    if (query.days)
      qb.andWhere('req.createdAt >= :cutoff', {
        cutoff: daysCutoffForInstantColumn(query.days),
      });

    const { rows, truncated } = trimToLimit(await qb.getMany(), limit);
    // One GROUP BY over inventory_transactions for every distinct product in the page,
    // the same N+1-avoidance ProductsService.findAll uses — not one aggregate per row.
    const stockMap = await this.inventoryService.getCurrentStockMap([
      ...new Set(rows.map((r) => r.productId)),
    ]);
    const withStock = rows.map((r) => {
      const currentStock = stockMap.get(r.productId) ?? 0;
      return Object.assign(r, {
        currentStock,
        delta: r.newQuantity - currentStock,
      });
    });
    return { rows: withStock, truncated };
  }

  // BR-086/BR-087. The state machine. A resolved request is terminal — 409 on a
  // second attempt, never a silent second approval. The role gate is HERE, not on
  // RolesGuard, because legality depends on the actor's relationship to the row
  // (requester vs. not), which a guard reading only the token cannot know — the first
  // route in the app whose authorization is not fully expressible as @Roles(...).
  async resolve(
    id: number,
    dto: SetAdjustmentRequestStatusDto,
    user: AuthenticatedUser,
  ): Promise<AdjustmentRequest> {
    const status = dto.status as AdjustmentRequestStatus;
    const reason = dto.reason?.trim();

    const existing = await this.requestsRepository.findOne({ where: { id } });
    if (!existing)
      throw new NotFoundException(`Adjustment request ${id} not found.`);
    if (existing.status !== AdjustmentRequestStatus.PENDING)
      throw new ConflictException(
        `This request has already been ${existing.status}.`,
      );

    // Actor eligibility (§1 "Who may do what to a request").
    if (status === AdjustmentRequestStatus.WITHDRAWN) {
      if (user.id !== existing.requestedByUserId)
        throw new ForbiddenException(
          'Only the requester can withdraw this request.',
        );
    } else {
      // approve or reject → Owner only
      if (user.role !== UserRole.Owner)
        throw new ForbiddenException('This action requires the Owner role.');
      // No self-approval. Cannot normally arise (an Owner's adjustment never becomes
      // a pending request), but it does the moment a Staff member with a pending
      // request is promoted to Owner (§1).
      if (
        status === AdjustmentRequestStatus.APPROVED &&
        user.id === existing.requestedByUserId
      )
        throw new ForbiddenException(
          'You cannot approve your own adjustment request.',
        );
    }

    // Mandatory on reject and withdraw (mirrors BR-032), optional on approve.
    if (
      (status === AdjustmentRequestStatus.REJECTED ||
        status === AdjustmentRequestStatus.WITHDRAWN) &&
      !reason
    )
      throw new BadRequestException(
        'A reason is required to reject or withdraw a request.',
      );

    // One database transaction, always: the request row is re-read under a
    // pessimistic lock so a concurrent resolve of the same request waits and then
    // sees a non-pending status (→ 409). For approval it is also what makes the
    // transaction insert AND the request flip atomic — a crash between the two would
    // leave a stock movement nobody approved, the failure this phase exists to
    // prevent, arriving through the back door.
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AdjustmentRequest);
      const fresh = await repo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!fresh)
        throw new NotFoundException(`Adjustment request ${id} not found.`);
      if (fresh.status !== AdjustmentRequestStatus.PENDING)
        throw new ConflictException(
          `This request has already been ${fresh.status}.`,
        );

      if (status === AdjustmentRequestStatus.APPROVED) {
        // Attributed to the REQUESTER (BR-088), not the approver. Throws
        // ConflictException(NO_OP_ADJUSTMENT_MESSAGE) → 409 if the count has become a
        // no-op by drift; the whole transaction rolls back and the request stays
        // pending.
        const tx = await this.inventoryService.applyApprovedAdjustment(
          manager,
          {
            productId: fresh.productId,
            newQuantity: fresh.newQuantity,
            occurredAt: fresh.occurredAt,
            userId: fresh.requestedByUserId,
            reason: fresh.reason,
          },
        );
        fresh.status = AdjustmentRequestStatus.APPROVED;
        fresh.resolvedByUserId = user.id;
        fresh.resolutionReason = reason || null; // '' (or absent) → null, not ''
        fresh.resultingTransactionId = tx.id;
      } else {
        fresh.status = status; // rejected | withdrawn
        fresh.resolvedByUserId = user.id;
        fresh.resolutionReason = reason || null; // guaranteed non-empty here (checked above)
      }
      await repo.save(fresh);
    });

    return this.getOne(id);
  }

  // Reload with the relations every screen renders — same joined-read choice
  // /inventory-transactions and /audit-events both make.
  private getOne(id: number): Promise<AdjustmentRequest> {
    return this.requestsRepository.findOneOrFail({
      where: { id },
      relations: {
        product: true,
        requestedBy: true,
        resolvedBy: true,
        resultingTransaction: true,
      },
    });
  }
}
