import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { Supplier } from './supplier.entity';
import { SuppliersService } from './suppliers.service';

// This is a unit test: it never touches a real database. `getRepositoryToken(Supplier)`
// is the exact injection token @InjectRepository(Supplier) resolves to, so we can hand
// the service a fake object in its place — a plain jest.fn()-based stand-in — and
// assert on how the service *uses* it, without needing Postgres running at all.
// (Inventory's tests, later, exercise the real database instead — see
// docs/learning-notes/testing-strategy.md for why each kind of test earns its keep here.)
describe('SuppliersService', () => {
  let service: SuppliersService;
  const repo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((v) => v),
    save: jest.fn((v) => Promise.resolve({ id: 1, ...v })),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SuppliersService,
        { provide: getRepositoryToken(Supplier), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(SuppliersService);
  });

  it('throws NotFoundException when the supplier does not exist', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.findOne(999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('creates a supplier with optional fields defaulted to null', async () => {
    await service.create({ name: 'Highland Roasters' });
    expect(repo.create).toHaveBeenCalledWith({
      name: 'Highland Roasters',
      contactName: null,
      email: null,
      phone: null,
    });
  });

  it('filters by status and a case-insensitive name search', async () => {
    repo.find.mockResolvedValue([]);
    await service.findAll({ status: EntityStatus.ACTIVE, search: 'roast' });
    const whereArg = repo.find.mock.calls[0][0].where;
    expect(whereArg.status).toBe(EntityStatus.ACTIVE);
    expect(whereArg.name).toBeDefined(); // an ILike() FindOperator
  });
});
