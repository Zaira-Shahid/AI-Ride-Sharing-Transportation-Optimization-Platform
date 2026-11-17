import type { FirestoreTimestamp } from '@ridemesh/types';

// The company (tenant) model for Product A. See docs/a1-tenancy-design.md.
// Everything here is written only by server code; clients never write these documents.

export const COMPANY_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/** What a person may do inside their company. Carried in the `companyRole` claim. */
export const COMPANY_ROLES = ['COMPANY_ADMIN', 'EMPLOYEE'] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export const MEMBER_STATUSES = ['ACTIVE', 'REMOVED'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** How long an invitation stays valid (requirement C4). */
export const INVITATION_TTL_DAYS = 7;

/** companies/{companyId} */
export interface Company {
  name: string;
  status: CompanyStatus;
  createdBy: string;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

/** companies/{companyId}/members/{uid} */
export interface CompanyMember {
  companyRole: CompanyRole;
  status: MemberStatus;
  /** The driving capability (Q1). Set only together with the driver and vehicle verification fields. */
  canDrive: boolean;
  /** The company admin who approved this member as a driver (Q5); null while canDrive is false. */
  driverReviewedBy: string | null;
  driverReviewedAt: FirestoreTimestamp | null;
  joinedAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

/** What a new member starts with, before any driver review. */
export const NEW_MEMBER_DEFAULTS = {
  status: 'ACTIVE',
  canDrive: false,
  driverReviewedBy: null,
  driverReviewedAt: null,
} as const satisfies Pick<
  CompanyMember,
  'status' | 'canDrive' | 'driverReviewedBy' | 'driverReviewedAt'
>;

/** companyInvitations/{inviteId}. Only the hash of the emailed token is ever stored. */
export interface CompanyInvitation {
  companyId: string;
  /** Lower-cased. */
  email: string;
  tokenHash: string;
  companyRole: CompanyRole;
  status: InvitationStatus;
  expiresAt: FirestoreTimestamp;
  createdBy: string;
  createdAt: FirestoreTimestamp;
}
