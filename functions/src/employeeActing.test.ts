import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { actingCaller } from './employeeActing';

// A fake Firestore that records every read and answers from a fixed set of documents. The point of
// the first group of tests is that a CONSUMER's call reads nothing at all.

function fakeFirestore(docs: Record<string, Record<string, unknown> | undefined>) {
  const reads: string[] = [];
  const snapshot = (path: string) => {
    const data = docs[path];
    return {
      exists: data !== undefined,
      id: path.split('/').pop(),
      get: (field: string) => data?.[field],
      data: () => data,
    };
  };
  const firestore = {
    doc: (path: string) => ({
      path,
      get: () => {
        reads.push(path);
        return Promise.resolve(snapshot(path));
      },
    }),
    getAll: (...refs: { path: string }[]) => {
      for (const ref of refs) reads.push(ref.path);
      return Promise.resolve(refs.map((ref) => snapshot(ref.path)));
    },
  } as unknown as Firestore;
  return { firestore, reads };
}

const employee = { uid: 'e1', role: 'EMPLOYEE', emailVerified: true, companyId: 'c1' };
const ACTIVE_MEMBER = { status: 'ACTIVE', companyRole: 'EMPLOYEE', canDrive: true };
const OK_DOCS = {
  'companies/c1/members/e1': ACTIVE_MEMBER,
  'companies/c1': { status: 'ACTIVE' },
  'drivers/e1': { verificationStatus: 'VERIFIED', availabilityStatus: 'OFFLINE' },
  'vehicles/e1': { verificationStatus: 'VERIFIED' },
};

describe('a consumer is returned exactly as it came, with no reads', () => {
  it.each([
    ['PASSENGER', 'PASSENGER'],
    ['DRIVER', 'DRIVER'],
  ] as const)('a %s calling as %s', async (role, as) => {
    const { firestore, reads } = fakeFirestore({});
    for (const mode of ['start', 'setup', 'ongoing', 'offline'] as const) {
      const out = await actingCaller(firestore, { uid: 'u1', role, emailVerified: true }, as, mode);
      expect(out).toEqual({ uid: 'u1', role, emailVerified: true });
      expect(Object.keys(out).sort()).toEqual(['emailVerified', 'role', 'uid']);
    }
    expect(reads).toEqual([]);
  });

  it('even a consumer with a company claim in their token is not given a company', async () => {
    const { firestore, reads } = fakeFirestore({});
    const out = await actingCaller(
      firestore,
      { uid: 'u1', role: 'PASSENGER', emailVerified: true, companyId: 'c1' },
      'PASSENGER',
      'start',
    );
    expect(out).toEqual({ uid: 'u1', role: 'PASSENGER', emailVerified: true });
    expect(reads).toEqual([]);
  });

  it('leaves a wrong role for the function itself to refuse, as before', async () => {
    const { firestore, reads } = fakeFirestore({});
    const out = await actingCaller(
      firestore,
      { uid: 'u1', role: 'PASSENGER', emailVerified: true },
      'DRIVER',
      'start',
    );
    expect(out.role).toBe('PASSENGER');
    expect(reads).toEqual([]);
  });
});

describe('an employee', () => {
  it('rides: becomes a passenger carrying their company', async () => {
    const { firestore } = fakeFirestore(OK_DOCS);
    expect(await actingCaller(firestore, employee, 'PASSENGER', 'start')).toEqual({
      uid: 'e1',
      role: 'PASSENGER',
      emailVerified: true,
      companyId: 'c1',
    });
  });

  it('drives: becomes a driver carrying their company, for every mode that needs capability', async () => {
    const { firestore } = fakeFirestore(OK_DOCS);
    for (const mode of ['start', 'setup', 'ongoing'] as const) {
      expect(await actingCaller(firestore, employee, 'DRIVER', mode)).toEqual({
        uid: 'e1',
        role: 'DRIVER',
        emailVerified: true,
        companyId: 'c1',
      });
    }
  });

  it('takes the company from the membership claim only after confirming it', async () => {
    const { firestore } = fakeFirestore({ ...OK_DOCS, 'companies/c1/members/e1': undefined });
    await expect(actingCaller(firestore, employee, 'PASSENGER', 'start')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it.each([
    [
      'a removed member',
      { ...OK_DOCS, 'companies/c1/members/e1': { ...ACTIVE_MEMBER, status: 'REMOVED' } },
    ],
    ['a suspended company', { ...OK_DOCS, 'companies/c1': { status: 'SUSPENDED' } }],
  ])('is refused as %s', async (_name, docs) => {
    const { firestore } = fakeFirestore(docs);
    await expect(actingCaller(firestore, employee, 'PASSENGER', 'start')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('is refused with no company claim or an unverified email', async () => {
    const { firestore } = fakeFirestore(OK_DOCS);
    await expect(
      actingCaller(firestore, { ...employee, companyId: undefined }, 'PASSENGER', 'start'),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      actingCaller(firestore, { ...employee, emailVerified: false }, 'PASSENGER', 'start'),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('needs the administrator’s permission to drive, and the full capability to start or set up', async () => {
    const noPermission = fakeFirestore({
      ...OK_DOCS,
      'companies/c1/members/e1': { ...ACTIVE_MEMBER, canDrive: false },
    });
    for (const mode of ['start', 'setup', 'ongoing'] as const) {
      await expect(
        actingCaller(noPermission.firestore, employee, 'DRIVER', mode),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    }

    // Permission without current verification: cannot start or set up, but may continue what began.
    const lapsed = fakeFirestore({ ...OK_DOCS, 'vehicles/e1': { verificationStatus: 'PENDING' } });
    await expect(actingCaller(lapsed.firestore, employee, 'DRIVER', 'start')).rejects.toMatchObject(
      {
        code: 'permission-denied',
      },
    );
    await expect(actingCaller(lapsed.firestore, employee, 'DRIVER', 'setup')).rejects.toMatchObject(
      {
        code: 'permission-denied',
      },
    );
    await expect(
      actingCaller(lapsed.firestore, employee, 'DRIVER', 'ongoing'),
    ).resolves.toMatchObject({
      role: 'DRIVER',
    });
  });

  it('can always go offline, even with no membership at all', async () => {
    const { firestore, reads } = fakeFirestore({});
    expect(await actingCaller(firestore, employee, 'DRIVER', 'offline')).toEqual({
      uid: 'e1',
      role: 'DRIVER',
      emailVerified: true,
    });
    expect(reads).toEqual([]);
  });

  it('reads only the membership while driving, which runs on every position update', async () => {
    const { firestore, reads } = fakeFirestore(OK_DOCS);
    await actingCaller(firestore, employee, 'DRIVER', 'ongoing');
    expect(reads).toEqual(['companies/c1/members/e1']);
  });

  it('cannot ask for a ride while online or with a journey open', async () => {
    const online = fakeFirestore({
      ...OK_DOCS,
      'drivers/e1': { verificationStatus: 'VERIFIED', availabilityStatus: 'ONLINE' },
    });
    await expect(
      actingCaller(online.firestore, employee, 'PASSENGER', 'start'),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
    });

    const journey = fakeFirestore({
      ...OK_DOCS,
      'drivers/e1': {
        verificationStatus: 'VERIFIED',
        availabilityStatus: 'OFFLINE',
        currentJourneyId: 'j1',
      },
      'driverJourneys/j1': { status: 'MATCHING' },
    });
    await expect(
      actingCaller(journey.firestore, employee, 'PASSENGER', 'start'),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
    });

    // A finished or draft journey does not count.
    const draft = fakeFirestore({
      ...OK_DOCS,
      'drivers/e1': { verificationStatus: 'VERIFIED', currentJourneyId: 'j1' },
      'driverJourneys/j1': { status: 'DRAFT' },
    });
    await expect(
      actingCaller(draft.firestore, employee, 'PASSENGER', 'start'),
    ).resolves.toMatchObject({
      role: 'PASSENGER',
    });
  });

  it('cannot start driving with a ride request open, but can once it has finished', async () => {
    const riding = fakeFirestore({
      ...OK_DOCS,
      'users/e1': { currentTripRequestId: 't1' },
      'tripRequests/t1': { passengerId: 'e1', status: 'SEARCHING' },
    });
    await expect(actingCaller(riding.firestore, employee, 'DRIVER', 'start')).rejects.toMatchObject(
      {
        code: 'failed-precondition',
      },
    );

    const finished = fakeFirestore({
      ...OK_DOCS,
      'users/e1': { currentTripRequestId: 't1' },
      'tripRequests/t1': { passengerId: 'e1', status: 'COMPLETED' },
    });
    await expect(
      actingCaller(finished.firestore, employee, 'DRIVER', 'start'),
    ).resolves.toMatchObject({
      role: 'DRIVER',
    });
  });
});
