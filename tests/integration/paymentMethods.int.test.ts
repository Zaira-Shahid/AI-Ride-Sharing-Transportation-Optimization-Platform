import { describe, expect, it } from 'vitest';
import { savePaymentMethod } from '../../functions/src/paymentMethods';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { admin } from './support';

// Module 9.2's own payment-method prerequisite, tested directly against savePaymentMethod (not
// through the savePaymentMethod callable in index.ts) with a fake StripeProvider - the same "inject a
// stand-in for the one real call this needs" approach stripeProvider.test.ts's own unit tests use, and
// the same "call the function directly, not through a callable" pattern other TS-only modules'
// integration tests already follow (e.g. planInsertion.int.test.ts). No real Stripe account/test key
// exists yet (module 9.1's own scaffolding-only decision), so this is the only way to exercise it.

function fakeStripe(overrides: Partial<StripeProvider> = {}): StripeProvider {
  return {
    ping: async () => true,
    createCustomer: async () => 'cus_fake',
    authorizePayment: async () => ({ status: 'authorized', paymentIntentId: 'pi_fake' }),
    capturePayment: async () => ({ status: 'captured' }),
    ...overrides,
  };
}

let counter = 0;
async function activePassenger(prefix: string) {
  counter += 1;
  const uid = `${prefix}-${counter}`;
  await admin()
    .firestore.doc(`users/${uid}`)
    .set({
      role: 'PASSENGER',
      name: 'Pat',
      email: `${uid}@example.test`,
      phone: null,
      photoUrl: null,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  return uid;
}

const passengerCaller = (uid: string) => ({ uid, role: 'PASSENGER', emailVerified: true });

describe('savePaymentMethod (functions + firestore emulator, fake Stripe)', () => {
  it("creates a Stripe customer on the passenger's first save, and stores both ids", async () => {
    const uid = await activePassenger('pm-first');
    const stripe = fakeStripe({ createCustomer: async () => 'cus_new' });

    const result = await savePaymentMethod(
      { firestore: admin().firestore, stripe },
      passengerCaller(uid),
      { paymentMethodId: 'pm_abc' },
    );

    expect(result).toEqual({ status: 'saved' });
    const user = (await admin().firestore.doc(`users/${uid}`).get()).data();
    expect(user?.stripeCustomerId).toBe('cus_new');
    expect(user?.paymentMethodId).toBe('pm_abc');
  });

  it('reuses an existing Stripe customer on a later save, replacing only the payment method', async () => {
    const uid = await activePassenger('pm-repeat');
    let createCustomerCalls = 0;
    const stripe = fakeStripe({
      createCustomer: async () => {
        createCustomerCalls += 1;
        return 'cus_should_not_be_called_twice';
      },
    });
    await admin().firestore.doc(`users/${uid}`).update({ stripeCustomerId: 'cus_existing' });

    await savePaymentMethod({ firestore: admin().firestore, stripe }, passengerCaller(uid), {
      paymentMethodId: 'pm_new',
    });

    expect(createCustomerCalls).toBe(0);
    const user = (await admin().firestore.doc(`users/${uid}`).get()).data();
    expect(user?.stripeCustomerId).toBe('cus_existing');
    expect(user?.paymentMethodId).toBe('pm_new');
  });

  it('refuses an invalid payment method id and stores nothing', async () => {
    const uid = await activePassenger('pm-invalid');

    await expect(
      savePaymentMethod(
        { firestore: admin().firestore, stripe: fakeStripe() },
        passengerCaller(uid),
        { paymentMethodId: '' },
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(
      (await admin().firestore.doc(`users/${uid}`).get()).data()?.paymentMethodId,
    ).toBeUndefined();
  });

  it('refuses a caller who is not a verified passenger', async () => {
    const uid = await activePassenger('pm-wrong-role');

    await expect(
      savePaymentMethod(
        { firestore: admin().firestore, stripe: fakeStripe() },
        { uid, role: 'DRIVER', emailVerified: true },
        { paymentMethodId: 'pm_abc' },
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses a suspended account', async () => {
    const uid = await activePassenger('pm-suspended');
    await admin().firestore.doc(`users/${uid}`).update({ status: 'SUSPENDED' });

    await expect(
      savePaymentMethod(
        { firestore: admin().firestore, stripe: fakeStripe() },
        passengerCaller(uid),
        { paymentMethodId: 'pm_abc' },
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
