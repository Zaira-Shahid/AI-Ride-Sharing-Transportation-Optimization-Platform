import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { TEST_PORTS } from '../test-ports';

// Firestore rules for the company (tenant) collections, module A1. See docs/a1-tenancy-design.md.

const root = resolve(__dirname, '../..');
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-ridemesh-company-rules',
    firestore: {
      rules: readFileSync(join(root, 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: TEST_PORTS.firestore,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'companies/c1'), { name: 'Acme', status: 'ACTIVE' });
    await setDoc(doc(db, 'companies/c2'), { name: 'Globex', status: 'ACTIVE' });
    await setDoc(doc(db, 'companies/c1/members/alice'), {
      companyRole: 'COMPANY_ADMIN',
      status: 'ACTIVE',
      canDrive: false,
    });
    await setDoc(doc(db, 'companies/c1/members/bob'), {
      companyRole: 'EMPLOYEE',
      status: 'ACTIVE',
      canDrive: true,
    });
    await setDoc(doc(db, 'companies/c2/members/carol'), {
      companyRole: 'COMPANY_ADMIN',
      status: 'ACTIVE',
      canDrive: false,
    });
    await setDoc(doc(db, 'companyInvitations/inv-1'), {
      companyId: 'c1',
      email: 'new@example.test',
      tokenHash: 'x'.repeat(64),
      status: 'PENDING',
    });
  });
});

function member(uid: string, companyId: string, companyRole: 'COMPANY_ADMIN' | 'EMPLOYEE') {
  return env
    .authenticatedContext(uid, {
      email_verified: true,
      role: 'EMPLOYEE',
      companyId,
      companyRole,
    })
    .firestore();
}

const alice = () => member('alice', 'c1', 'COMPANY_ADMIN');
const bob = () => member('bob', 'c1', 'EMPLOYEE');
const carol = () => member('carol', 'c2', 'COMPANY_ADMIN');
const staff = () =>
  env.authenticatedContext('staff-1', { email_verified: true, role: 'ADMIN' }).firestore();

describe('companies/{id}', () => {
  it('lets a member of the company read it, admin or not', async () => {
    await assertSucceeds(getDoc(doc(alice(), 'companies/c1')));
    await assertSucceeds(getDoc(doc(bob(), 'companies/c1')));
  });

  it('never lets a member read another company', async () => {
    await assertFails(getDoc(doc(alice(), 'companies/c2')));
    await assertFails(getDoc(doc(bob(), 'companies/c2')));
    await assertFails(getDoc(doc(carol(), 'companies/c1')));
  });

  it('lets platform staff read a company', async () => {
    await assertSucceeds(getDoc(doc(staff(), 'companies/c1')));
  });

  it('denies consumers, even with a company id claim', async () => {
    for (const role of ['PASSENGER', 'DRIVER']) {
      const db = env
        .authenticatedContext('p1', { email_verified: true, role, companyId: 'c1' })
        .firestore();
      await assertFails(getDoc(doc(db, 'companies/c1')));
    }
  });

  it('denies a token with a role but no company, or the wrong role for the company', async () => {
    const noCompany = env
      .authenticatedContext('x', { email_verified: true, role: 'EMPLOYEE' })
      .firestore();
    await assertFails(getDoc(doc(noCompany, 'companies/c1')));
    const noRole = env.authenticatedContext('x', { email_verified: true, companyId: 'c1' });
    await assertFails(getDoc(doc(noRole.firestore(), 'companies/c1')));
  });

  it('denies an unverified email and a signed-out caller', async () => {
    const unverified = env
      .authenticatedContext('bob', {
        email_verified: false,
        role: 'EMPLOYEE',
        companyId: 'c1',
        companyRole: 'EMPLOYEE',
      })
      .firestore();
    await assertFails(getDoc(doc(unverified, 'companies/c1')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'companies/c1')));
  });

  it('cannot be written by anyone, admin and staff included', async () => {
    for (const db of [alice(), bob(), staff()]) {
      await assertFails(setDoc(doc(db, 'companies/c3'), { name: 'New' }));
      await assertFails(updateDoc(doc(db, 'companies/c1'), { name: 'Renamed' }));
      await assertFails(deleteDoc(doc(db, 'companies/c1')));
    }
  });
});

describe('companies/{id}/members/{uid}', () => {
  it('lets a member read their own membership only', async () => {
    await assertSucceeds(getDoc(doc(bob(), 'companies/c1/members/bob')));
    await assertFails(getDoc(doc(bob(), 'companies/c1/members/alice')));
  });

  it('does not let an ordinary employee list the members', async () => {
    await assertFails(getDocs(collection(bob(), 'companies/c1/members')));
  });

  it('lets a company admin read and list their own company members', async () => {
    await assertSucceeds(getDoc(doc(alice(), 'companies/c1/members/bob')));
    await assertSucceeds(getDocs(collection(alice(), 'companies/c1/members')));
  });

  it('never lets a company admin reach another company', async () => {
    await assertFails(getDoc(doc(alice(), 'companies/c2/members/carol')));
    await assertFails(getDocs(collection(alice(), 'companies/c2/members')));
    await assertFails(getDoc(doc(carol(), 'companies/c1/members/bob')));
  });

  it('does not trust a COMPANY_ADMIN role claim that names a different company', async () => {
    // Carol is an admin, but of c2: her claim must not open c1.
    await assertFails(getDocs(collection(carol(), 'companies/c1/members')));
  });

  it('lets platform staff read members', async () => {
    await assertSucceeds(getDoc(doc(staff(), 'companies/c1/members/bob')));
  });

  it('denies consumers', async () => {
    for (const role of ['PASSENGER', 'DRIVER']) {
      const db = env
        .authenticatedContext('bob', {
          email_verified: true,
          role,
          companyId: 'c1',
          companyRole: 'COMPANY_ADMIN',
        })
        .firestore();
      await assertFails(getDoc(doc(db, 'companies/c1/members/bob')));
      await assertFails(getDocs(collection(db, 'companies/c1/members')));
    }
  });

  it('cannot be written by anyone, so canDrive cannot be self-granted', async () => {
    for (const db of [alice(), bob(), staff()]) {
      await assertFails(updateDoc(doc(db, 'companies/c1/members/bob'), { canDrive: true }));
      await assertFails(setDoc(doc(db, 'companies/c1/members/eve'), { canDrive: true }));
      await assertFails(deleteDoc(doc(db, 'companies/c1/members/bob')));
    }
  });
});

describe('companyInvitations/{id}', () => {
  it('is unreadable from a client, company admins included', async () => {
    await assertFails(getDoc(doc(alice(), 'companyInvitations/inv-1')));
    await assertFails(getDoc(doc(bob(), 'companyInvitations/inv-1')));
    await assertFails(getDocs(collection(alice(), 'companyInvitations')));
  });

  it('can be read by platform staff for support', async () => {
    await assertSucceeds(getDoc(doc(staff(), 'companyInvitations/inv-1')));
  });

  it('cannot be written by anyone', async () => {
    for (const db of [alice(), bob(), staff()]) {
      await assertFails(setDoc(doc(db, 'companyInvitations/inv-2'), { companyId: 'c1' }));
      await assertFails(updateDoc(doc(db, 'companyInvitations/inv-1'), { status: 'ACCEPTED' }));
      await assertFails(deleteDoc(doc(db, 'companyInvitations/inv-1')));
    }
  });
});
