import 'dotenv/config';
import { Category } from '../../categories/category.entity';
import { EntityStatus } from '../../common/enums/entity-status.enum';
import { TransactionType } from '../../common/enums/transaction-type.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { hashPassword } from '../../common/password';
import { InventoryTransaction } from '../../inventory/inventory-transaction.entity';
import { Product } from '../../products/product.entity';
import { Supplier } from '../../suppliers/supplier.entity';
import { User } from '../../users/user.entity';
import { AppDataSource } from '../data-source';

// Reuses the exact same demo dataset the Phase 1 UI mockup shipped with (same
// products, suppliers, users, and hand-authored transaction history), so the
// numbers a reviewer already saw in the mockup match what they'll see once the UI
// is wired to this real database. Running this twice is safe — it clears the four
// tables first (children before parents, respecting the foreign keys) rather than
// erroring on duplicate rows.

const CATEGORY_NAMES = [
  'Beverages & Café Supplies',
  'Cleaning & Janitorial',
  'Office & Stationery',
  'Packaging & Shipping',
  'Break Room & Pantry',
];

// Phase 3 (docs/phase-3-plan.md): every seeded user needs real login credentials now.
// They all share one dev-only password rather than one each — nothing in this
// project distinguishes them by security posture, and one password is one less thing
// to look up. It's documented in the root README's local-dev instructions, the same
// way .env.example documents other dev-only defaults; the plaintext is never stored
// anywhere, including here — only its bcrypt hash goes into the database.
const DEV_PASSWORD = 'password123';

const USERS = [
  {
    name: 'Jordan Lee',
    role: UserRole.Staff,
    email: 'jordan@example.com',
    status: EntityStatus.ACTIVE,
  },
  {
    name: 'Alex Rivera',
    role: UserRole.Owner,
    email: 'alex@example.com',
    status: EntityStatus.ACTIVE,
  },
  {
    name: 'Sam Patel',
    role: UserRole.Staff,
    email: 'sam@example.com',
    status: EntityStatus.ACTIVE,
  },
  // Phase 6 (docs/phase-6-plan.md §2): a fourth, deactivated Staff user so the Users
  // screen demonstrates both states out of the box, the same reasoning already
  // applied to Sunrise Wholesale (the inactive supplier below). Deliberately given no
  // transactions — see TRANSACTIONS' userIdx column, which never references index 3 —
  // so every existing attribution and dashboard number stays exactly as it was.
  {
    name: 'Riley Chen',
    role: UserRole.Staff,
    email: 'riley@example.com',
    status: EntityStatus.INACTIVE,
  },
];

const SUPPLIERS = [
  {
    key: 'highland',
    name: 'Highland Roasters',
    contactName: 'Priya Nandan',
    email: 'orders@highlandroasters.example',
    phone: '(555) 201-4488',
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'cleanpro',
    name: 'CleanPro Distributors',
    contactName: 'Marcus Webb',
    email: 'accounts@cleanprodist.example',
    phone: '(555) 330-7712',
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'metro',
    name: 'Metro Office Supply',
    contactName: 'Dana Kim',
    email: 'sales@metroofficesupply.example',
    phone: '(555) 448-9021',
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'coastal',
    name: 'Coastal Packaging Co.',
    contactName: 'Efrain Ortiz',
    email: 'orders@coastalpackaging.example',
    phone: '(555) 562-3390',
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'sunrise',
    name: 'Sunrise Wholesale',
    contactName: 'Renee Booth',
    email: 'info@sunrisewholesale.example',
    phone: '(555) 674-1123',
    status: EntityStatus.INACTIVE,
  },
];

const PRODUCTS = [
  {
    key: 'p1',
    sku: 'CO-1001',
    name: 'Espresso Beans, 1kg',
    unit: 'bag',
    category: 'Beverages & Café Supplies',
    threshold: 10,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p2',
    sku: 'CO-1002',
    name: 'Whole Milk, 1L',
    unit: 'carton',
    category: 'Beverages & Café Supplies',
    threshold: 20,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p3',
    sku: 'CO-1010',
    name: 'Paper Cups, 12oz (Sleeve of 50)',
    unit: 'sleeve',
    category: 'Beverages & Café Supplies',
    threshold: 15,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p4',
    sku: 'CL-2001',
    name: 'All-Purpose Cleaner, 1L',
    unit: 'bottle',
    category: 'Cleaning & Janitorial',
    threshold: 8,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p5',
    sku: 'CL-2002',
    name: 'Disposable Gloves (Box of 100)',
    unit: 'box',
    category: 'Cleaning & Janitorial',
    threshold: 5,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p6',
    sku: 'CL-2005',
    name: 'Trash Liners, 55 Gal (Roll of 25)',
    unit: 'roll',
    category: 'Cleaning & Janitorial',
    threshold: 6,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p7',
    sku: 'OF-3001',
    name: 'A4 Paper (Ream of 500)',
    unit: 'ream',
    category: 'Office & Stationery',
    threshold: 20,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p8',
    sku: 'OF-3002',
    name: 'Blue Ballpoint Pens (Dozen)',
    unit: 'dozen',
    category: 'Office & Stationery',
    threshold: 10,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p9',
    sku: 'OF-3010',
    name: 'Sticky Notes, 3x3in (Pack of 12)',
    unit: 'pack',
    category: 'Office & Stationery',
    threshold: 6,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p10',
    sku: 'PK-4001',
    name: 'Shipping Boxes, Medium (Bundle of 20)',
    unit: 'bundle',
    category: 'Packaging & Shipping',
    threshold: 10,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p11',
    sku: 'PK-4002',
    name: 'Packing Tape (Case of 36)',
    unit: 'case',
    category: 'Packaging & Shipping',
    threshold: 4,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p12',
    sku: 'BR-5001',
    name: 'Assorted Snack Mix (Case of 24)',
    unit: 'case',
    category: 'Break Room & Pantry',
    threshold: 8,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p13',
    sku: 'BR-5002',
    name: 'Bottled Water, 500ml (Case of 24)',
    unit: 'case',
    category: 'Break Room & Pantry',
    threshold: 15,
    status: EntityStatus.INACTIVE,
  },
  {
    key: 'p14',
    sku: 'OF-3099',
    name: 'Laminating Sheets, Letter (Pack of 100)',
    unit: 'pack',
    category: 'Office & Stationery',
    threshold: 10,
    status: EntityStatus.ACTIVE,
  },
  {
    key: 'p15',
    sku: 'PK-4010',
    name: 'Bubble Wrap Roll, 24in x 100ft',
    unit: 'roll',
    category: 'Packaging & Shipping',
    threshold: null,
    status: EntityStatus.ACTIVE,
  },
];

// [productKey, type, quantity(unsigned)/delta(signed for adjustment), daysAgo, hour, minute, userIndex, supplierKey|null, reason]
const TRANSACTIONS: [
  string,
  TransactionType,
  number,
  number,
  number,
  number,
  number,
  string | null,
  string,
][] = [
  ['p1', TransactionType.STOCK_IN, 40, 55, 9, 5, 1, 'highland', ''],
  ['p1', TransactionType.STOCK_OUT, 12, 40, 14, 20, 0, null, ''],
  [
    'p1',
    TransactionType.STOCK_OUT,
    15,
    25,
    11,
    10,
    2,
    null,
    'Sold to a wholesale café order',
  ],
  ['p1', TransactionType.STOCK_IN, 20, 10, 9, 30, 0, 'highland', ''],

  ['p2', TransactionType.STOCK_IN, 60, 50, 8, 40, 0, 'highland', ''],
  ['p2', TransactionType.STOCK_OUT, 25, 35, 10, 15, 1, null, ''],
  ['p2', TransactionType.STOCK_OUT, 20, 20, 9, 50, 2, null, ''],
  [
    'p2',
    TransactionType.STOCK_OUT,
    12,
    6,
    15,
    5,
    0,
    null,
    'Approaching expiry — pulled for staff use',
  ],

  ['p3', TransactionType.STOCK_IN, 80, 48, 9, 0, 0, 'highland', ''],
  ['p3', TransactionType.STOCK_OUT, 30, 30, 13, 40, 1, null, ''],
  ['p3', TransactionType.STOCK_OUT, 25, 12, 10, 25, 0, null, ''],

  ['p4', TransactionType.STOCK_IN, 24, 44, 8, 55, 2, 'cleanpro', ''],
  ['p4', TransactionType.STOCK_OUT, 10, 28, 11, 30, 0, null, ''],
  ['p4', TransactionType.STOCK_OUT, 9, 14, 9, 15, 1, null, ''],
  [
    'p4',
    TransactionType.ADJUSTMENT,
    -3,
    5,
    16,
    0,
    0,
    null,
    'Two bottles found leaking during weekly check',
  ],

  ['p5', TransactionType.STOCK_IN, 15, 40, 9, 20, 1, 'cleanpro', ''],
  ['p5', TransactionType.STOCK_OUT, 6, 22, 14, 10, 2, null, ''],
  ['p5', TransactionType.STOCK_OUT, 4, 9, 10, 45, 0, null, ''],

  ['p6', TransactionType.STOCK_IN, 18, 38, 9, 10, 0, null, ''],
  ['p6', TransactionType.STOCK_OUT, 5, 20, 13, 0, 1, null, ''],

  ['p7', TransactionType.STOCK_IN, 100, 52, 8, 45, 0, 'metro', ''],
  ['p7', TransactionType.STOCK_OUT, 40, 33, 11, 20, 2, null, ''],
  ['p7', TransactionType.STOCK_OUT, 35, 15, 9, 40, 1, null, ''],

  ['p8', TransactionType.STOCK_IN, 30, 41, 9, 25, 1, 'metro', ''],
  ['p8', TransactionType.STOCK_OUT, 14, 19, 10, 50, 0, null, ''],

  ['p9', TransactionType.STOCK_IN, 36, 37, 8, 50, 2, null, ''],
  ['p9', TransactionType.STOCK_OUT, 20, 16, 12, 15, 0, null, ''],
  ['p9', TransactionType.STOCK_OUT, 8, 4, 9, 5, 1, null, ''],

  ['p10', TransactionType.STOCK_IN, 25, 35, 9, 35, 0, 'coastal', ''],
  ['p10', TransactionType.STOCK_OUT, 8, 17, 11, 5, 1, null, ''],

  ['p11', TransactionType.STOCK_IN, 10, 30, 8, 40, 2, 'coastal', ''],
  ['p11', TransactionType.STOCK_OUT, 6, 11, 13, 20, 0, null, ''],
  [
    'p11',
    TransactionType.STOCK_OUT,
    4,
    3,
    9,
    55,
    1,
    null,
    'Used up on a large outbound shipment',
  ],

  ['p12', TransactionType.STOCK_IN, 20, 33, 9, 15, 1, 'sunrise', ''],
  ['p12', TransactionType.STOCK_OUT, 9, 14, 10, 30, 2, null, ''],
  [
    'p12',
    TransactionType.ADJUSTMENT,
    2,
    2,
    15,
    40,
    0,
    null,
    'Recount after supplier delivered 2 extra cases uncounted at receiving',
  ],

  ['p13', TransactionType.STOCK_IN, 40, 70, 9, 0, 0, 'sunrise', ''],
  [
    'p13',
    TransactionType.STOCK_OUT,
    40,
    20,
    11,
    15,
    1,
    null,
    'Discontinuing product line — cleared remaining stock',
  ],

  ['p15', TransactionType.STOCK_IN, 6, 25, 9, 20, 2, 'coastal', ''],
  ['p15', TransactionType.STOCK_OUT, 5, 8, 10, 5, 0, null, ''],
];

function daysAgo(days: number, hour: number, minute: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

async function run() {
  const ds = await AppDataSource.initialize();
  await ds.transaction(async (manager) => {
    // TRUNCATE ... RESTART IDENTITY resets the SERIAL sequences too, not just the
    // rows — without it, re-running this script repeatedly would keep growing the
    // ids (16, 17, 18, ...) instead of always seeding a clean 1..15. CASCADE handles
    // the FK ordering for us, so the children-before-parents dance a plain DELETE
    // would need isn't necessary here.
    await manager.query(
      'TRUNCATE TABLE inventory_transactions, products, suppliers, categories, users RESTART IDENTITY CASCADE',
    );

    const categories = await manager
      .getRepository(Category)
      .save(
        CATEGORY_NAMES.map((name) =>
          manager.getRepository(Category).create({ name }),
        ),
      );
    const categoryIdByName = new Map(categories.map((c) => [c.name, c.id]));

    const passwordHash = await hashPassword(DEV_PASSWORD);
    const users = await manager
      .getRepository(User)
      .save(
        USERS.map((u) =>
          manager.getRepository(User).create({ ...u, passwordHash }),
        ),
      );

    const suppliers = await manager
      .getRepository(Supplier)
      .save(SUPPLIERS.map((s) => manager.getRepository(Supplier).create(s)));
    const supplierIdByKey = new Map(
      suppliers.map((s, i) => [SUPPLIERS[i].key, s.id]),
    );

    const products = await manager.getRepository(Product).save(
      PRODUCTS.map((p) =>
        manager.getRepository(Product).create({
          sku: p.sku,
          name: p.name,
          unit: p.unit,
          categoryId: categoryIdByName.get(p.category) ?? null,
          lowStockThreshold: p.threshold,
          status: p.status,
        }),
      ),
    );
    const productIdByKey = new Map(
      products.map((p, i) => [PRODUCTS[i].key, p.id]),
    );

    const txRepo = manager.getRepository(InventoryTransaction);
    const rows = TRANSACTIONS.map(
      ([key, type, qty, days, hour, minute, userIdx, supplierKey, reason]) =>
        txRepo.create({
          productId: productIdByKey.get(key)!,
          type,
          quantityDelta: type === TransactionType.STOCK_OUT ? -qty : qty,
          occurredAt: daysAgo(days, hour, minute),
          recordedByUserId: users[userIdx].id,
          supplierId: supplierKey
            ? (supplierIdByKey.get(supplierKey) ?? null)
            : null,
          reason: reason || null,
        }),
    );
    await txRepo.save(rows);

    console.log(
      `Seeded ${categories.length} categories, ${users.length} users, ${suppliers.length} suppliers, ${products.length} products, ${rows.length} transactions.`,
    );
  });
  await ds.destroy();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
